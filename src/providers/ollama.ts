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
	ToolDefinition,
	toProviderError,
} from './types';
import { HttpClient, joinUrl, parseNdjson } from './http';

export interface OllamaConfig {
	baseUrl: string;
	/** Requested context window in tokens (`options.num_ctx`), capped at the model's maximum. */
	numCtx: number;
	/** When false, thinking models are asked to answer directly (`think: false`). */
	think: boolean;
}

/** What `/api/show` tells us about a model. */
export interface OllamaModelInfo {
	/** Largest context the model was trained for, when the metadata says. */
	contextLength?: number;
	/** `completion`, `tools`, `thinking`, ... */
	capabilities: string[];
}

/**
 * Ollama adapter. Speaks the native Ollama HTTP API (`/api/chat`, `/api/tags`,
 * `/api/show`, `/api/version`). Streams newline-delimited JSON. Tool calling
 * depends on the model; Ollama answers HTTP 400 for models without tool
 * support and that is surfaced as `unsupported_tools`.
 *
 * Every chat request carries `options.num_ctx`. Without it Ollama runs at its
 * 4096-token default and, when a prompt does not fit, silently keeps about
 * half of it: the system prompt, the tools and the user's question are gone
 * and the model answers nonsense. The adapter also compares the reported
 * `prompt_eval_count` with an estimate of what it sent and emits a `warning`
 * event when the numbers say the prompt was cut anyway.
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

	private readonly modelInfo = new Map<string, Promise<OllamaModelInfo | undefined>>();

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

	/**
	 * Model metadata from `/api/show`, cached per model and base URL. Resolves
	 * to undefined when the server cannot answer so chat still goes ahead with
	 * the configured context size.
	 */
	describeModel(model: string, signal?: AbortSignal): Promise<OllamaModelInfo | undefined> {
		const key = `${this.config().baseUrl}\n${model}`;
		const cached = this.modelInfo.get(key);
		if (cached) return cached;
		const pending = this.fetchModelInfo(model, signal).catch(() => undefined);
		this.modelInfo.set(key, pending);
		void pending.then((info) => {
			if (!info) this.modelInfo.delete(key); // try again next time
		});
		return pending;
	}

	private async fetchModelInfo(model: string, signal?: AbortSignal): Promise<OllamaModelInfo | undefined> {
		const res = await this.http.request({
			url: joinUrl(this.config().baseUrl, '/api/show'),
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ model }),
			signal,
		});
		if (res.status < 200 || res.status >= 300) return undefined;
		const parsed = safeJson(res.text) as { model_info?: Record<string, unknown>; capabilities?: unknown } | null;
		if (!parsed) return undefined;
		let contextLength: number | undefined;
		for (const [k, v] of Object.entries(parsed.model_info ?? {})) {
			if (k.endsWith('.context_length') && typeof v === 'number' && v > 0) contextLength = v;
		}
		const capabilities = Array.isArray(parsed.capabilities) ? parsed.capabilities.filter((c): c is string => typeof c === 'string') : [];
		return { contextLength, capabilities };
	}

	/** The `num_ctx` actually sent: the setting, never above what the model supports. */
	async contextWindow(model: string, signal?: AbortSignal): Promise<number> {
		const info = await this.describeModel(model, signal);
		return effectiveNumCtx(this.config().numCtx, info);
	}

	async *chat(request: ChatRequest): AsyncIterable<StreamEvent> {
		const config = this.config();
		const info = await this.describeModel(request.model, request.signal);
		const numCtx = effectiveNumCtx(config.numCtx, info);
		const options: Record<string, unknown> = { num_ctx: numCtx };
		if (request.temperature !== undefined) options['temperature'] = request.temperature;
		const body: Record<string, unknown> = {
			model: request.model,
			messages: request.messages.map(toOllamaMessage),
			stream: this.http.supportsStreaming,
			options,
		};
		if (request.tools && request.tools.length > 0) {
			body['tools'] = request.tools.map((t) => ({
				type: 'function',
				function: { name: t.name, description: t.description, parameters: t.parameters },
			}));
		}
		// Ollama rejects `think: true` for models without the capability but
		// accepts `think: false` for any model, so only the opt-out is sent.
		if (!config.think && (!info || info.capabilities.includes('thinking'))) body['think'] = false;
		const promptEstimate = estimatePromptTokens(request.messages, request.tools);

		let res;
		try {
			res = await this.http.stream({
				url: joinUrl(config.baseUrl, '/api/chat'),
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
		let thinkingChars = 0;
		let contentChars = 0;
		try {
			for await (const raw of parseNdjson(res.chunks)) {
				const chunk = raw as OllamaChunk;
				if (chunk.error) throw new ProviderError('server', chunk.error);
				const thinking = chunk.message?.thinking;
				if (typeof thinking === 'string' && thinking.length > 0) {
					thinkingChars += thinking.length;
					yield { type: 'thinking', delta: thinking };
				}
				const content = chunk.message?.content;
				if (typeof content === 'string' && content.length > 0) {
					contentChars += content.length;
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
					const promptTokens = typeof chunk.prompt_eval_count === 'number' ? chunk.prompt_eval_count : undefined;
					const outputTokens = typeof chunk.eval_count === 'number' ? chunk.eval_count : undefined;
					if (promptTokens !== undefined || outputTokens !== undefined) {
						yield {
							type: 'usage',
							usage: {
								inputTokens: promptTokens,
								outputTokens,
								reasoningTokens: splitReasoningTokens(outputTokens, thinkingChars, contentChars),
							},
						};
					}
					if (promptTokens !== undefined && promptWasTruncated(promptTokens, promptEstimate, numCtx)) {
						yield { type: 'warning', message: truncationWarning(promptTokens, promptEstimate, numCtx) };
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
		thinking?: string;
		tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: unknown } }>;
	};
	done?: boolean;
	done_reason?: string;
	prompt_eval_count?: number;
	eval_count?: number;
	error?: string;
}

/** Ollama refuses tiny windows and the model cannot use more than it was trained for. */
export function effectiveNumCtx(requested: number, info: OllamaModelInfo | undefined): number {
	const floor = Math.max(1024, Math.floor(requested));
	return info?.contextLength ? Math.min(floor, info.contextLength) : floor;
}

/**
 * Rough token count of a request: about four characters per token for prose
 * plus a few tokens of framing per message. Only used to spot a prompt that
 * came back much smaller than it went out.
 */
export function estimatePromptTokens(messages: ChatMessage[], tools: ToolDefinition[] | undefined): number {
	let chars = 0;
	for (const m of messages) {
		chars += m.content.length;
		for (const c of m.toolCalls ?? []) chars += c.name.length + c.argumentsJson.length;
	}
	if (tools) chars += JSON.stringify(tools).length;
	return Math.ceil(chars / 4) + messages.length * 4;
}

/**
 * When a prompt is at least `num_ctx` tokens Ollama keeps roughly half of it
 * and reports that half as `prompt_eval_count`. So a count sitting around
 * half the window while the estimate says far more was sent means the prompt
 * was cut. Both conditions are required: a count far below the estimate on
 * its own also happens with whitespace-heavy text, which tokenizes densely.
 */
export function promptWasTruncated(promptTokens: number, estimate: number, numCtx: number): boolean {
	const nearHalfWindow = promptTokens >= numCtx * 0.3 && promptTokens <= numCtx * 0.6;
	return nearHalfWindow && promptTokens < estimate * 0.6;
}

function truncationWarning(promptTokens: number, estimate: number, numCtx: number): string {
	return (
		`Ollama cut this prompt to fit its ${numCtx.toLocaleString()}-token context window: about ${estimate.toLocaleString()} tokens were sent and ${promptTokens.toLocaleString()} reached the model, ` +
		'so it did not see the whole conversation, likely not the system prompt or your question. ' +
		'Raise "Context window" in the Ollama settings, attach less, or start a new conversation.'
	);
}

/**
 * Ollama counts thinking tokens inside `eval_count`. Split that total in
 * proportion to the characters seen in each stream so the usage line can say
 * how much of the output was reasoning. An estimate, labelled as such in the UI.
 */
export function splitReasoningTokens(outputTokens: number | undefined, thinkingChars: number, contentChars: number): number | undefined {
	if (outputTokens === undefined || thinkingChars === 0) return undefined;
	const total = thinkingChars + contentChars;
	return Math.min(outputTokens, Math.round((outputTokens * thinkingChars) / total));
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
