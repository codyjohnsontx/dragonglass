import {
	ChatMessage,
	ChatRequest,
	ConnectionStatus,
	errorFromStatus,
	FinishReason,
	ModelInfo,
	Provider,
	ProviderCapabilities,
	ProviderError,
	StreamEvent,
	toProviderError,
} from './types';
import { HttpClient, joinUrl, parseSse } from './http';

export interface OpenAIConfig {
	baseUrl: string;
	/** Resolved lazily so the secret is never held on the adapter. */
	apiKey: () => string | null;
}

/**
 * OpenAI adapter using the Chat Completions API with SSE streaming. The same
 * class is the basis for the planned "custom OpenAI-compatible endpoint"
 * adapter: only `baseUrl`, the auth header and the capability flags differ.
 */
export class OpenAIProvider implements Provider {
	readonly id = 'openai' as const;
	readonly displayName = 'OpenAI';
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
		private readonly config: () => OpenAIConfig,
	) {}

	private headers(): Record<string, string> {
		const key = this.config().apiKey();
		if (!key) throw new ProviderError('auth', 'No API key configured');
		return { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` };
	}

	async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
		const headers = this.headers();
		const res = await this.http.request({
			url: joinUrl(this.config().baseUrl, '/models'),
			method: 'GET',
			headers,
			signal,
		}).catch((e: unknown) => {
			throw toProviderError(e);
		});
		if (res.status < 200 || res.status >= 300) throw errorFromStatus(res.status, res.text);
		const parsed = safeJson(res.text) as { data?: Array<{ id?: string }> } | null;
		return (parsed?.data ?? [])
			.map((m) => m.id ?? '')
			.filter((id) => id.length > 0)
			.sort()
			.map((id) => ({ id }));
	}

	async checkConnection(signal?: AbortSignal): Promise<ConnectionStatus> {
		try {
			const models = await this.listModels(signal);
			return { ok: true, detail: `OpenAI reachable (${models.length} models)` };
		} catch (e) {
			return { ok: false, error: toProviderError(e) };
		}
	}

	async *chat(request: ChatRequest): AsyncIterable<StreamEvent> {
		const headers = this.headers();
		const streaming = this.http.supportsStreaming;
		const body: Record<string, unknown> = {
			model: request.model,
			messages: request.messages.map(toOpenAIMessage),
			stream: streaming,
		};
		if (streaming) body['stream_options'] = { include_usage: true };
		if (request.tools && request.tools.length > 0) {
			body['tools'] = request.tools.map((t) => ({
				type: 'function',
				function: { name: t.name, description: t.description, parameters: t.parameters },
			}));
		}
		if (request.temperature !== undefined) body['temperature'] = request.temperature;

		let res;
		try {
			res = await this.http.stream({
				url: joinUrl(this.config().baseUrl, '/chat/completions'),
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

		const pending = new Map<number, { id: string; name: string; args: string }>();
		let finish: FinishReason | null = null;
		try {
			for await (const data of parseSse(res.chunks)) {
				if (data.trim() === '[DONE]') break;
				const chunk = safeJson(data) as OpenAIChunk | null;
				if (!chunk) continue;
				if (chunk.error) throw new ProviderError('server', chunk.error.message ?? 'unknown error');
				const choice = chunk.choices?.[0];
				if (choice?.delta) {
					const delta = choice.delta;
					if (typeof delta.content === 'string' && delta.content.length > 0) {
						yield { type: 'text', delta: delta.content };
					}
					for (const tc of delta.tool_calls ?? []) {
						const idx = typeof tc.index === 'number' ? tc.index : 0;
						const entry = pending.get(idx) ?? { id: '', name: '', args: '' };
						if (tc.id) entry.id = tc.id;
						if (tc.function?.name) entry.name += tc.function.name;
						if (tc.function?.arguments) entry.args += tc.function.arguments;
						pending.set(idx, entry);
					}
				}
				if (choice?.finish_reason) {
					finish = mapFinish(choice.finish_reason);
				}
				if (chunk.usage) {
					yield {
						type: 'usage',
						usage: { inputTokens: chunk.usage.prompt_tokens, outputTokens: chunk.usage.completion_tokens },
					};
				}
			}
		} catch (e) {
			throw toProviderError(e);
		}
		if (request.signal?.aborted && finish === null) {
			throw new ProviderError('cancelled', 'Generation stopped.');
		}
		for (const [i, entry] of [...pending.entries()].sort((a, b) => a[0] - b[0])) {
			yield {
				type: 'tool_call',
				call: {
					id: entry.id || `call_${Date.now().toString(36)}_${i}`,
					name: entry.name,
					argumentsJson: entry.args || '{}',
				},
			};
		}
		yield { type: 'done', finishReason: finish ?? (pending.size > 0 ? 'tool_calls' : 'other') };
	}

	private async *nonStreamingEvents(chunks: AsyncIterable<string>): AsyncIterable<StreamEvent> {
		let text = '';
		for await (const c of chunks) text += c;
		const parsed = safeJson(text) as OpenAICompletion | null;
		if (!parsed) throw new ProviderError('server', 'Unparseable response from provider');
		if (parsed.error) throw new ProviderError('server', parsed.error.message ?? 'unknown error');
		const choice = parsed.choices?.[0];
		const msg = choice?.message;
		if (typeof msg?.content === 'string' && msg.content.length > 0) {
			yield { type: 'text', delta: msg.content };
		}
		for (const [i, tc] of (msg?.tool_calls ?? []).entries()) {
			yield {
				type: 'tool_call',
				call: {
					id: tc.id ?? `call_${Date.now().toString(36)}_${i}`,
					name: tc.function?.name ?? '',
					argumentsJson: tc.function?.arguments ?? '{}',
				},
			};
		}
		if (parsed.usage) {
			yield {
				type: 'usage',
				usage: { inputTokens: parsed.usage.prompt_tokens, outputTokens: parsed.usage.completion_tokens },
			};
		}
		yield { type: 'done', finishReason: mapFinish(choice?.finish_reason ?? null) };
	}
}

interface OpenAIToolCallDelta {
	index?: number;
	id?: string;
	type?: string;
	function?: { name?: string; arguments?: string };
}

interface OpenAIChunk {
	choices?: Array<{
		delta?: { content?: string | null; tool_calls?: OpenAIToolCallDelta[] };
		finish_reason?: string | null;
	}>;
	usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
	error?: { message?: string };
}

interface OpenAICompletion {
	choices?: Array<{
		message?: { content?: string | null; tool_calls?: OpenAIToolCallDelta[] };
		finish_reason?: string | null;
	}>;
	usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
	error?: { message?: string };
}

function mapFinish(reason: string | null): FinishReason {
	switch (reason) {
		case 'stop':
			return 'stop';
		case 'tool_calls':
		case 'function_call':
			return 'tool_calls';
		case 'length':
			return 'length';
		default:
			return 'other';
	}
}

function toOpenAIMessage(m: ChatMessage): Record<string, unknown> {
	switch (m.role) {
		case 'assistant': {
			const out: Record<string, unknown> = { role: 'assistant', content: m.content || null };
			if (m.toolCalls && m.toolCalls.length > 0) {
				out['tool_calls'] = m.toolCalls.map((c) => ({
					id: c.id,
					type: 'function',
					function: { name: c.name, arguments: c.argumentsJson },
				}));
			}
			return out;
		}
		case 'tool':
			return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
		default:
			return { role: m.role, content: m.content };
	}
}

function safeJson(text: string): unknown {
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return null;
	}
}
