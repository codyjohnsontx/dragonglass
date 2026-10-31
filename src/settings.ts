import { isProviderId, ProviderId } from './providers/types';

export type Transport = 'fetch' | 'requestUrl';

export interface OllamaSettings {
	baseUrl: string;
	model: string;
	/**
	 * Context window requested from Ollama (`options.num_ctx`). Ollama's own
	 * default is 4096, which one note read overflows; the server then cuts the
	 * prompt silently. Capped at what the model supports.
	 */
	numCtx: number;
	/** Let thinking models (qwen3, deepseek-r1) reason before answering. Off sends `think: false`. */
	think: boolean;
}

export interface OpenAISettings {
	/** Id of the secret in Obsidian's SecretStorage. The key itself is never stored here. */
	apiKeySecretId: string;
	model: string;
	baseUrl: string;
}

export interface AnthropicSettings {
	/** Id of the secret in Obsidian's SecretStorage. The key itself is never stored here. */
	apiKeySecretId: string;
	model: string;
	baseUrl: string;
	/** Anthropic requires an explicit output cap on every request. */
	maxTokens: number;
}

export interface GeminiSettings {
	/** Id of the secret in Obsidian's SecretStorage. The key itself is never stored here. */
	apiKeySecretId: string;
	model: string;
	baseUrl: string;
}

/** How a custom endpoint is sent its key; see `OpenAIAuth`. */
export type CustomAuth = 'bearer' | 'header' | 'none';

/** Any server speaking the OpenAI Chat Completions API (Moonshot, OpenRouter, LM Studio, vLLM, llama.cpp). */
export interface CustomSettings {
	baseUrl: string;
	model: string;
	/** Id of the secret in Obsidian's SecretStorage. The key itself is never stored here. */
	apiKeySecretId: string;
	auth: CustomAuth;
	/** Header that carries the bare key when `auth` is `header`, for example `api-key`. */
	authHeader: string;
	/** Off for servers that cannot stream; replies then arrive all at once. */
	streaming: boolean;
	/** Off for servers or models that reject or mishandle tool definitions. */
	toolCalling: boolean;
}

export interface DragonglassSettings {
	activeProvider: ProviderId;
	ollama: OllamaSettings;
	openai: OpenAISettings;
	anthropic: AnthropicSettings;
	gemini: GeminiSettings;
	custom: CustomSettings;
	/** Default toggles for new messages. */
	includeActiveNote: boolean;
	includeSelection: boolean;
	/** Whether the model may call vault tools. */
	toolsEnabled: boolean;
	maxToolIterations: number;
	maxCharsPerNote: number;
	/**
	 * Estimated tokens of full note text search_notes includes after its
	 * results (0 turns it off). Capped at a quarter of the model's context
	 * window when that is known; see `autoReadBudget`.
	 */
	autoReadTokens: number;
	/** `fetch` streams; `requestUrl` is the no-CORS, no-streaming fallback. */
	transport: Transport;
	showUsage: boolean;
	/** Warn when a single conversation exceeds this many tokens (0 disables). */
	usageWarningTokens: number;
	/** Id of the conversation open in the sidebar. */
	lastConversationId: string | null;
}

/** Smallest context Ollama is asked for; below this even the system prompt and tool schemas do not fit. */
export const MIN_NUM_CTX = 2048;

export const DEFAULT_SETTINGS: DragonglassSettings = {
	activeProvider: 'ollama',
	ollama: { baseUrl: 'http://127.0.0.1:11434', model: '', numCtx: 16_384, think: true },
	openai: { apiKeySecretId: '', model: 'gpt-6-luna', baseUrl: 'https://api.openai.com/v1' },
	anthropic: { apiKeySecretId: '', model: 'claude-sonnet-5-5', baseUrl: 'https://api.anthropic.com/v1', maxTokens: 8192 },
	gemini: { apiKeySecretId: '', model: 'gemini-3.8-flash', baseUrl: 'https://generativelanguage.googleapis.com/v1beta' },
	custom: { baseUrl: '', model: '', apiKeySecretId: '', auth: 'bearer', authHeader: '', streaming: true, toolCalling: true },
	includeActiveNote: true,
	includeSelection: true,
	toolsEnabled: true,
	maxToolIterations: 8,
	maxCharsPerNote: 20_000,
	autoReadTokens: 4000,
	transport: 'fetch',
	showUsage: true,
	usageWarningTokens: 0,
	lastConversationId: null,
};

/** Merge persisted data with defaults, ignoring unknown or mistyped fields. */
export function mergeSettings(raw: unknown): DragonglassSettings {
	const out: DragonglassSettings = structuredClone(DEFAULT_SETTINGS);
	if (!raw || typeof raw !== 'object') return out;
	const r = raw as Record<string, unknown>;
	if (isProviderId(r['activeProvider'])) out.activeProvider = r['activeProvider'];
	const ollama = r['ollama'] as Record<string, unknown> | undefined;
	if (ollama && typeof ollama === 'object') {
		if (typeof ollama['baseUrl'] === 'string') out.ollama.baseUrl = ollama['baseUrl'];
		if (typeof ollama['model'] === 'string') out.ollama.model = ollama['model'];
		const numCtx = ollama['numCtx'];
		if (typeof numCtx === 'number' && Number.isInteger(numCtx) && numCtx >= MIN_NUM_CTX) out.ollama.numCtx = numCtx;
		if (typeof ollama['think'] === 'boolean') out.ollama.think = ollama['think'];
	}
	for (const id of ['openai', 'anthropic', 'gemini', 'custom'] as const) {
		const cloud = r[id] as Record<string, unknown> | undefined;
		if (!cloud || typeof cloud !== 'object') continue;
		if (typeof cloud['apiKeySecretId'] === 'string') out[id].apiKeySecretId = cloud['apiKeySecretId'];
		if (typeof cloud['model'] === 'string') out[id].model = cloud['model'];
		if (typeof cloud['baseUrl'] === 'string') out[id].baseUrl = cloud['baseUrl'];
	}
	const anthropic = r['anthropic'] as Record<string, unknown> | undefined;
	if (anthropic && typeof anthropic === 'object') {
		const maxTokens = anthropic['maxTokens'];
		if (typeof maxTokens === 'number' && Number.isInteger(maxTokens) && maxTokens > 0) out.anthropic.maxTokens = maxTokens;
	}
	const custom = r['custom'] as Record<string, unknown> | undefined;
	if (custom && typeof custom === 'object') {
		const auth = custom['auth'];
		if (auth === 'bearer' || auth === 'header' || auth === 'none') out.custom.auth = auth;
		if (typeof custom['authHeader'] === 'string') out.custom.authHeader = custom['authHeader'];
		if (typeof custom['streaming'] === 'boolean') out.custom.streaming = custom['streaming'];
		if (typeof custom['toolCalling'] === 'boolean') out.custom.toolCalling = custom['toolCalling'];
	}
	for (const key of ['includeActiveNote', 'includeSelection', 'toolsEnabled', 'showUsage'] as const) {
		if (typeof r[key] === 'boolean') out[key] = r[key];
	}
	for (const key of ['maxToolIterations', 'maxCharsPerNote', 'usageWarningTokens', 'autoReadTokens'] as const) {
		if (typeof r[key] === 'number' && Number.isFinite(r[key])) out[key] = r[key];
	}
	if (r['transport'] === 'fetch' || r['transport'] === 'requestUrl') out.transport = r['transport'];
	if (typeof r['lastConversationId'] === 'string' || r['lastConversationId'] === null) {
		out.lastConversationId = r['lastConversationId'];
	}
	return out;
}
