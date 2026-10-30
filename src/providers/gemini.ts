import {
	ChatMessage,
	countModels,
	ChatRequest,
	ConnectionStatus,
	errorFromStatus,
	FinishReason,
	JsonSchema,
	JsonSchemaProperty,
	ModelInfo,
	Provider,
	ProviderCapabilities,
	ProviderError,
	StreamEvent,
	ToolCall,
	toolCallText,
	toolResultText,
	toProviderError,
	Usage,
} from './types';
import { HttpClient, joinUrl, parseSse } from './http';
import { isGeminiChatModel } from './model-choices';

export interface GeminiConfig {
	baseUrl: string;
	/** Resolved lazily so the secret is never held on the adapter. */
	apiKey: () => string | null;
}

/**
 * Placeholder Google documents for replaying function calls that Gemini did
 * not produce (history from another provider). Gemini 3 models reject a
 * function call turn without a thought signature.
 */
const FOREIGN_SIGNATURE = 'skip_thought_signature_validator';

/**
 * Google Gemini adapter using the Gemini API (`generateContent` /
 * `streamGenerateContent?alt=sse`).
 *
 * Differences from OpenAI handled here rather than in the runtime:
 *  - the assistant role is `model` and the system prompt is
 *    `systemInstruction`;
 *  - tool results are `functionResponse` parts matched by name and order;
 *  - function calls may carry a thought signature that must be replayed;
 *  - Gemini answers `STOP` even when it calls a function, so the finish
 *    reason is derived from what was emitted;
 *  - an invalid key is HTTP 400, not 401.
 */
export class GeminiProvider implements Provider {
	readonly id = 'gemini' as const;
	readonly displayName = 'Gemini';
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
		private readonly config: () => GeminiConfig,
	) {}

	private headers(): Record<string, string> {
		const key = this.config().apiKey();
		if (!key) throw new ProviderError('auth', 'No API key configured');
		// Header, not the `?key=` query parameter, so the key never appears in a URL.
		return { 'Content-Type': 'application/json', 'x-goog-api-key': key };
	}

	async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
		const headers = this.headers();
		const res = await this.http.request({
			url: joinUrl(this.config().baseUrl, '/models?pageSize=1000'),
			method: 'GET',
			headers,
			signal,
		}).catch((e: unknown) => {
			throw toProviderError(e);
		});
		if (res.status < 200 || res.status >= 300) throw geminiError(res.status, res.text);
		const parsed = safeJson(res.text) as { models?: GeminiModel[] } | null;
		return (parsed?.models ?? [])
			.filter((m) => typeof m.name === 'string' && (m.supportedGenerationMethods ?? []).includes('generateContent'))
			.map((m) => ({ m, id: stripModelsPrefix(m.name as string) }))
			.filter(({ id }) => isGeminiChatModel(id))
			.map(({ m, id }) => {
				const info: ModelInfo = { id };
				if (m.displayName) info.label = m.displayName;
				if (typeof m.inputTokenLimit === 'number') info.contextWindow = m.inputTokenLimit;
				return info;
			});
	}

	async checkConnection(signal?: AbortSignal): Promise<ConnectionStatus> {
		try {
			const models = await this.listModels(signal);
			return { ok: true, detail: `Gemini reachable (${countModels(models.length)})` };
		} catch (e) {
			return { ok: false, error: toProviderError(e) };
		}
	}

	async *chat(request: ChatRequest): AsyncIterable<StreamEvent> {
		const headers = this.headers();
		const streaming = this.http.supportsStreaming;
		const { systemInstruction, contents } = toGeminiContents(request.messages, (request.tools?.length ?? 0) > 0);
		const body: Record<string, unknown> = { contents };
		if (systemInstruction) body['systemInstruction'] = systemInstruction;
		if (request.tools && request.tools.length > 0) {
			body['tools'] = [
				{
					functionDeclarations: request.tools.map((t) => ({
						name: t.name,
						description: t.description,
						parameters: toGeminiSchema(t.parameters),
					})),
				},
			];
		}
		if (request.temperature !== undefined) body['generationConfig'] = { temperature: request.temperature };

		const model = encodeURIComponent(stripModelsPrefix(request.model));
		const path = streaming ? `/models/${model}:streamGenerateContent?alt=sse` : `/models/${model}:generateContent`;
		let res;
		try {
			res = await this.http.stream({
				url: joinUrl(this.config().baseUrl, path),
				method: 'POST',
				headers,
				body: JSON.stringify(body),
				signal: request.signal,
			});
		} catch (e) {
			throw toProviderError(e);
		}
		if (res.status < 200 || res.status >= 300) {
			throw geminiError(res.status, await res.errorText());
		}

		const calls: ToolCall[] = [];
		const state: { usage: Usage | null; finish: FinishReason | null; rawFinish: string; text: boolean } = {
			usage: null,
			finish: null,
			rawFinish: '',
			text: false,
		};
		const handle = function* (chunk: GeminiResponse): Iterable<StreamEvent> {
			if (chunk.error) throw new ProviderError('server', chunk.error.message ?? 'unknown error');
			if (chunk.promptFeedback?.blockReason) {
				throw new ProviderError('invalid_request', `Gemini blocked the prompt (${chunk.promptFeedback.blockReason})`);
			}
			const candidate = chunk.candidates?.[0];
			for (const part of candidate?.content?.parts ?? []) {
				if (part.thought) continue;
				if (typeof part.text === 'string' && part.text.length > 0) {
					state.text = true;
					yield { type: 'text', delta: part.text };
				} else if (part.functionCall && typeof part.functionCall.name === 'string') {
					const call: ToolCall = {
						id: part.functionCall.id || `call_gemini_${Date.now().toString(36)}_${calls.length}`,
						name: part.functionCall.name,
						argumentsJson: JSON.stringify(part.functionCall.args ?? {}),
					};
					if (part.thoughtSignature) call.signature = part.thoughtSignature;
					calls.push(call);
					// Gemini sends a call whole, but the stream may go on; say so now.
					yield { type: 'tool_call_start', name: call.name };
				}
			}
			if (candidate?.finishReason) {
				state.rawFinish = candidate.finishReason;
				state.finish = mapFinish(candidate.finishReason);
			}
			// Usage is cumulative; the last chunk carries the totals.
			if (chunk.usageMetadata) state.usage = toUsage(chunk.usageMetadata);
		};

		try {
			if (streaming) {
				for await (const data of parseSse(res.chunks)) {
					const chunk = safeJson(data) as GeminiResponse | null;
					if (chunk) yield* handle(chunk);
				}
			} else {
				let text = '';
				for await (const c of res.chunks) text += c;
				const parsed = safeJson(text) as GeminiResponse | null;
				if (!parsed) throw new ProviderError('server', 'Unparseable response from provider');
				yield* handle(parsed);
			}
		} catch (e) {
			throw toProviderError(e);
		}
		if (request.signal?.aborted && state.finish === null) {
			throw new ProviderError('cancelled', 'Generation stopped.');
		}
		if (state.finish === 'other' && !state.text && calls.length === 0) {
			// SAFETY, RECITATION, MALFORMED_FUNCTION_CALL and similar: say why
			// instead of showing an empty reply.
			throw new ProviderError('invalid_request', `Gemini returned no answer (finish reason ${state.rawFinish})`);
		}
		for (const call of calls) yield { type: 'tool_call', call };
		if (state.usage) yield { type: 'usage', usage: state.usage };
		yield { type: 'done', finishReason: calls.length > 0 ? 'tool_calls' : (state.finish ?? 'other') };
	}
}

interface GeminiModel {
	name?: string;
	displayName?: string;
	inputTokenLimit?: number;
	supportedGenerationMethods?: string[];
}

interface GeminiPart {
	text?: string;
	thought?: boolean;
	thoughtSignature?: string;
	functionCall?: { id?: string; name?: string; args?: unknown };
}

interface GeminiUsage {
	promptTokenCount?: number;
	candidatesTokenCount?: number;
	thoughtsTokenCount?: number;
}

interface GeminiResponse {
	candidates?: Array<{ content?: { parts?: GeminiPart[] }; finishReason?: string }>;
	usageMetadata?: GeminiUsage;
	promptFeedback?: { blockReason?: string };
	error?: { code?: number; message?: string; status?: string };
}

/** Thinking tokens are billed as output, so they count toward output here. */
function toUsage(u: GeminiUsage): Usage {
	const usage: Usage = {};
	if (typeof u.promptTokenCount === 'number') usage.inputTokens = u.promptTokenCount;
	if (typeof u.candidatesTokenCount === 'number' || typeof u.thoughtsTokenCount === 'number') {
		usage.outputTokens = (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0);
	}
	return usage;
}

function mapFinish(reason: string): FinishReason {
	switch (reason) {
		case 'STOP':
			return 'stop';
		case 'MAX_TOKENS':
			return 'length';
		default:
			return 'other';
	}
}

/** Gemini reports a bad key as HTTP 400 INVALID_ARGUMENT; surface it as auth. */
function geminiError(status: number, bodyText: string): ProviderError {
	const err = errorFromStatus(status, bodyText);
	if (status === 400 && /API_KEY_INVALID|API key not valid/i.test(bodyText)) {
		return new ProviderError('auth', err.message, status);
	}
	return err;
}

function stripModelsPrefix(model: string): string {
	return model.replace(/^models\//, '');
}

/**
 * Gemini's `parameters` accepts an OpenAPI schema subset that rejects
 * `additionalProperties`; drop it recursively and keep everything else.
 */
export function toGeminiSchema(schema: JsonSchema | JsonSchemaProperty): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(schema)) {
		if (k === 'additionalProperties' || v === undefined) continue;
		if (k === 'properties' && v && typeof v === 'object') {
			out[k] = Object.fromEntries(
				Object.entries(v as Record<string, JsonSchemaProperty>).map(([name, prop]) => [name, toGeminiSchema(prop)]),
			);
		} else if (k === 'items' && v && typeof v === 'object') {
			out[k] = toGeminiSchema(v as JsonSchemaProperty);
		} else {
			out[k] = v;
		}
	}
	return out;
}

type GeminiOutPart = Record<string, unknown>;
interface GeminiContent {
	role: 'user' | 'model';
	parts: GeminiOutPart[];
}

/**
 * Map provider-agnostic messages to Gemini contents. System messages become
 * `systemInstruction`; tool results become `functionResponse` parts in a user
 * turn; empty text parts are dropped; adjacent same-role turns are merged.
 * Without tools, tool history is replayed as text.
 */
export function toGeminiContents(messages: ChatMessage[], withTools: boolean): {
	systemInstruction: { parts: Array<{ text: string }> } | null;
	contents: GeminiContent[];
} {
	const system: string[] = [];
	const contents: GeminiContent[] = [];
	const push = (role: GeminiContent['role'], parts: GeminiOutPart[]) => {
		if (parts.length === 0) return;
		const last = contents.at(-1);
		if (last && last.role === role) last.parts.push(...parts);
		else contents.push({ role, parts });
	};
	for (const m of messages) {
		switch (m.role) {
			case 'system':
				if (m.content) system.push(m.content);
				break;
			case 'user':
				push('user', m.content ? [{ text: m.content }] : []);
				break;
			case 'assistant': {
				const parts: GeminiOutPart[] = m.content ? [{ text: m.content }] : [];
				for (const [i, c] of (m.toolCalls ?? []).entries()) {
					if (!withTools) {
						parts.push({ text: toolCallText(c) });
						continue;
					}
					const part: GeminiOutPart = { functionCall: { name: c.name, args: parseArgs(c.argumentsJson) } };
					// Only the first call of a step carries Gemini's signature; a call
					// from another provider gets the documented placeholder instead.
					const signature = c.signature ?? (i === 0 ? FOREIGN_SIGNATURE : undefined);
					if (signature) part['thoughtSignature'] = signature;
					parts.push(part);
				}
				push('model', parts);
				break;
			}
			case 'tool':
				push('user', [withTools ? { functionResponse: { name: m.toolName ?? '', response: { result: m.content } } } : { text: toolResultText(m) }]);
				break;
		}
	}
	// Function responses must lead their turn, right after the calls they answer.
	for (const c of contents) {
		if (c.role === 'user') c.parts.sort((a, b) => Number('functionResponse' in b) - Number('functionResponse' in a));
	}
	return {
		systemInstruction: system.length > 0 ? { parts: [{ text: system.join('\n\n') }] } : null,
		contents,
	};
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
