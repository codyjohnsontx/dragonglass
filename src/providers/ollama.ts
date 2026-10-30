import {
	ChatMessage,
	ChatRequest,
	ConnectionStatus,
	errorFromStatus,
	estimateTokens,
	estimateTokensCeiling,
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
	/** The model the user picked, or empty. The connection check confirms it is installed. */
	model: string;
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
 * 4096-token default, and a prompt that does not fit is cut silently in one
 * of two ways: older messages are dropped until the rest fits (a tool result
 * or the whole history vanishes), and a single message still too large is
 * truncated to about half the window (the system prompt, tools and question
 * go with it). Neither is reported. The adapter therefore compares the
 * reported `prompt_eval_count` with an estimate of what it sent and emits a
 * `warning` event when the numbers say the prompt was cut anyway.
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
			const version = parsed?.version ? `Ollama ${parsed.version}` : 'Ollama reachable';
			// A reachable server with a model that is not pulled fails on the
			// first chat, so check the model here where the user is looking.
			const model = this.config().model;
			const models = await this.listModels(signal);
			if (!model) return { ok: true, detail: version, models };
			const installed = models.map((m) => m.id);
			if (!installed.some((id) => id === model || id === `${model}:latest`)) {
				const shown = installed.slice(0, 5).join(', ') + (installed.length > 5 ? ', …' : '');
				return {
					ok: false,
					error: new ProviderError('model_not_found', `"${model}" is not installed on this server (installed: ${shown || 'none'})`),
					models,
				};
			}
			return { ok: true, detail: `${version}, model ${model} installed`, models };
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
		const promptCeiling = estimatePromptTokens(request.messages, request.tools, estimateTokensCeiling);

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
						contentChars += tc.name.length + tc.argumentsJson.length; // answer tokens, not thinking
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
					if (promptTokens !== undefined && promptWasTruncated(promptTokens, promptEstimate, numCtx, promptCeiling)) {
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
 * Rough token count of a request plus a few tokens of framing per message,
 * at the rate of `estimate` (`estimateTokens` by default, or
 * `estimateTokensCeiling` for the most any tokenizer would spend). Only used
 * to spot a prompt that came back much smaller than it went out.
 */
export function estimatePromptTokens(
	messages: ChatMessage[],
	tools: ToolDefinition[] | undefined,
	estimate: (text: string) => number = estimateTokens,
): number {
	let tokens = messages.length * 4;
	for (const m of messages) {
		tokens += estimate(m.content);
		for (const c of m.toolCalls ?? []) tokens += estimate(c.name + c.argumentsJson);
	}
	if (tools) tokens += estimate(JSON.stringify(tools));
	return tokens;
}

/**
 * Was the prompt cut? Ollama cuts in two ways, with different signatures.
 *
 * A single message too large for the window is cut by the runner, which
 * keeps exactly half the window plus two tokens (measured on Ollama 0.40 at
 * 2048, 4096, 8192 and 16384). A count in that narrow band is a cut whenever
 * `ceiling`, the most tokens any tokenizer would spend on the prompt, reaches
 * the window; this does not depend on the estimate being right, which matters
 * for notes in Chinese, Japanese or Korean, where tokenizers differ by a
 * factor of three and an uncut prompt lands in the band about once in a
 * thousand requests. An ASCII prompt the estimate puts well under the window
 * is left alone: its ceiling is its estimate.
 *
 * A history too long for the window has its older messages dropped by the
 * server until the rest fits. That leaves no signature, so it shows only as a
 * count well under the estimate (a 40 percent shortfall, far more than the
 * estimate's error on prose) for a prompt the estimate says could not have
 * fit, or a count around half the window for a runner cut on an older Ollama.
 * The shortfall alone is not enough: dense text such as tables or code can
 * tokenize well under four characters per token.
 */
export function promptWasTruncated(promptTokens: number, estimate: number, numCtx: number, ceiling = estimate): boolean {
	const half = Math.floor(numCtx / 2);
	if (promptTokens >= half && promptTokens <= half + RUNNER_CUT_SLACK && ceiling >= numCtx) return true;
	if (promptTokens >= estimate * 0.6) return false;
	const couldNotFit = estimate >= numCtx;
	const nearHalfWindow = promptTokens >= numCtx * 0.3 && promptTokens <= numCtx * 0.6;
	return couldNotFit || nearHalfWindow;
}

/** Tokens above half the window a runner cut may leave; two were measured, the rest is headroom for other versions. */
const RUNNER_CUT_SLACK = 16;

function truncationWarning(promptTokens: number, estimate: number, numCtx: number): string {
	const window = numCtx.toLocaleString('en-US');
	const reached = promptTokens.toLocaleString('en-US');
	const counts =
		estimate > promptTokens
			? `about ${estimate.toLocaleString('en-US')} tokens were sent and ${reached} reached the model`
			: `${reached} tokens reached the model, exactly the half window Ollama keeps after cutting a message that is too long`;
	return (
		`This prompt did not fit Ollama's ${window}-token context window: ${counts}. ` +
		'Ollama silently drops older messages and cuts long ones, so the reply may ignore earlier turns, note content or your question. ' +
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
