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
 * OpenAI's /models also lists embedding, speech, transcription, image, video,
 * moderation, realtime and legacy completion models, none of which answer a chat.
 */
const OPENAI_NON_CHAT = /embedding|whisper|tts|transcribe|dall-e|image|sora|moderation|realtime|^babbage|^davinci/i;

export function isOpenAIChatModel(id: string): boolean {
	return !OPENAI_NON_CHAT.test(id);
}

/** Gemini models that accept generateContent but produce speech, images, music or video rather than chat. */
const GEMINI_NON_CHAT = /tts|image|banana|embedding|transcribe|lyria|imagen|veo/i;

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

const CHAT_FILTERS: Partial<Record<ProviderId, (id: string) => boolean>> = {
	openai: isOpenAIChatModel,
	gemini: isGeminiChatModel,
};

/**
 * The chat models among `models` as provider `id` listed them, or its built-in
 * suggestions when it listed none or could not list.
 */
export function modelChoices(id: ProviderId, models: readonly ModelInfo[] | undefined): ModelChoices {
	const isChat = CHAT_FILTERS[id];
	const chat = isChat ? (models ?? []).filter((m) => isChat(m.id)) : [...(models ?? [])];
	if (chat.length > 0) return { models: chat, live: true };
	return { models: [...(SUGGESTED_MODELS[id] ?? [])], live: false };
}

/** The provider's own model list, or its built-in suggestions when that list is empty or unavailable. */
export async function loadModelChoices(provider: Provider, signal?: AbortSignal): Promise<ModelChoices> {
	try {
		return modelChoices(provider.id, await provider.listModels(signal));
	} catch (e) {
		return { ...modelChoices(provider.id, undefined), error: toProviderError(e) };
	}
}

/** `models` with the configured model first when the list does not already offer it. */
export function withConfiguredModel(models: readonly ModelInfo[], configured: string): ModelInfo[] {
	if (!configured || models.some((m) => m.id === configured)) return [...models];
	return [{ id: configured }, ...models];
}

/**
 * The model list behind the chat sidebar's menu. The list is kept per
 * provider so switching providers never shows the previous provider's models.
 */
export class ModelMenu {
	private loaded: { provider: ProviderId; choices: ModelChoices } | null = null;

	/** Models held for `provider`; empty until choices for it are offered. */
	models(provider: ProviderId): ModelInfo[] {
		return this.loaded?.provider === provider ? this.loaded.choices.models : [];
	}

	/**
	 * Take `choices` for `provider` when `replace` is set, when nothing is held
	 * for it yet, or when they swap suggestions for the provider's own list.
	 * Returns whether the menu changed.
	 */
	offer(provider: ProviderId, choices: ModelChoices, replace = false): boolean {
		const held = this.loaded?.provider === provider ? this.loaded.choices : null;
		if (!replace && held && (held.live || !choices.live)) return false;
		this.loaded = { provider, choices };
		return true;
	}
}
