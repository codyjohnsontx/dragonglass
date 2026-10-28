import { ProviderId } from './providers/types';

export type Transport = 'fetch' | 'requestUrl';

export interface OllamaSettings {
	baseUrl: string;
	model: string;
}

export interface OpenAISettings {
	/** Id of the secret in Obsidian's SecretStorage. The key itself is never stored here. */
	apiKeySecretId: string;
	model: string;
	baseUrl: string;
}

export interface DragonglassSettings {
	activeProvider: ProviderId;
	ollama: OllamaSettings;
	openai: OpenAISettings;
	/** Default toggles for new messages. */
	includeActiveNote: boolean;
	includeSelection: boolean;
	/** Whether the model may call vault tools. */
	toolsEnabled: boolean;
	maxToolIterations: number;
	maxCharsPerNote: number;
	/** `fetch` streams; `requestUrl` is the no-CORS, no-streaming fallback. */
	transport: Transport;
	showUsage: boolean;
	/** Warn when a single conversation exceeds this many tokens (0 disables). */
	usageWarningTokens: number;
	/** Id of the conversation open in the sidebar. */
	lastConversationId: string | null;
}

export const DEFAULT_SETTINGS: DragonglassSettings = {
	activeProvider: 'ollama',
	ollama: { baseUrl: 'http://127.0.0.1:11434', model: '' },
	openai: { apiKeySecretId: '', model: 'gpt-4o-mini', baseUrl: 'https://api.openai.com/v1' },
	includeActiveNote: true,
	includeSelection: true,
	toolsEnabled: true,
	maxToolIterations: 8,
	maxCharsPerNote: 20_000,
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
	if (r['activeProvider'] === 'ollama' || r['activeProvider'] === 'openai') out.activeProvider = r['activeProvider'];
	const ollama = r['ollama'] as Record<string, unknown> | undefined;
	if (ollama && typeof ollama === 'object') {
		if (typeof ollama['baseUrl'] === 'string') out.ollama.baseUrl = ollama['baseUrl'];
		if (typeof ollama['model'] === 'string') out.ollama.model = ollama['model'];
	}
	const openai = r['openai'] as Record<string, unknown> | undefined;
	if (openai && typeof openai === 'object') {
		if (typeof openai['apiKeySecretId'] === 'string') out.openai.apiKeySecretId = openai['apiKeySecretId'];
		if (typeof openai['model'] === 'string') out.openai.model = openai['model'];
		if (typeof openai['baseUrl'] === 'string') out.openai.baseUrl = openai['baseUrl'];
	}
	for (const key of ['includeActiveNote', 'includeSelection', 'toolsEnabled', 'showUsage'] as const) {
		if (typeof r[key] === 'boolean') out[key] = r[key];
	}
	for (const key of ['maxToolIterations', 'maxCharsPerNote', 'usageWarningTokens'] as const) {
		if (typeof r[key] === 'number' && Number.isFinite(r[key])) out[key] = r[key];
	}
	if (r['transport'] === 'fetch' || r['transport'] === 'requestUrl') out.transport = r['transport'];
	if (typeof r['lastConversationId'] === 'string' || r['lastConversationId'] === null) {
		out.lastConversationId = r['lastConversationId'];
	}
	return out;
}
