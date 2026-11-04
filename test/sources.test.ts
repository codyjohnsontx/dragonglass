import { describe, expect, it } from 'vitest';
import { buildSystemPrompt } from '../src/agent/context';
import { answerSources, extractCitations, linkWebMarkers, sanitizeSources, Source, WebSource } from '../src/agent/sources';
import { ToolRegistry } from '../src/agent/tools';
import { StoredMessage } from '../src/persistence/conversation';
import { VaultSearchIndex } from '../src/search/vault-index';
import { createVaultTools } from '../src/tools/vault-tools';
import { ProposalEngine } from '../src/vault/proposals';
import { MemoryVaultPort } from './memory-vault';

const NOTES: Record<string, string> = {
	'Characters/Kael.md': 'Kael is gruff but loyal. He distrusts the Council.',
	'Characters/Mira.md': 'Mira leads the scouts.',
	'Places/Ashfall.md': 'Ashfall is where Kael grew up.',
};

/** Resolves a link the way Obsidian does for these notes: by basename or full path, case-insensitive. */
const resolve = (link: string): string | null => {
	const wanted = link.toLowerCase().replace(/\.md$/, '');
	return Object.keys(NOTES).find((p) => p.toLowerCase().replace(/\.md$/, '') === wanted || p.toLowerCase().endsWith(`/${wanted}.md`)) ?? null;
};

let seq = 0;
function msg(role: StoredMessage['role'], content: string, extra: Partial<StoredMessage> = {}): StoredMessage {
	return { id: `m${++seq}`, role, content, createdAt: 0, ...extra };
}

const read = (path: string): Source => ({ kind: 'vault', path, seen: 'full' });
const excerpt = (path: string): Source => ({ kind: 'vault', path, seen: 'excerpt' });
const web = (n: number, url = `https://example.com/${n}`): WebSource => ({ kind: 'web', n, url, title: `Page ${n}` });

describe('extractCitations', () => {
	it('finds each wikilink target once, without alias or heading, and skips embeds and code', () => {
		const text = [
			'Kael is gruff [[Kael]]. He grew up in [[Ashfall#Childhood|the ash city]].',
			'Again [[kael]] and ![[map.png]].',
			'`[[Not cited]]`',
			'```\n[[Also not cited]] [web 9]\n```',
			'Announced in 2025 [web 2][web 1], confirmed [web 2].',
		].join('\n');
		expect(extractCitations(text)).toEqual({ notes: ['Kael', 'Ashfall'], web: [2, 1] });
	});
});

describe('linkWebMarkers', () => {
	it('links markers to the numbered page and leaves unknown numbers and code alone', () => {
		const text = 'Announced [web 1]. Rumoured [web 7]. `[web 1]` [web 1](already)';
		expect(linkWebMarkers(text, [web(1, 'https://ex.com/a>b')])).toBe(
			'Announced [web 1](<https://ex.com/a%3Eb>). Rumoured [web 7]. `[web 1]` [web 1](already)',
		);
		expect(linkWebMarkers(text, [])).toBe(text);
	});
});

describe('answerSources', () => {
	it('marks each cited note by what the model was shown and lists notes read but not cited', () => {
		const user = msg('user', 'What is Kael like?');
		const step = msg('assistant', '', { toolCalls: [{ id: 't1', name: 'search_notes', argumentsJson: '{}' }] });
		const tool = msg('tool', 'results', { toolCallId: 't1', sources: [read('Characters/Kael.md'), excerpt('Places/Ashfall.md'), read('Characters/Mira.md')] });
		const answer = msg('assistant', 'Gruff but loyal [[Kael]]. Grew up in [[Ashfall]]. Rivals [[Vorn]]. Distrusts the Council [[Characters/Kael]].');
		const { lists } = answerSources([user, step, tool, answer], (l) => (l === 'Vorn' ? null : resolve(l)));
		expect(lists.get(step.id)).toBeUndefined();
		expect(lists.get(answer.id)).toEqual({
			vault: [
				{ link: 'Kael', path: 'Characters/Kael.md', status: 'read', cited: true },
				{ link: 'Ashfall', path: 'Places/Ashfall.md', status: 'excerpt', cited: true },
				{ link: 'Vorn', path: null, status: 'missing', cited: true },
				{ link: 'Mira', path: 'Characters/Mira.md', status: 'read', cited: false },
			],
			web: [],
			webSources: [],
		});
	});

	it('counts tool reads from earlier turns but attached context only in its own turn', () => {
		const t1 = msg('user', 'Tell me about Mira', { context: { activeNotePath: 'Characters/Mira.md', selection: null, attachments: [] } });
		const s1 = msg('assistant', '', { toolCalls: [{ id: 't1', name: 'read_note', argumentsJson: '{}' }] });
		const r1 = msg('tool', 'Kael...', { toolCallId: 't1', sources: [read('Characters/Kael.md')] });
		const a1 = msg('assistant', 'She leads the scouts [[Mira]].');
		const t2 = msg('user', 'And Kael?', { context: { activeNotePath: null, selection: null, attachments: [{ path: 'Places/Ashfall.md' }] } });
		const a2 = msg('assistant', 'Mira [[Mira]] trusts him; he is from [[Ashfall]] and is loyal [[Kael]].');
		const { lists } = answerSources([t1, s1, r1, a1, t2, a2], resolve);
		expect(lists.get(a1.id)?.vault).toEqual([
			{ link: 'Mira', path: 'Characters/Mira.md', status: 'read', cited: true },
			{ link: 'Kael', path: 'Characters/Kael.md', status: 'read', cited: false },
		]);
		expect(lists.get(a2.id)?.vault).toEqual([
			{ link: 'Mira', path: 'Characters/Mira.md', status: 'unread', cited: true },
			{ link: 'Ashfall', path: 'Places/Ashfall.md', status: 'read', cited: true },
			{ link: 'Kael', path: 'Characters/Kael.md', status: 'read', cited: true },
		]);
	});

	it('has no list for an answer that cites nothing and read nothing', () => {
		const { lists } = answerSources([msg('user', 'hi'), msg('assistant', 'Hello!')], resolve);
		expect(lists.size).toBe(0);
	});

	it('groups cited web pages by number and flags numbers no result gave', () => {
		const user = msg('user', 'When was the sequel announced?');
		const step = msg('assistant', 'Searching the web.', { toolCalls: [{ id: 'w', name: 'web_search', argumentsJson: '{}' }] });
		const tool = msg('tool', 'results', { toolCallId: 'w', sources: [web(1), web(2)] });
		const answer = msg('assistant', 'In 2025 [web 2], per the studio [web 1]; a leak said 2024 [web 5].');
		const { lists, web: byMessage } = answerSources([user, step, tool, answer], resolve);
		expect(lists.get(answer.id)?.web).toEqual([
			{ n: 1, source: web(1) },
			{ n: 2, source: web(2) },
			{ n: 5, source: null },
		]);
		expect(lists.get(answer.id)?.vault).toEqual([]);
		expect(byMessage.get(step.id)).toEqual([web(1), web(2)]);
		expect(byMessage.get(answer.id)).toEqual([web(1), web(2)]);
	});

	it('ignores malformed sources read back from disk', () => {
		expect(sanitizeSources([read('a.md'), { kind: 'vault', path: 3 }, { kind: 'web', n: '1' }, null, web(1)])).toEqual([read('a.md'), web(1)]);
		expect(sanitizeSources('nope')).toEqual([]);
	});
});

describe('tools report what they showed', () => {
	function tools(autoReadTokens: number) {
		const vault = new MemoryVaultPort(NOTES);
		const registry = new ToolRegistry();
		const opts = { maxReadChars: 24_000, maxSearchResults: 20, autoReadTokens };
		for (const t of createVaultTools(vault, new ProposalEngine(vault), opts, new VaultSearchIndex(vault, () => Promise.resolve()))) registry.register(t);
		return { vault, registry };
	}
	const ctx = { conversationId: 'c', signal: new AbortController().signal };

	it('read_note reports the note it read', async () => {
		const r = await tools(0).registry.get('read_note')!.execute({ path: 'Kael' }, ctx);
		expect(r.sources).toEqual([read('Characters/Kael.md')]);
		expect((await tools(0).registry.get('read_note')!.execute({ path: 'Nobody' }, ctx)).sources).toBeUndefined();
	});

	it('search_notes reports excerpts, and full text for the results it included', async () => {
		const excerptsOnly = await tools(0).registry.get('search_notes')!.execute({ query: 'Kael' }, ctx);
		expect(excerptsOnly.sources).toEqual([excerpt('Characters/Kael.md'), excerpt('Places/Ashfall.md')]);
		const withText = await tools(4000).registry.get('search_notes')!.execute({ query: 'Kael' }, ctx);
		expect(withText.sources).toEqual([read('Characters/Kael.md'), read('Places/Ashfall.md')]);
	});

	it('get_active_note reports the open note', async () => {
		const { vault, registry } = tools(0);
		vault.active = { path: 'Characters/Mira.md', selection: null };
		expect((await registry.get('get_active_note')!.execute({}, ctx)).sources).toEqual([read('Characters/Mira.md')]);
	});
});

describe('system prompt', () => {
	it('adds the [web N] marker rule only when web sources can be in the conversation', () => {
		for (const toolsEnabled of [true, false]) {
			expect(buildSystemPrompt({ toolsEnabled, maxCharsPerNote: 100 })).not.toContain('[web');
			expect(buildSystemPrompt({ toolsEnabled, maxCharsPerNote: 100, webSources: true })).toContain('[web');
		}
	});
});
