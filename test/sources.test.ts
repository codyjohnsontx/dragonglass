import { describe, expect, it } from 'vitest';
import { buildSystemPrompt, ContextItem, userMessage } from '../src/agent/context';
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

const note = (kind: ContextItem['kind'], path: string): ContextItem => ({ kind, path, label: path, content: NOTES[path] ?? '' });

/** A user message as the chat sends it now. */
function ask(text: string, activeNotePath: string | null = null, attachments: string[] = []): StoredMessage {
	const context = [...(activeNotePath ? [note('active', activeNotePath)] : []), ...attachments.map((p) => note('attachment', p))];
	return userMessage(`m${++seq}`, text, context, 0);
}

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
	it('marks each cited note by what the model was shown and lists only cited notes', () => {
		const user = ask('What is Kael like?');
		const step = msg('assistant', '', { toolCalls: [{ id: 't1', name: 'search_notes', argumentsJson: '{}' }] });
		const tool = msg('tool', 'results', { toolCallId: 't1', sources: [read('Characters/Kael.md'), excerpt('Places/Ashfall.md'), read('Characters/Mira.md')] });
		const answer = msg('assistant', 'Gruff but loyal [[Kael]]. Grew up in [[Ashfall]]. Rivals [[Vorn]]. Distrusts the Council [[Characters/Kael]].');
		const { lists } = answerSources([user, step, tool, answer], (l) => (l === 'Vorn' ? null : resolve(l)));
		expect(lists.get(step.id)).toBeUndefined();
		expect(lists.get(answer.id)).toEqual({
			vault: [
				{ link: 'Kael', path: 'Characters/Kael.md', status: 'read' },
				{ link: 'Ashfall', path: 'Places/Ashfall.md', status: 'excerpt' },
				{ link: 'Vorn', path: null, status: 'missing' },
			],
			web: [],
			webSources: [],
		});
	});

	it('counts tool reads from earlier turns but attached context only in its own turn', () => {
		const t1 = ask('Tell me about Mira', 'Characters/Mira.md');
		const s1 = msg('assistant', '', { toolCalls: [{ id: 't1', name: 'read_note', argumentsJson: '{}' }] });
		const r1 = msg('tool', 'Kael...', { toolCallId: 't1', sources: [read('Characters/Kael.md')] });
		const a1 = msg('assistant', 'She leads the scouts [[Mira]].');
		const t2 = ask('And Kael?', null, ['Places/Ashfall.md']);
		const a2 = msg('assistant', 'Mira [[Mira]] trusts him; he is from [[Ashfall]] and is loyal [[Kael]].');
		const { lists } = answerSources([t1, s1, r1, a1, t2, a2], resolve);
		expect(lists.get(a1.id)?.vault).toEqual([{ link: 'Mira', path: 'Characters/Mira.md', status: 'read' }]);
		expect(lists.get(a2.id)?.vault).toEqual([
			{ link: 'Mira', path: 'Characters/Mira.md', status: 'unread' },
			{ link: 'Ashfall', path: 'Places/Ashfall.md', status: 'read' },
			{ link: 'Kael', path: 'Characters/Kael.md', status: 'read' },
		]);
	});

	it('has no list for an answer that cites nothing, even with notes sent and read', () => {
		const user = ask('Tighten this scene', 'Characters/Kael.md');
		const step = msg('assistant', '', { toolCalls: [{ id: 't1', name: 'read_note', argumentsJson: '{}' }] });
		const tool = msg('tool', 'Mira...', { toolCallId: 't1', sources: [read('Characters/Mira.md')] });
		const { lists } = answerSources([user, step, tool, msg('assistant', 'I would cut the second line.')], resolve);
		expect(lists.size).toBe(0);
	});

	it('has no list for a turn saved before sources were recorded, and flags nothing it may have shown later', () => {
		const old = msg('user', 'What is Kael like?', { context: { activeNotePath: null, selection: null, attachments: [] } });
		const oldStep = msg('assistant', '', { toolCalls: [{ id: 'o1', name: 'read_note', argumentsJson: '{}' }] });
		const oldTool = msg('tool', 'Kael is gruff but loyal.', { toolCallId: 'o1' });
		const oldAnswer = msg('assistant', 'Gruff but loyal [[Kael]].');
		const now = ask('What weapon does he carry?');
		const step = msg('assistant', '', { toolCalls: [{ id: 't1', name: 'search_notes', argumentsJson: '{}' }] });
		const tool = msg('tool', 'results', { toolCallId: 't1', sources: [read('Characters/Mira.md'), excerpt('Places/Ashfall.md')] });
		const answer = msg('assistant', 'A spear [[Kael]], from [[Ashfall]], made by [[Mira]] or [[Vorn]].');
		const { lists } = answerSources([old, oldStep, oldTool, oldAnswer, now, step, tool, answer], resolve);
		expect(lists.has(oldAnswer.id)).toBe(false);
		expect(lists.get(answer.id)?.vault).toEqual([
			{ link: 'Kael', path: 'Characters/Kael.md', status: 'unchecked' },
			{ link: 'Ashfall', path: 'Places/Ashfall.md', status: 'unchecked' },
			{ link: 'Mira', path: 'Characters/Mira.md', status: 'read' },
			{ link: 'Vorn', path: null, status: 'missing' },
		]);
	});

	it('checks every turn the chat sends, recording the notes sent as context but not a selection', () => {
		const sent = userMessage('u1', 'Who leads the scouts?', [
			note('active', 'Characters/Kael.md'),
			{ kind: 'selection', path: 'Places/Ashfall.md', label: 'Selection', content: 'Ashfall' },
			note('attachment', 'Characters/Mira.md'),
		], 0);
		expect(sent.sources).toEqual([read('Characters/Kael.md'), read('Characters/Mira.md')]);
		const bare = userMessage('u2', 'Who leads the scouts?', [], 0);
		expect(bare.sources).toEqual([]);
		const answer = msg('assistant', 'Mira does [[Mira]].');
		expect(answerSources([bare, answer], resolve).lists.get(answer.id)?.vault).toEqual([{ link: 'Mira', path: 'Characters/Mira.md', status: 'unread' }]);
	});

	it('groups cited web pages by number and flags numbers no result gave', () => {
		const user = ask('When was the sequel announced?');
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

	it('get_note_metadata reports the note it showed properties of as partly seen', async () => {
		const r = await tools(0).registry.get('get_note_metadata')!.execute({ path: 'Kael' }, ctx);
		expect(r.sources).toEqual([excerpt('Characters/Kael.md')]);
		expect((await tools(0).registry.get('get_note_metadata')!.execute({ path: 'Nobody' }, ctx)).sources).toBeUndefined();
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
