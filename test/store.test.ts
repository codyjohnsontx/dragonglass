import { describe, expect, it } from 'vitest';
import { ConversationStore } from '../src/persistence/store';
import { deriveTitle, sanitizeConversation } from '../src/persistence/conversation';
import { mergeSettings, DEFAULT_SETTINGS } from '../src/settings';
import { MemoryVaultPort } from './memory-vault';

const nodeTimers = { set: (fn: () => void, ms: number) => setTimeout(fn, ms) as unknown as number, clear: (h: number) => clearTimeout(h) };

describe('ConversationStore', () => {
	it('creates, saves, lists and reloads conversations', async () => {
		const backend = new MemoryVaultPort();
		let t = 1;
		const store = new ConversationStore(backend, () => t++, 0, nodeTimers);
		const a = store.create();
		a.title = 'A';
		a.messages.push({ id: 'm', role: 'user', content: 'hi', createdAt: 1 });
		store.touch(a);
		await store.flush();
		expect([...backend.pluginFiles.keys()]).toEqual([`conversations/${a.id}.json`]);

		const fresh = new ConversationStore(backend, () => t++, 0, nodeTimers);
		const list = await fresh.listConversations();
		expect(list.map((e) => e.title)).toEqual(['A']);
		const loaded = await fresh.load(a.id);
		expect(loaded?.messages[0]?.content).toBe('hi');
		await fresh.delete(a.id);
		expect(backend.pluginFiles.size).toBe(0);
		expect(await fresh.listConversations()).toEqual([]);
	});

	it('does not resurrect a conversation touched after delete', async () => {
		const backend = new MemoryVaultPort();
		const store = new ConversationStore(backend, () => 1, 0, nodeTimers);
		await store.listConversations();
		const a = store.create();
		store.touch(a);
		await store.flush();
		await store.delete(a.id);
		store.touch(a);
		await store.flush();
		expect(backend.pluginFiles.size).toBe(0);
		expect(await store.listConversations()).toEqual([]);
	});

	it('ignores corrupt files', async () => {
		const backend = new MemoryVaultPort();
		backend.pluginFiles.set('conversations/bad.json', '{not json');
		backend.pluginFiles.set('conversations/wrong.json', '{"id": 5}');
		const store = new ConversationStore(backend, () => 1, 0, nodeTimers);
		expect(await store.listConversations()).toEqual([]);
	});
});

describe('conversation helpers', () => {
	it('derives titles and drops malformed stored records', () => {
		const title = deriveTitle('\n\n  Fix the   launch date please, it is wrong and should be moved to November fifteenth');
		expect(title.startsWith('Fix the launch date please,')).toBe(true);
		expect(title.endsWith('…')).toBe(true);
		expect(title.length).toBeLessThanOrEqual(60);
		expect(deriveTitle('short')).toBe('short');
		const conv = sanitizeConversation({
			id: 'c',
			messages: [{ id: 'x', role: 'user', content: 'y' }, { bogus: true }],
			proposals: {
				p1: { id: 'p1', path: 'A.md', after: 'x', kind: 'edit', status: 'pending', createdAt: 2 },
				p2: { id: 'p2', path: 'A.md', after: 'x', kind: 'edit', status: 'applied', createdAt: 1 },
				p3: { nope: true },
			},
		})!;
		expect(conv.messages).toHaveLength(1);
		expect(Object.keys(conv.proposals)).toEqual(['p1', 'p2']);
		expect(sanitizeConversation(null)).toBeNull();
	});
});

describe('mergeSettings', () => {
	it('keeps defaults for unknown or mistyped values', () => {
		expect(mergeSettings(null)).toEqual(DEFAULT_SETTINGS);
		const merged = mergeSettings({ activeProvider: 'openai', ollama: { baseUrl: 'http://x:1', model: 7 }, maxToolIterations: 'lots', transport: 'requestUrl', extra: 1 });
		expect(merged.activeProvider).toBe('openai');
		expect(merged.ollama).toEqual({ baseUrl: 'http://x:1', model: '' });
		expect(merged.maxToolIterations).toBe(DEFAULT_SETTINGS.maxToolIterations);
		expect(merged.transport).toBe('requestUrl');
		expect('extra' in merged).toBe(false);
	});

	it('merges Anthropic and Gemini settings and keeps settings saved before they existed', () => {
		const legacy = mergeSettings({ activeProvider: 'openai', openai: { apiKeySecretId: 'oa', model: 'gpt-x' } });
		expect(legacy.anthropic).toEqual(DEFAULT_SETTINGS.anthropic);
		expect(legacy.gemini).toEqual(DEFAULT_SETTINGS.gemini);
		expect(legacy.openai.apiKeySecretId).toBe('oa');

		const merged = mergeSettings({
			activeProvider: 'gemini',
			anthropic: { apiKeySecretId: 'ant', model: 'claude-x', maxTokens: 2048 },
			gemini: { apiKeySecretId: 'gem', model: 'gemini-x', baseUrl: 'http://g' },
		});
		expect(merged.activeProvider).toBe('gemini');
		expect(merged.anthropic).toEqual({ ...DEFAULT_SETTINGS.anthropic, apiKeySecretId: 'ant', model: 'claude-x', maxTokens: 2048 });
		expect(merged.gemini).toEqual({ apiKeySecretId: 'gem', model: 'gemini-x', baseUrl: 'http://g' });
		expect(mergeSettings({ activeProvider: 'mistral', anthropic: { maxTokens: -5 } })).toMatchObject({
			activeProvider: DEFAULT_SETTINGS.activeProvider,
			anthropic: { maxTokens: DEFAULT_SETTINGS.anthropic.maxTokens },
		});
	});
});
