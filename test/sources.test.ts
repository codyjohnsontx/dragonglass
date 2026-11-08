import { describe, expect, it } from 'vitest';
import { buildSystemPrompt, ContextItem, userMessage } from '../src/agent/context';
import { answerSources, extractCitations, linkWebMarkers, sanitizeSources, Source, WebSource } from '../src/agent/sources';
import { ToolRegistry } from '../src/agent/tools';
import { StoredMessage } from '../src/persistence/conversation';
import { VaultSearchIndex } from '../src/search/vault-index';
import { createVaultTools } from '../src/tools/vault-tools';
import { ChangeProposal, ProposalEngine } from '../src/vault/proposals';
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

const proposal = (id: string, kind: ChangeProposal['kind'], path: string): ChangeProposal => ({
	id,
	conversationId: 'c',
	kind,
	path,
	before: null,
	after: '',
	baseHash: null,
	summary: '',
	status: 'pending',
	createdAt: 0,
});

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
		const { lists } = answerSources([user, step, tool, answer], {}, (l) => (l === 'Vorn' ? null : resolve(l)));
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
		const { lists } = answerSources([t1, s1, r1, a1, t2, a2], {}, resolve);
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
		const { lists } = answerSources([user, step, tool, msg('assistant', 'I would cut the second line.')], {}, resolve);
		expect(lists.size).toBe(0);
	});

	it('lists the notes this turn\'s tools showed under a draft that cites none, minus proposed notes', () => {
		const t1 = ask('Who is Mira?');
		const s1 = msg('assistant', '', { toolCalls: [{ id: 't1', name: 'read_note', argumentsJson: '{}' }] });
		const r1 = msg('tool', 'Mira...', { toolCallId: 't1', sources: [read('Characters/Mira.md')] });
		const a1 = msg('assistant', 'She leads the scouts [[Mira]].');
		const t2 = ask('Draft the scene where Kael reaches Ashfall', 'Script/Scene 12.md');
		const s2 = msg('assistant', '', { toolCalls: [{ id: 't2', name: 'search_notes', argumentsJson: '{}' }, { id: 't3', name: 'propose_create_note', argumentsJson: '{}' }] });
		const r2 = msg('tool', 'results', { toolCallId: 't2', sources: [excerpt('Places/Ashfall.md'), read('Characters/Kael.md'), read('Places/Ashfall.md')] });
		const r3 = msg('tool', 'proposed', { toolCallId: 't3', proposalId: 'p1' });
		const draft = msg('assistant', 'Here is the scene.\n\n```draft\nEXT. ASHFALL - DAY\n```', { draft: { thread: 'd1', text: 'EXT. ASHFALL - DAY' } });
		const { lists } = answerSources([t1, s1, r1, a1, t2, s2, r2, r3, draft], { p1: proposal('p1', 'create', 'Characters/Kael.md') }, resolve);
		expect(lists.get(draft.id)).toEqual({
			vault: [{ link: 'Ashfall', path: 'Places/Ashfall.md', status: 'read' }],
			web: [],
			webSources: [],
			readFor: 'draft',
		});
	});

	it('gives a note listed under a draft the status a citation of it would get', () => {
		const t1 = ask('Who is Kael?');
		const s1 = msg('assistant', '', { toolCalls: [{ id: 't1', name: 'read_note', argumentsJson: '{}' }] });
		const r1 = msg('tool', 'Kael...', { toolCallId: 't1', sources: [read('Characters/Kael.md')] });
		const a1 = msg('assistant', 'Gruff but loyal [[Kael]].');
		const t2 = ask('Draft the scene at Ashfall with Kael and Mira', null, ['Characters/Mira.md']);
		const s2 = msg('assistant', '', { toolCalls: [{ id: 't2', name: 'search_notes', argumentsJson: '{}' }] });
		const r2 = msg('tool', 'results', { toolCallId: 't2', sources: [excerpt('Characters/Kael.md'), excerpt('Characters/Mira.md'), excerpt('Places/Ashfall.md')] });
		const draft = msg('assistant', '```draft\nEXT. ASHFALL - DAY\n```', { draft: { thread: 'd1', text: 'EXT. ASHFALL - DAY' } });
		expect(answerSources([t1, s1, r1, a1, t2, s2, r2, draft], {}, resolve).lists.get(draft.id)?.vault).toEqual([
			{ link: 'Kael', path: 'Characters/Kael.md', status: 'read' },
			{ link: 'Mira', path: 'Characters/Mira.md', status: 'read' },
			{ link: 'Ashfall', path: 'Places/Ashfall.md', status: 'excerpt' },
		]);
	});

	it('marks a note listed under a draft as missing once it moved, with a link that does not find a note of the same name', () => {
		const user = ask('Draft Kael at Ashfall');
		const step = msg('assistant', '', { toolCalls: [{ id: 't1', name: 'search_notes', argumentsJson: '{}' }] });
		const tool = msg('tool', 'results', { toolCallId: 't1', sources: [read('Characters/Kael.md'), read('Places/Ashfall.md')] });
		const draft = msg('assistant', '```draft\nEXT. ASHFALL - DAY\n```', { draft: { thread: 'd1', text: 'EXT. ASHFALL - DAY' } });
		const afterMove = (l: string) => (l.startsWith('Places/') ? null : l === 'Ashfall' ? 'World/Ashfall.md' : resolve(l));
		const vault = answerSources([user, step, tool, draft], {}, afterMove).lists.get(draft.id)?.vault;
		expect(vault).toEqual([
			{ link: 'Kael', path: 'Characters/Kael.md', status: 'read' },
			{ link: 'Places/Ashfall', path: null, status: 'missing' },
		]);
		expect(afterMove(vault![1]!.link)).toBeNull();
	});

	it('leaves an excerpt under a draft unflagged after a turn saved before sources were recorded', () => {
		const old = msg('user', 'What is Kael like?', { context: { activeNotePath: null, selection: null, attachments: [] } });
		const oldStep = msg('assistant', '', { toolCalls: [{ id: 'o1', name: 'read_note', argumentsJson: '{}' }] });
		const oldTool = msg('tool', 'Kael is gruff but loyal.', { toolCallId: 'o1' });
		const oldAnswer = msg('assistant', 'Gruff but loyal [[Kael]].');
		const now = ask('Draft Kael at Ashfall');
		const step = msg('assistant', '', { toolCalls: [{ id: 't1', name: 'search_notes', argumentsJson: '{}' }] });
		const tool = msg('tool', 'results', { toolCallId: 't1', sources: [excerpt('Characters/Kael.md'), read('Places/Ashfall.md')] });
		const draft = msg('assistant', '```draft\nEXT. ASHFALL - DAY\n```', { draft: { thread: 'd1', text: 'EXT. ASHFALL - DAY' } });
		expect(answerSources([old, oldStep, oldTool, oldAnswer, now, step, tool, draft], {}, resolve).lists.get(draft.id)?.vault).toEqual([
			{ link: 'Kael', path: 'Characters/Kael.md', status: 'unchecked' },
			{ link: 'Ashfall', path: 'Places/Ashfall.md', status: 'read' },
		]);
	});

	it('keeps only the cited notes under a draft that cites some, and no list under a plain reply that cites none', () => {
		const user = ask('Draft it');
		const step = msg('assistant', '', { toolCalls: [{ id: 't1', name: 'read_note', argumentsJson: '{}' }] });
		const tool = msg('tool', 'Kael...', { toolCallId: 't1', sources: [read('Characters/Kael.md'), read('Characters/Mira.md')] });
		const cited = msg('assistant', 'Kael as in his note [[Kael]].\n\n```draft\nKAEL\nAgain.\n```', { draft: { thread: 'd1', text: 'KAEL\nAgain.' } });
		expect(answerSources([user, step, tool, cited], {}, resolve).lists.get(cited.id)).toEqual({
			vault: [{ link: 'Kael', path: 'Characters/Kael.md', status: 'read' }],
			web: [],
			webSources: [],
		});
		const plain = msg('assistant', 'I would open on the gates.');
		expect(answerSources([user, step, tool, plain], {}, resolve).lists.size).toBe(0);
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
		const { lists } = answerSources([old, oldStep, oldTool, oldAnswer, now, step, tool, answer], {}, resolve);
		expect(lists.has(oldAnswer.id)).toBe(false);
		expect(lists.get(answer.id)?.vault).toEqual([
			{ link: 'Kael', path: 'Characters/Kael.md', status: 'unchecked' },
			{ link: 'Ashfall', path: 'Places/Ashfall.md', status: 'unchecked' },
			{ link: 'Mira', path: 'Characters/Mira.md', status: 'read' },
			{ link: 'Vorn', path: null, status: 'missing' },
		]);
	});

	it('checks every turn the chat sends, recording the notes sent as context and a selection as an excerpt', () => {
		const sent = userMessage('u1', 'Who leads the scouts?', [
			note('active', 'Characters/Kael.md'),
			{ kind: 'selection', path: 'Places/Ashfall.md', label: 'Selection', content: 'Ashfall' },
			note('attachment', 'Characters/Mira.md'),
		], 0);
		expect(sent.sources).toEqual([read('Characters/Kael.md'), excerpt('Places/Ashfall.md'), read('Characters/Mira.md')]);
		const sentAnswer = msg('assistant', 'Kael [[Kael]] grew up in [[Ashfall]].');
		expect(answerSources([sent, sentAnswer], {}, resolve).lists.get(sentAnswer.id)?.vault).toEqual([
			{ link: 'Kael', path: 'Characters/Kael.md', status: 'read' },
			{ link: 'Ashfall', path: 'Places/Ashfall.md', status: 'excerpt' },
		]);
		const selectionOnly = userMessage('u3', 'Is this right?', [{ kind: 'selection', path: 'Characters/Kael.md', label: 'Selection', content: 'gruff' }], 0);
		const selectionAnswer = msg('assistant', 'Yes, he is gruff [[Kael]].');
		expect(answerSources([selectionOnly, selectionAnswer], {}, resolve).lists.get(selectionAnswer.id)?.vault).toEqual([
			{ link: 'Kael', path: 'Characters/Kael.md', status: 'excerpt' },
		]);
		const bare = userMessage('u2', 'Who leads the scouts?', [], 0);
		expect(bare.sources).toEqual([]);
		const answer = msg('assistant', 'Mira does [[Mira]].');
		expect(answerSources([bare, answer], {}, resolve).lists.get(answer.id)?.vault).toEqual([{ link: 'Mira', path: 'Characters/Mira.md', status: 'unread' }]);
	});

	it('leaves out notes the turn proposed creating, before and after approval', () => {
		const user = ask('Create a note for scene 12 where Kael returns');
		const step = msg('assistant', '', { toolCalls: [{ id: 'p1', name: 'propose_create_note', argumentsJson: '{}' }] });
		const tool = msg('tool', 'Proposed creating Scenes/Scene 12.md', { toolCallId: 'p1', proposalId: 'pc', sources: [] });
		const answer = msg('assistant', 'I proposed [[Scene 12]] for you to review; Kael is loyal [[Kael]].');
		const proposals = { pc: proposal('pc', 'create', 'Scenes/Scene 12.md') };
		const before = answerSources([user, step, tool, answer], proposals, resolve);
		expect(before.lists.get(answer.id)?.vault).toEqual([{ link: 'Kael', path: 'Characters/Kael.md', status: 'unread' }]);
		const afterApproval = (l: string) => (l === 'Scene 12' ? 'Scenes/Scene 12.md' : resolve(l));
		const after = answerSources([user, step, tool, answer], proposals, afterApproval);
		expect(after.lists.get(answer.id)?.vault).toEqual([{ link: 'Kael', path: 'Characters/Kael.md', status: 'unread' }]);
	});

	it('leaves out notes the turn proposed editing, but not in other turns', () => {
		const user = ask('Make Kael warmer');
		const step = msg('assistant', '', { toolCalls: [{ id: 'p1', name: 'propose_edit_note', argumentsJson: '{}' }] });
		const tool = msg('tool', 'Proposed edit to Characters/Kael.md', { toolCallId: 'p1', proposalId: 'pe' });
		const answer = msg('assistant', 'I proposed an edit to [[Kael]]; he grew up in [[Ashfall]].');
		const later = ask('Where is he from?');
		const laterAnswer = msg('assistant', 'Ashfall, per [[Kael]].');
		const { lists } = answerSources([user, step, tool, answer, later, laterAnswer], { pe: proposal('pe', 'edit', 'Characters/Kael.md') }, resolve);
		expect(lists.get(answer.id)?.vault).toEqual([{ link: 'Ashfall', path: 'Places/Ashfall.md', status: 'unread' }]);
		expect(lists.get(laterAnswer.id)?.vault).toEqual([{ link: 'Kael', path: 'Characters/Kael.md', status: 'unread' }]);
	});

	it('groups cited web pages by number and flags numbers no result gave', () => {
		const user = ask('When was the sequel announced?');
		const step = msg('assistant', 'Searching the web.', { toolCalls: [{ id: 'w', name: 'web_search', argumentsJson: '{}' }] });
		const tool = msg('tool', 'results', { toolCallId: 'w', sources: [web(1), web(2)] });
		const answer = msg('assistant', 'In 2025 [web 2], per the studio [web 1]; a leak said 2024 [web 5].');
		const { lists, web: byMessage } = answerSources([user, step, tool, answer], {}, resolve);
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
