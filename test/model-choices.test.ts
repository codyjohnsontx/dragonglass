import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FetchHttpClient } from '../src/providers/http';
import {
	isGeminiChatModel,
	isOpenAIChatModel,
	loadModelChoices,
	ModelChoices,
	modelChoices,
	ModelMenu,
	SUGGESTED_MODELS,
	withConfiguredModel,
} from '../src/providers/model-choices';
import { OpenAIProvider } from '../src/providers/openai';
import { createProviders } from '../src/providers/registry';
import { mergeSettings } from '../src/settings';
import { ModelInfo, Provider } from '../src/providers/types';
// @ts-expect-error plain JS module
import { startFakeServer } from './fake-server/server.mjs';

interface Fake {
	baseUrl: string;
	close: () => Promise<void>;
}

let fake: Fake;
beforeAll(async () => {
	fake = (await startFakeServer()) as Fake;
});
afterAll(() => fake.close());

function providers(keys: Partial<Record<'openai' | 'anthropic' | 'gemini', string>>) {
	const settings = mergeSettings({
		ollama: { baseUrl: `${fake.baseUrl}`, model: 'fake-tools' },
		openai: { apiKeySecretId: keys.openai ? 'openai' : '', model: 'fake-gpt', baseUrl: `${fake.baseUrl}/v1` },
		anthropic: { apiKeySecretId: keys.anthropic ? 'anthropic' : '', model: 'fake-claude', baseUrl: `${fake.baseUrl}/anthropic/v1` },
		gemini: { apiKeySecretId: keys.gemini ? 'gemini' : '', model: 'fake-gemini', baseUrl: `${fake.baseUrl}/gemini/v1beta` },
	});
	const http = new FetchHttpClient();
	return createProviders(() => http, () => settings, { getSecret: (id) => keys[id as keyof typeof keys] ?? null });
}

const ids = (models: readonly ModelInfo[]) => models.map((m) => m.id);

describe('chat model filters', () => {
	it('drops OpenAI embedding, speech, image, moderation and realtime models', () => {
		const listed = ['gpt-6-luna', 'gpt-6.1-sol', 'o4-mini', 'text-embedding-3-large', 'whisper-1', 'tts-1-hd', 'gpt-4o-mini-tts', 'gpt-4o-transcribe', 'dall-e-3', 'gpt-image-1', 'omni-moderation-latest', 'gpt-realtime', 'gpt-4o-audio-preview', 'davinci-002', 'babbage-002', 'gpt-3.5-turbo-instruct', 'sora-2'];
		expect(listed.filter(isOpenAIChatModel)).toEqual(['gpt-6-luna', 'gpt-6.1-sol', 'o4-mini']);
	});

	it('drops Gemini speech, image and embedding models', () => {
		const listed = ['gemini-4-argon', 'gemini-3.8-flash', 'gemini-3.8-flash-tts', 'gemini-3.1-flash-image', 'gemini-nano-banana-2.1', 'gemini-embedding-2', 'gemini-3.5-transcribe'];
		expect(listed.filter(isGeminiChatModel)).toEqual(['gemini-4-argon', 'gemini-3.8-flash']);
	});

	it('leaves custom endpoint lists unfiltered', async () => {
		const custom = new OpenAIProvider(new FetchHttpClient(), () => ({ baseUrl: `${fake.baseUrl}/v1`, apiKey: () => 'sk-fake' }), { id: 'custom', displayName: 'Custom' });
		expect(await custom.listModels()).toContainEqual({ id: 'text-embedding-3-small' });
	});
});

describe('loadModelChoices', () => {
	it.each(['openai', 'anthropic', 'gemini'] as const)('offers several current %s models when there is no key', async (id) => {
		const choices = await loadModelChoices(providers({})[id]);
		expect(choices.live).toBe(false);
		expect(choices.error?.kind).toBe('auth');
		expect(choices.models).toEqual(SUGGESTED_MODELS[id]);
		expect(choices.models.length).toBeGreaterThan(1);
	});

	it('falls back when the key is rejected', async () => {
		const choices = await loadModelChoices(providers({ openai: 'sk-wrong' }).openai);
		expect(choices).toMatchObject({ live: false, error: { kind: 'auth', status: 401 } });
		expect(choices.models).toEqual(SUGGESTED_MODELS.openai);
	});

	it('uses the live, chat-only list when the key works', async () => {
		const p = providers({ openai: 'sk-fake', anthropic: 'sk-ant-fake', gemini: 'gemini-fake' });
		expect(await loadModelChoices(p.openai)).toEqual({ live: true, models: [{ id: 'fake-gpt' }, { id: 'fake-plain' }] });
		expect(ids((await loadModelChoices(p.anthropic)).models)).toEqual(['fake-claude', 'fake-claude-small']);
		expect(ids((await loadModelChoices(p.gemini)).models)).toEqual(['fake-gemini']);
	});

	it('falls back when the provider lists nothing', async () => {
		const empty = { id: 'anthropic', listModels: () => Promise.resolve([]) } as unknown as Provider;
		expect(await loadModelChoices(empty)).toEqual({ live: false, models: SUGGESTED_MODELS.anthropic });
	});

	it('has no suggestions for providers whose models are the user\'s own', async () => {
		const ollama = providers({}).ollama;
		const unreachable = { id: 'ollama', listModels: () => Promise.reject(new Error('down')) } as unknown as Provider;
		expect((await loadModelChoices(ollama)).live).toBe(true);
		expect(await loadModelChoices(unreachable)).toMatchObject({ live: false, models: [] });
	});
});

describe('withConfiguredModel', () => {
	const list = [{ id: 'a' }, { id: 'b' }];
	it('keeps a configured model the list does not offer, first', () => {
		expect(ids(withConfiguredModel(list, 'my-fine-tune'))).toEqual(['my-fine-tune', 'a', 'b']);
	});
	it('does not duplicate a listed model or add an empty one', () => {
		expect(ids(withConfiguredModel(list, 'b'))).toEqual(['a', 'b']);
		expect(ids(withConfiguredModel(list, ''))).toEqual(['a', 'b']);
	});
});

describe('modelChoices', () => {
	it('uses what the connection check listed, without listing again', async () => {
		const p = providers({ openai: 'sk-fake' });
		const status = await p.openai.checkConnection();
		expect(modelChoices('openai', status.models)).toEqual({ live: true, models: [{ id: 'fake-gpt' }, { id: 'fake-plain' }] });
	});

	it('falls back to suggestions when the check failed or listed nothing', async () => {
		const status = await providers({}).anthropic.checkConnection();
		expect(status.ok).toBe(false);
		expect(modelChoices('anthropic', status.models)).toEqual({ live: false, models: SUGGESTED_MODELS.anthropic });
		expect(modelChoices('openai', [])).toEqual({ live: false, models: SUGGESTED_MODELS.openai });
	});
});

describe('ModelMenu', () => {
	const live = (...models: string[]): ModelChoices => ({ live: true, models: models.map((id) => ({ id })) });
	const suggested: ModelChoices = { live: false, models: [...SUGGESTED_MODELS.openai!] };

	it('shows each provider only its own list after a switch', () => {
		const menu = new ModelMenu();
		expect(menu.offer('openai', live('gpt'))).toBe(true);
		expect(ids(menu.models('openai'))).toEqual(['gpt']);
		expect(menu.models('anthropic')).toEqual([]);
		expect(menu.offer('anthropic', live('claude'))).toBe(true);
		expect(ids(menu.models('anthropic'))).toEqual(['claude']);
		expect(menu.models('openai')).toEqual([]);
	});

	it('swaps suggestions for the live list once it arrives, then keeps it', () => {
		const menu = new ModelMenu();
		expect(menu.offer('openai', suggested)).toBe(true);
		expect(menu.offer('openai', suggested)).toBe(false);
		expect(menu.offer('openai', live('gpt'))).toBe(true);
		expect(menu.offer('openai', live('gpt', 'gpt-2'))).toBe(false);
		expect(menu.offer('openai', suggested)).toBe(false);
		expect(ids(menu.models('openai'))).toEqual(['gpt']);
	});

	it('takes any list when asked to replace', () => {
		const menu = new ModelMenu();
		menu.offer('openai', live('gpt'));
		expect(menu.offer('openai', live('gpt', 'gpt-2'), true)).toBe(true);
		expect(ids(menu.models('openai'))).toEqual(['gpt', 'gpt-2']);
		expect(menu.offer('openai', suggested, true)).toBe(true);
		expect(menu.models('openai')).toEqual(SUGGESTED_MODELS.openai);
	});
});
