import { ModelInfo, Provider, ProviderError, ProviderId, toProviderError } from './types';

/**
 * Current chat models offered when the provider cannot list its own: no key
 * yet, a bad key, or the list request failing. Ids are taken from each
 * provider's model docs; update them when a provider retires one.
 */
export const SUGGESTED_MODELS: Partial<Record<ProviderId, readonly ModelInfo[]>> = {
	// https://developers.openai.com/api/docs/models
	openai: [
		{ id: 'gpt-6-astra', label: 'GPT-6 Astra' },
		{ id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol' },
		{ id: 'gpt-6.1-terra', label: 'GPT-6.1 Terra' },
		{ id: 'gpt-6-luna', label: 'GPT-6 Luna' },
	],
	// https://platform.claude.com/docs/en/about-claude/models/overview
	anthropic: [
		{ id: 'claude-fable-5-1', label: 'Claude Fable 5.1' },
		{ id: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
		{ id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
		{ id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5' },
	],
	// https://ai.google.dev/gemini-api/docs/models
	gemini: [
		{ id: 'gemini-4-argon', label: 'Gemini 4 Argon' },
		{ id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash' },
		{ id: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash' },
		{ id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash-Lite' },
	],
};

/**
 * OpenAI's /models also lists embedding, speech, image, moderation, legacy
 * completion and Responses-only models, none of which answer a chat.
 */
const OPENAI_NON_CHAT = /embedding|whisper|tts|dall-e|image|transcribe|realtime|audio|moderation|^babbage|^davinci|sora|search|computer-use|deep-research|codex|instruct/i;

export function isOpenAIChatModel(id: string): boolean {
	return !OPENAI_NON_CHAT.test(id);
}

/** Gemini models that accept generateContent but produce speech, images or music rather than chat. */
const GEMINI_NON_CHAT = /tts|image|banana|embedding|transcribe|robotics|lyria|imagen|veo/i;

export function isGeminiChatModel(id: string): boolean {
	return !GEMINI_NON_CHAT.test(id);
}

export interface ModelChoices {
	models: ModelInfo[];
	/** True when the list came from the provider; false when it is the built-in suggestion list. */
	live: boolean;
	/** Why the provider's own list could not be used. */
	error?: ProviderError;
}

/** The provider's own model list, or its built-in suggestions when that list is empty or unavailable. */
export async function loadModelChoices(provider: Provider, signal?: AbortSignal): Promise<ModelChoices> {
	const fallback = [...(SUGGESTED_MODELS[provider.id] ?? [])];
	try {
		const models = await provider.listModels(signal);
		if (models.length > 0) return { models, live: true };
		return { models: fallback, live: false };
	} catch (e) {
		return { models: fallback, live: false, error: toProviderError(e) };
	}
}

/** `models` with the configured model first when the list does not already offer it. */
export function withConfiguredModel(models: readonly ModelInfo[], configured: string): ModelInfo[] {
	if (!configured || models.some((m) => m.id === configured)) return [...models];
	return [{ id: configured }, ...models];
}

/**
 * The model list behind the chat sidebar's menu. Lists are kept per provider
 * so switching providers never shows the previous provider's models, and a
 * load that finishes after a newer one started is dropped.
 */
export class ModelMenu {
	private seq = 0;
	private loaded: { provider: ProviderId; choices: ModelChoices } | null = null;

	constructor(private readonly load: (provider: ProviderId) => Promise<ModelChoices>) {}

	/** Models loaded for `provider`; empty until a load for it completes. */
	models(provider: ProviderId): ModelInfo[] {
		return this.loaded?.provider === provider ? this.loaded.choices.models : [];
	}

	/** True when the provider's own list for `provider` is loaded; a suggestion list is worth retrying. */
	hasLiveList(provider: ProviderId): boolean {
		return this.loaded?.provider === provider && this.loaded.choices.live;
	}

	/** Load the list for `provider`. Resolves null when a newer refresh superseded this one. */
	async refresh(provider: ProviderId): Promise<ModelChoices | null> {
		const seq = ++this.seq;
		const choices = await this.load(provider);
		if (seq !== this.seq) return null;
		this.loaded = { provider, choices };
		return choices;
	}
}
