/**
 * Provider-agnostic chat types. Every adapter (Ollama, OpenAI, Anthropic,
 * Gemini, and the follow-up custom OpenAI-compatible adapter) maps its wire
 * format onto these types so the agent runtime and UI never see
 * provider-specific shapes.
 */

export const PROVIDER_IDS = ['ollama', 'openai', 'anthropic', 'gemini'] as const;

export type ProviderId = (typeof PROVIDER_IDS)[number];

export function isProviderId(v: unknown): v is ProviderId {
	return typeof v === 'string' && (PROVIDER_IDS as readonly string[]).includes(v);
}

export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface ToolCall {
	/** Provider-assigned id when available, otherwise generated locally. */
	id: string;
	name: string;
	/** Raw JSON text of the arguments. Parsed and validated by the tool layer. */
	argumentsJson: string;
	/**
	 * Opaque provider state that must be echoed back with this call (Gemini
	 * thought signatures). Other providers ignore it.
	 */
	signature?: string;
}

export interface ChatMessage {
	role: Role;
	content: string;
	/** Present on assistant messages that requested tool calls. */
	toolCalls?: ToolCall[];
	/** Present on tool messages: which call this result answers. */
	toolCallId?: string;
	/** Present on tool messages: the tool name (some providers want it). */
	toolName?: string;
}

/** JSON Schema subset used for tool parameters. */
export interface JsonSchema {
	type: 'object';
	properties: Record<string, JsonSchemaProperty>;
	required?: string[];
	additionalProperties?: boolean;
}

export interface JsonSchemaProperty {
	type: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object';
	description?: string;
	enum?: string[];
	items?: JsonSchemaProperty;
	properties?: Record<string, JsonSchemaProperty>;
	required?: string[];
	minimum?: number;
	maximum?: number;
}

export interface ToolDefinition {
	name: string;
	description: string;
	parameters: JsonSchema;
}

export interface ChatRequest {
	model: string;
	messages: ChatMessage[];
	tools?: ToolDefinition[];
	signal?: AbortSignal;
	temperature?: number;
}

export interface Usage {
	inputTokens?: number;
	outputTokens?: number;
	/**
	 * Tokens the model spent on hidden reasoning. They are included in
	 * `outputTokens`. Providers that do not report the split estimate it from
	 * the streamed reasoning text (Ollama).
	 */
	reasoningTokens?: number;
}

export type FinishReason = 'stop' | 'tool_calls' | 'length' | 'other';

export type StreamEvent =
	| { type: 'text'; delta: string }
	/** Hidden reasoning from a thinking model. Shown to the user, never sent back. */
	| { type: 'thinking'; delta: string }
	| { type: 'tool_call'; call: ToolCall }
	| { type: 'usage'; usage: Usage }
	/** Something the user must know about this turn, such as a truncated prompt. */
	| { type: 'warning'; message: string }
	| { type: 'done'; finishReason: FinishReason };

/**
 * What a provider can do. Anything marked `unknown` is probed at runtime and
 * surfaced to the user as a clear error rather than assumed.
 */
export interface ProviderCapabilities {
	streaming: boolean;
	/** `unknown` means it depends on the model (Ollama). */
	toolCalling: boolean | 'unknown';
	usageReporting: boolean;
	modelDiscovery: boolean;
	/** Whether the provider is a paid cloud service billed by the user. */
	billed: boolean;
	/** Whether requests leave the local machine. */
	remote: boolean;
}

export interface ModelInfo {
	id: string;
	label?: string;
	contextWindow?: number;
}

export type ConnectionStatus =
	| { ok: true; detail: string }
	| { ok: false; error: ProviderError };

export interface Provider {
	readonly id: ProviderId;
	readonly displayName: string;
	readonly capabilities: ProviderCapabilities;
	listModels(signal?: AbortSignal): Promise<ModelInfo[]>;
	checkConnection(signal?: AbortSignal): Promise<ConnectionStatus>;
	chat(request: ChatRequest): AsyncIterable<StreamEvent>;
	/**
	 * Tokens of prompt plus reply the provider will accept for `model`, when
	 * the adapter knows it. Callers size note content to fit.
	 */
	contextWindow?(model: string, signal?: AbortSignal): Promise<number | undefined>;
}

export type ProviderErrorKind =
	| 'auth'
	| 'rate_limit'
	| 'network'
	| 'invalid_request'
	| 'unsupported_tools'
	| 'model_not_found'
	| 'server'
	| 'cancelled'
	| 'unknown';

export class ProviderError extends Error {
	readonly kind: ProviderErrorKind;
	readonly status?: number;

	constructor(kind: ProviderErrorKind, message: string, status?: number) {
		super(message);
		this.name = 'ProviderError';
		this.kind = kind;
		this.status = status;
	}

	/** Human-readable guidance shown in the chat view. */
	userMessage(): string {
		// Provider messages often end in a period; the templates add their own.
		const detail = this.message.replace(/[.\s]+$/, '');
		switch (this.kind) {
			case 'auth':
				return `Authentication failed: ${detail}. Check the API key in settings.`;
			case 'rate_limit':
				return `Rate limited by the provider: ${detail}. Wait a moment and try again.`;
			case 'network':
				return `Could not reach the provider: ${detail}. Check that the server is running and the URL is correct.`;
			case 'unsupported_tools':
				return `This model does not support tool calling: ${detail}. Choose a tool-capable model, or ask a question that needs no vault access.`;
			case 'model_not_found':
				return `Model not found: ${detail}. Pick a different model in settings.`;
			case 'invalid_request':
				return `The provider rejected the request: ${detail}`;
			case 'server':
				return `The provider returned a server error: ${detail}`;
			case 'cancelled':
				return 'Generation stopped.';
			default:
				return this.message;
		}
	}
}

/** "1 model", "3 models". */
export function countModels(n: number): string {
	return `${n} model${n === 1 ? '' : 's'}`;
}

export function isAbortError(err: unknown): boolean {
	return err instanceof Error && (err.name === 'AbortError' || err.message === 'The user aborted a request.');
}

export function toProviderError(err: unknown): ProviderError {
	if (err instanceof ProviderError) return err;
	if (isAbortError(err)) return new ProviderError('cancelled', 'Generation stopped.');
	if (err instanceof TypeError) {
		// fetch rejects with TypeError on DNS failure, refused connection, CORS block.
		return new ProviderError('network', err.message);
	}
	if (err instanceof Error) return new ProviderError('unknown', err.message);
	return new ProviderError('unknown', String(err));
}

/**
 * Rough token count of text: about four characters per token for ASCII, one
 * per character for CJK, kana and Hangul, which tokenize far more densely,
 * and two for other scripts such as Cyrillic, Greek or Arabic. Runs of
 * whitespace count once, since indentation and blank lines tokenize densely.
 */
export function estimateTokens(text: string): number {
	const compact = text.replace(/\s+/g, ' ');
	let weight = 0;
	for (let i = 0; i < compact.length; i++) weight += charWeight(compact.charCodeAt(i));
	return Math.ceil(weight / CHARS_PER_TOKEN);
}

/** Length of the longest prefix of `text` that stays within `maxTokens` at the rate `estimateTokens` uses. */
export function prefixWithinTokens(text: string, maxTokens: number): number {
	const limit = maxTokens * CHARS_PER_TOKEN;
	let weight = 0;
	for (let i = 0; i < text.length; i++) {
		weight += charWeight(text.charCodeAt(i));
		if (weight > limit) return i;
	}
	return text.length;
}

const CHARS_PER_TOKEN = 4;

/** A UTF-16 code unit's share of a token, in quarters. */
function charWeight(code: number): number {
	if (code < 0x80) return 1;
	const dense =
		(code >= 0x1100 && code <= 0x11ff) || // Hangul Jamo
		(code >= 0x2e80 && code <= 0x9fff) || // CJK radicals, punctuation, kana, ideographs
		(code >= 0xac00 && code <= 0xd7af) || // Hangul syllables
		(code >= 0xf900 && code <= 0xfaff) || // CJK compatibility ideographs
		(code >= 0xff00 && code <= 0xffef); // fullwidth forms
	return dense ? CHARS_PER_TOKEN : 2;
}

/**
 * Plain-text stand-ins for tool history, for requests that declare no tools:
 * Anthropic rejects tool blocks then, and Gemini gets the same treatment.
 */
export function toolCallText(call: ToolCall): string {
	return `[Called tool ${call.name} with ${call.argumentsJson || '{}'}]`;
}

export function toolResultText(m: ChatMessage): string {
	return `[Result of tool ${m.toolName ?? 'unknown'}]\n${m.content}`;
}

/** Map an HTTP status plus the error body to a ProviderError. */
export function errorFromStatus(status: number, bodyText: string): ProviderError {
	const detail = extractErrorMessage(bodyText);
	if (status === 401 || status === 403) return new ProviderError('auth', detail || `HTTP ${status}`, status);
	if (status === 429) return new ProviderError('rate_limit', detail || 'too many requests', status);
	if (status === 404) {
		if (/model/i.test(detail)) return new ProviderError('model_not_found', detail, status);
		return new ProviderError('invalid_request', detail || 'not found (HTTP 404)', status);
	}
	if (status >= 400 && status < 500) {
		if (/does not support tools|tool use|tools are not supported|function calling/i.test(detail)) {
			return new ProviderError('unsupported_tools', detail, status);
		}
		if (/model .* not found|no such model|model_not_found/i.test(detail)) {
			return new ProviderError('model_not_found', detail, status);
		}
		return new ProviderError('invalid_request', detail || `HTTP ${status}`, status);
	}
	if (status >= 500) return new ProviderError('server', detail || `HTTP ${status}`, status);
	return new ProviderError('unknown', detail || `HTTP ${status}`, status);
}

function extractErrorMessage(bodyText: string): string {
	const trimmed = bodyText.trim();
	if (!trimmed) return '';
	try {
		const parsed: unknown = JSON.parse(trimmed);
		if (parsed && typeof parsed === 'object') {
			const obj = parsed as Record<string, unknown>;
			const err = obj['error'];
			if (typeof err === 'string') return err;
			if (err && typeof err === 'object') {
				const msg = (err as Record<string, unknown>)['message'];
				if (typeof msg === 'string') return msg;
			}
			const msg = obj['message'];
			if (typeof msg === 'string') return msg;
		}
	} catch {
		// not JSON
	}
	return trimmed.slice(0, 300);
}
