import {
	ChatMessage,
	ChatRequest,
	ConnectionStatus,
	errorFromStatus,
	ModelInfo,
	Provider,
	ProviderCapabilities,
	ProviderError,
	StreamEvent,
	ToolCall,
	toProviderError,
} from './types';
import { HttpClient, joinUrl, parseNdjson } from './http';

export interface OllamaConfig {
	baseUrl: string;
}

/**
 * Ollama adapter. Speaks the native Ollama HTTP API (`/api/chat`, `/api/tags`,
 * `/api/version`). Streams newline-delimited JSON. Tool calling depends on the
 * model; Ollama answers HTTP 400 for models without tool support and that is
 * surfaced as `unsupported_tools`.
 */
export class OllamaProvider implements Provider {
	readonly id = 'ollama' as const;
	readonly displayName = 'Ollama';
	readonly capabilities: ProviderCapabilities = {
		streaming: true,
		toolCalling: 'unknown',
		usageReporting: true,
		modelDiscovery: true,
		billed: false,
		remote: false,
	};

	constructor(
		private readonly http: HttpClient,
		private readonly config: () => OllamaConfig,
	) {}

	async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
		const res = await this.http.request({
			url: joinUrl(this.config().baseUrl, '/api/tags'),
			method: 'GET',
			signal,
		}).catch((e: unknown) => {
			throw toProviderError(e);
		});
		if (res.status < 200 || res.status >= 300) throw errorFromStatus(res.status, res.text);
		const parsed = safeJson(res.text) as { models?: Array<{ name?: string; model?: string }> } | null;
		const models = parsed?.models ?? [];
		return models
			.map((m) => m.name ?? m.model ?? '')
			.filter((name) => name.length > 0)
			.map((id) => ({ id }));
	}

	async checkConnection(signal?: AbortSignal): Promise<ConnectionStatus> {
		try {
			const res = await this.http.request({
				url: joinUrl(this.config().baseUrl, '/api/version'),
				method: 'GET',
				signal,
			});
			if (res.status < 200 || res.status >= 300) {
				return { ok: false, error: errorFromStatus(res.status, res.text) };
			}
			const parsed = safeJson(res.text) as { version?: string } | null;
			return { ok: true, detail: parsed?.version ? `Ollama ${parsed.version}` : 'Ollama reachable' };
		} catch (e) {
			return { ok: false, error: toProviderError(e) };
		}
	}

	async *chat(request: ChatRequest): AsyncIterable<StreamEvent> {
		const body: Record<string, unknown> = {
			model: request.model,
			messages: request.messages.map(toOllamaMessage),
			stream: this.http.supportsStreaming,
		};
		if (request.tools && request.tools.length > 0) {
			body['tools'] = request.tools.map((t) => ({
				type: 'function',
				function: { name: t.name, description: t.description, parameters: t.parameters },
			}));
		}
		if (request.temperature !== undefined) body['options'] = { temperature: request.temperature };

		let res;
		try {
			res = await this.http.stream({
				url: joinUrl(this.config().baseUrl, '/api/chat'),
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body),
				signal: request.signal,
			});
		} catch (e) {
			throw toProviderError(e);
		}
		if (res.status < 200 || res.status >= 300) {
			throw errorFromStatus(res.status, await res.errorText());
		}

		let sawToolCall = false;
		let finished = false;
		try {
			for await (const raw of parseNdjson(res.chunks)) {
				const chunk = raw as OllamaChunk;
				if (chunk.error) throw new ProviderError('server', chunk.error);
				const content = chunk.message?.content;
				if (typeof content === 'string' && content.length > 0) {
					yield { type: 'text', delta: content };
				}
				const calls = chunk.message?.tool_calls;
				if (Array.isArray(calls)) {
					for (const [i, call] of calls.entries()) {
						const fn = call.function;
						if (!fn || typeof fn.name !== 'string') continue;
						sawToolCall = true;
						const tc: ToolCall = {
							id: typeof call.id === 'string' && call.id ? call.id : `call_${Date.now().toString(36)}_${i}`,
							name: fn.name,
							argumentsJson: typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments ?? {}),
						};
						yield { type: 'tool_call', call: tc };
					}
				}
				if (chunk.done) {
					finished = true;
					if (typeof chunk.prompt_eval_count === 'number' || typeof chunk.eval_count === 'number') {
						yield {
							type: 'usage',
							usage: { inputTokens: chunk.prompt_eval_count, outputTokens: chunk.eval_count },
						};
					}
					const reason = chunk.done_reason;
					yield {
						type: 'done',
						finishReason: sawToolCall ? 'tool_calls' : reason === 'length' ? 'length' : 'stop',
					};
				}
			}
		} catch (e) {
			throw toProviderError(e);
		}
		if (!finished) {
			if (request.signal?.aborted) throw new ProviderError('cancelled', 'Generation stopped.');
			yield { type: 'done', finishReason: sawToolCall ? 'tool_calls' : 'other' };
		}
	}
}

interface OllamaChunk {
	message?: {
		role?: string;
		content?: string;
		tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: unknown } }>;
	};
	done?: boolean;
	done_reason?: string;
	prompt_eval_count?: number;
	eval_count?: number;
	error?: string;
}

function toOllamaMessage(m: ChatMessage): Record<string, unknown> {
	switch (m.role) {
		case 'assistant': {
			const out: Record<string, unknown> = { role: 'assistant', content: m.content };
			if (m.toolCalls && m.toolCalls.length > 0) {
				out['tool_calls'] = m.toolCalls.map((c) => ({
					function: { name: c.name, arguments: parseArgs(c.argumentsJson) },
				}));
			}
			return out;
		}
		case 'tool':
			return { role: 'tool', content: m.content, tool_name: m.toolName };
		default:
			return { role: m.role, content: m.content };
	}
}

function parseArgs(json: string): unknown {
	try {
		return JSON.parse(json) as unknown;
	} catch {
		return {};
	}
}

function safeJson(text: string): unknown {
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return null;
	}
}
