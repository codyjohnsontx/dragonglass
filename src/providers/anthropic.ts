import {
	ChatMessage,
	countModels,
	ChatRequest,
	ConnectionStatus,
	errorFromStatus,
	FinishReason,
	ModelInfo,
	Provider,
	ProviderCapabilities,
	ProviderError,
	ProviderErrorKind,
	StreamEvent,
	ToolCall,
	toolCallText,
	toolResultText,
	toProviderError,
	Usage,
} from './types';
import { HttpClient, joinUrl, parseSse } from './http';

export interface AnthropicConfig {
	baseUrl: string;
	/** Resolved lazily so the secret is never held on the adapter. */
	apiKey: () => string | null;
	/** Required by the Messages API on every request. */
	maxTokens: number;
}

const API_VERSION = '2023-06-01';

/**
 * Anthropic adapter using the Messages API with SSE streaming.
 *
 * Differences from OpenAI handled here rather than in the runtime:
 *  - the system prompt is a top-level field, not a message;
 *  - roles must alternate user/assistant, so tool results become
 *    `tool_result` blocks in a user turn and adjacent same-role turns merge;
 *  - `max_tokens` is mandatory;
 *  - input tokens arrive at `message_start`, output tokens at `message_delta`.
 */
export class AnthropicProvider implements Provider {
	readonly id = 'anthropic' as const;
	readonly displayName = 'Anthropic';
	readonly capabilities: ProviderCapabilities = {
		streaming: true,
		toolCalling: true,
		usageReporting: true,
		modelDiscovery: true,
		billed: true,
		remote: true,
	};

	constructor(
		private readonly http: HttpClient,
		private readonly config: () => AnthropicConfig,
	) {}

	private headers(): Record<string, string> {
		const key = this.config().apiKey();
		if (!key) throw new ProviderError('auth', 'No API key configured');
		return {
			'Content-Type': 'application/json',
			'x-api-key': key,
			'anthropic-version': API_VERSION,
			// Obsidian's renderer is a browser origin; Anthropic requires this
			// opt-in for CORS. The key is the user's own and stays on this machine.
			'anthropic-dangerous-direct-browser-access': 'true',
		};
	}

	async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
		const headers = this.headers();
		const res = await this.http.request({
			url: joinUrl(this.config().baseUrl, '/models?limit=1000'),
			method: 'GET',
			headers,
			signal,
		}).catch((e: unknown) => {
			throw toProviderError(e);
		});
		if (res.status < 200 || res.status >= 300) throw errorFromStatus(res.status, res.text);
		const parsed = safeJson(res.text) as { data?: Array<{ id?: string; display_name?: string; max_input_tokens?: number }> } | null;
		return (parsed?.data ?? [])
			.filter((m) => typeof m.id === 'string' && m.id.length > 0)
			.map((m) => {
				const info: ModelInfo = { id: m.id as string };
				if (m.display_name) info.label = m.display_name;
				if (typeof m.max_input_tokens === 'number') info.contextWindow = m.max_input_tokens;
				return info;
			});
	}

	async checkConnection(signal?: AbortSignal): Promise<ConnectionStatus> {
		try {
			const models = await this.listModels(signal);
			return { ok: true, detail: `Anthropic reachable (${countModels(models.length)})`, models };
		} catch (e) {
			return { ok: false, error: toProviderError(e) };
		}
	}

	async *chat(request: ChatRequest): AsyncIterable<StreamEvent> {
		const headers = this.headers();
		const streaming = this.http.supportsStreaming;
		const { system, messages } = toAnthropicMessages(request.messages, (request.tools?.length ?? 0) > 0);
		const body: Record<string, unknown> = {
			model: request.model,
			max_tokens: this.config().maxTokens,
			messages,
			stream: streaming,
		};
		if (system) body['system'] = system;
		if (request.tools && request.tools.length > 0) {
			body['tools'] = request.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
		}
		if (request.temperature !== undefined) body['temperature'] = request.temperature;

		let res;
		try {
			res = await this.http.stream({
				url: joinUrl(this.config().baseUrl, '/messages'),
				method: 'POST',
				headers,
				body: JSON.stringify(body),
				signal: request.signal,
			});
		} catch (e) {
			throw toProviderError(e);
		}
		if (res.status < 200 || res.status >= 300) {
			throw errorFromStatus(res.status, await res.errorText());
		}

		if (!streaming) {
			yield* this.nonStreamingEvents(res.chunks);
			return;
		}

		const blocks = new Map<number, { id: string; name: string; json: string }>();
		const usage: Usage = {};
		let finish: FinishReason | null = null;
		try {
			for await (const data of parseSse(res.chunks)) {
				const ev = safeJson(data) as AnthropicStreamEvent | null;
				if (!ev) continue;
				switch (ev.type) {
					case 'message_start':
						if (ev.message?.usage) mergeUsage(usage, ev.message.usage);
						break;
					case 'content_block_start':
						if (ev.content_block?.type === 'tool_use' && typeof ev.index === 'number') {
							const name = ev.content_block.name ?? '';
							blocks.set(ev.index, { id: ev.content_block.id ?? '', name, json: '' });
							yield { type: 'tool_call_start', name };
						}
						break;
					case 'content_block_delta': {
						const d = ev.delta;
						if (d?.type === 'text_delta' && typeof d.text === 'string' && d.text.length > 0) {
							yield { type: 'text', delta: d.text };
						} else if (d?.type === 'input_json_delta' && typeof ev.index === 'number') {
							const block = blocks.get(ev.index);
							if (block && typeof d.partial_json === 'string') block.json += d.partial_json;
						}
						break;
					}
					case 'message_delta':
						if (ev.delta?.stop_reason) finish = mapStop(ev.delta.stop_reason);
						if (ev.usage) mergeUsage(usage, ev.usage);
						break;
					case 'error':
						throw streamError(ev.error);
					default:
						break; // ping, content_block_stop, message_stop
				}
			}
		} catch (e) {
			throw toProviderError(e);
		}
		if (request.signal?.aborted && finish === null) {
			throw new ProviderError('cancelled', 'Generation stopped.');
		}
		const sorted = [...blocks.entries()].sort((a, b) => a[0] - b[0]);
		for (const [i, block] of sorted) {
			yield { type: 'tool_call', call: { id: block.id || localId(i), name: block.name, argumentsJson: block.json || '{}' } };
		}
		if (usage.inputTokens !== undefined || usage.outputTokens !== undefined) yield { type: 'usage', usage };
		yield { type: 'done', finishReason: finish ?? (blocks.size > 0 ? 'tool_calls' : 'other') };
	}

	private async *nonStreamingEvents(chunks: AsyncIterable<string>): AsyncIterable<StreamEvent> {
		let text = '';
		for await (const c of chunks) text += c;
		const parsed = safeJson(text) as AnthropicMessage | null;
		if (!parsed) throw new ProviderError('server', 'Unparseable response from provider');
		if (parsed.type === 'error') throw streamError(parsed.error);
		const calls: ToolCall[] = [];
		for (const [i, block] of (parsed.content ?? []).entries()) {
			if (block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
				yield { type: 'text', delta: block.text };
			} else if (block.type === 'tool_use') {
				calls.push({ id: block.id || localId(i), name: block.name ?? '', argumentsJson: JSON.stringify(block.input ?? {}) });
			}
		}
		for (const call of calls) yield { type: 'tool_call', call };
		if (parsed.usage) {
			const usage: Usage = {};
			mergeUsage(usage, parsed.usage);
			yield { type: 'usage', usage };
		}
		yield { type: 'done', finishReason: mapStop(parsed.stop_reason ?? null) };
	}
}

interface AnthropicUsage {
	input_tokens?: number;
	output_tokens?: number;
	cache_creation_input_tokens?: number;
	cache_read_input_tokens?: number;
}

interface AnthropicContentBlock {
	type?: string;
	text?: string;
	id?: string;
	name?: string;
	input?: unknown;
}

interface AnthropicStreamEvent {
	type?: string;
	index?: number;
	message?: { usage?: AnthropicUsage };
	content_block?: AnthropicContentBlock;
	delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: string | null };
	usage?: AnthropicUsage;
	error?: { type?: string; message?: string };
}

interface AnthropicMessage {
	type?: string;
	content?: AnthropicContentBlock[];
	stop_reason?: string | null;
	usage?: AnthropicUsage;
	error?: { type?: string; message?: string };
}

/** Input tokens include cache reads and writes so counts match what is billed. */
function mergeUsage(into: Usage, u: AnthropicUsage): void {
	if (typeof u.input_tokens === 'number') {
		into.inputTokens = u.input_tokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
	}
	if (typeof u.output_tokens === 'number') into.outputTokens = u.output_tokens;
}

function mapStop(reason: string | null): FinishReason {
	switch (reason) {
		case 'end_turn':
		case 'stop_sequence':
			return 'stop';
		case 'tool_use':
			return 'tool_calls';
		case 'max_tokens':
			return 'length';
		default:
			return 'other';
	}
}

function streamError(err: { type?: string; message?: string } | undefined): ProviderError {
	const message = err?.message ?? 'unknown error';
	const kinds: Record<string, ProviderErrorKind> = {
		authentication_error: 'auth',
		permission_error: 'auth',
		rate_limit_error: 'rate_limit',
		invalid_request_error: 'invalid_request',
		not_found_error: 'model_not_found',
	};
	return new ProviderError(kinds[err?.type ?? ''] ?? 'server', message);
}

type AnthropicBlock = Record<string, unknown>;
interface AnthropicTurn {
	role: 'user' | 'assistant';
	content: AnthropicBlock[];
}

/**
 * Map provider-agnostic messages to Anthropic turns. System messages are
 * lifted out; tool results join the following user turn; blank text blocks
 * (which the API rejects) are dropped; adjacent same-role turns are merged.
 * Without tools, tool history is replayed as text because the API rejects
 * tool blocks in a request that declares no tools.
 */
export function toAnthropicMessages(messages: ChatMessage[], withTools: boolean): { system: string; messages: AnthropicTurn[] } {
	const system: string[] = [];
	const turns: AnthropicTurn[] = [];
	const push = (role: AnthropicTurn['role'], blocks: AnthropicBlock[]) => {
		if (blocks.length === 0) return;
		const last = turns.at(-1);
		if (last && last.role === role) last.content.push(...blocks);
		else turns.push({ role, content: blocks });
	};
	const text = (s: string): AnthropicBlock[] => (s.trim() ? [{ type: 'text', text: s }] : []);
	for (const m of messages) {
		switch (m.role) {
			case 'system':
				if (m.content) system.push(m.content);
				break;
			case 'user':
				push('user', text(m.content));
				break;
			case 'assistant': {
				const blocks = text(m.content);
				for (const c of m.toolCalls ?? []) {
					if (withTools) blocks.push({ type: 'tool_use', id: toolUseId(c.id), name: c.name, input: parseArgs(c.argumentsJson) });
					else blocks.push(...text(toolCallText(c)));
				}
				push('assistant', blocks);
				break;
			}
			case 'tool':
				if (withTools) push('user', [{ type: 'tool_result', tool_use_id: toolUseId(m.toolCallId ?? ''), content: m.content }]);
				else push('user', text(toolResultText(m)));
				break;
		}
	}
	// A tool_result must come first in its user turn; move any text after it.
	for (const t of turns) {
		if (t.role === 'user') t.content.sort((a, b) => Number(b['type'] === 'tool_result') - Number(a['type'] === 'tool_result'));
	}
	return { system: system.join('\n\n'), messages: turns };
}

/**
 * Anthropic only accepts `[A-Za-z0-9_-]` ids. Calls made by another provider
 * earlier in the conversation may not conform; map both sides the same way.
 */
function toolUseId(id: string): string {
	return id.replace(/[^A-Za-z0-9_-]/g, '_') || 'toolu_missing';
}

function localId(i: number): string {
	return `toolu_local_${Date.now().toString(36)}_${i}`;
}

function parseArgs(json: string): unknown {
	const parsed = safeJson(json);
	return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
}

function safeJson(text: string): unknown {
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return null;
	}
}
