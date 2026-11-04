import { describe, expect, it } from 'vitest';
import { userMessage } from '../src/agent/context';
import { answerSources } from '../src/agent/sources';
import { ToolRegistry } from '../src/agent/tools';
import { StoredMessage } from '../src/persistence/conversation';
import { VaultSearchIndex } from '../src/search/vault-index';
import { relatedNotes } from '../src/tools/related-notes';
import { createVaultTools, DEFAULT_TOOL_OPTIONS } from '../src/tools/vault-tools';
import { baseName } from '../src/vault/paths';
import { ProposalEngine } from '../src/vault/proposals';
import { MemoryVaultPort } from './memory-vault';

const ctx = { conversationId: 'c1', signal: new AbortController().signal };

const LORE: Record<string, string> = {
	'Characters/Kael.md': '# Kael\n\nKael commands [[Fort Ashen]] and distrusts [[Mira]]. #faction/ember #character\n',
	'Characters/Mira.md': '# Mira\n\nMira hunts [[Kael]] from [[Fort Ashen]]. #character\n',
	'Characters/Brann.md': '# Brann\n\nA smith. #character\n',
	'Places/Fort Ashen.md': '# Fort Ashen\n\nA fortress in the north. #place\n',
	'Factions/Ember Order.md': '# Ember Order\n\nRuled from [[Fort Ashen]]. #faction/ember\n',
	'Events/Siege.md': '# Siege\n\n[[Kael]] and [[Brann]] held the wall.\n',
	'Events/Treaty.md': '# Treaty\n\n[[Kael]] and [[Brann]] signed it.\n',
	'Unrelated.md': '# Unrelated\n\nNothing here.\n',
};

function related(notes: Record<string, string>, target: string, limit = 10) {
	return relatedNotes(new MemoryVaultPort(notes).linkGraph(), target, limit);
}

function tool(notes: Record<string, string>) {
	const vault = new MemoryVaultPort(notes);
	const registry = new ToolRegistry();
	for (const t of createVaultTools(vault, new ProposalEngine(vault), DEFAULT_TOOL_OPTIONS, new VaultSearchIndex(vault, () => Promise.resolve()))) registry.register(t);
	return registry.get('related_notes')!;
}

describe('relatedNotes', () => {
	it('ranks direct links, co-citation, shared links and shared tags, and says why', () => {
		const { notes, total } = related(LORE, 'Characters/Kael.md');
		expect(total).toBe(6);
		expect(notes.map((n) => [n.path, n.reasons])).toEqual([
			['Characters/Mira.md', ['links both ways with [[Kael]]', 'both link to [[Fort Ashen]]', 'shares #character']],
			['Places/Fort Ashen.md', ['[[Kael]] links to it', 'linked together with [[Kael]] from [[Mira]]']],
			['Characters/Brann.md', ['linked together with [[Kael]] from 2 notes: [[Siege]], [[Treaty]]', 'shares #character']],
			['Events/Siege.md', ['links to [[Kael]]']],
			['Events/Treaty.md', ['links to [[Kael]]']],
			['Factions/Ember Order.md', ['both link to [[Fort Ashen]]', 'shares #faction/ember']],
		]);
		expect(notes.map((n) => n.path)).not.toContain('Unrelated.md');
	});

	it('breaks ties by path and gives the same order whatever order the vault lists notes in', () => {
		const forward = related(LORE, 'Characters/Kael.md');
		const reversed = relatedNotes(new MemoryVaultPort(LORE).linkGraph().reverse(), 'Characters/Kael.md', 10);
		expect(reversed).toEqual(forward);
		const [siege, treaty] = forward.notes.slice(3, 5);
		expect(siege!.score).toBe(treaty!.score);
		expect([siege!.path, treaty!.path]).toEqual(['Events/Siege.md', 'Events/Treaty.md']);
	});

	it('weighs a rare shared tag above a link from an index of everything', () => {
		const notes: Record<string, string> = {
			'A.md': 'A #rare',
			'B.md': 'B',
			'C.md': 'C #rare',
			'Index.md': Array.from({ length: 10 }, (_, i) => `[[N${i}]]`).join(' ') + ' [[A]] [[B]]',
		};
		for (let i = 0; i < 10; i++) notes[`N${i}.md`] = `N${i}`;
		const paths = related(notes, 'A.md').notes.map((n) => [n.path, n.reasons]);
		expect(paths.slice(0, 3)).toEqual([
			['C.md', ['shares #rare']],
			['Index.md', ['links to [[A]]']],
			['B.md', ['linked together with [[A]] from [[Index]]']],
		]);
	});

	it('compares tags case-insensitively and names them as the note spells them', () => {
		const { notes } = related({ 'A.md': 'A #Faction/Ember', 'B.md': 'B #faction/ember' }, 'A.md');
		expect(notes).toEqual([expect.objectContaining({ path: 'B.md', reasons: ['shares #Faction/Ember'] })]);
	});

	it('ignores self-links, links to missing notes and links to non-note files', () => {
		const { notes } = related({ 'A.md': '[[A]] [[Ghost]] [[map.png]]', 'B.md': '[[Ghost]] [[map.png]]', 'map.png': '' }, 'A.md');
		expect(notes).toEqual([]);
	});

	it('names at most three notes or tags per reason, rarest first', () => {
		const notes: Record<string, string> = { 'A.md': '#t1 #t2 #t3 #t4 #t5', 'B.md': '#t1 #t2 #t3 #t4 #t5' };
		notes['C.md'] = '#t5';
		const b = related(notes, 'A.md').notes.find((n) => n.path === 'B.md')!;
		expect(b.reasons).toEqual(['shares #t1, #t2, #t3 and 2 more']);
	});

	it('returns at most the limit and counts the rest', () => {
		const notes: Record<string, string> = { 'Hub.md': 'hub' };
		for (let i = 0; i < 40; i++) notes[`Spoke ${String(i).padStart(2, '0')}.md`] = '[[Hub]]';
		const { notes: shown, total } = related(notes, 'Hub.md', 5);
		expect(total).toBe(40);
		expect(shown.map((n) => n.path)).toEqual(['Spoke 00.md', 'Spoke 01.md', 'Spoke 02.md', 'Spoke 03.md', 'Spoke 04.md']);
	});
});

describe('related_notes tool', () => {
	it('lists related notes with reasons and cites them by name, reporting no sources since it shows no note text', async () => {
		const r = await tool(LORE).execute({ path: 'Kael' }, ctx);
		expect(r.isError).toBeUndefined();
		expect(r.content).toContain('(Resolved Kael.md to Characters/Kael.md; use the full path next time.)');
		expect(r.content).toContain('Notes related to [[Kael]] (Characters/Kael.md), most related first:');
		expect(r.content).toContain('1. Mira (Characters/Mira.md)\n   - links both ways with [[Kael]]\n   - both link to [[Fort Ashen]]\n   - shares #character');
		expect(r.content).toContain('read_note the ones that matter before citing them as [[Name]]');
		expect(r.content).not.toContain('more related notes not shown');
		expect(r.sources).toBeUndefined();
	});

	it('leaves a related note cited without being read unverified in the sources list', async () => {
		const listed = await tool(LORE).execute({ path: 'Kael' }, ctx);
		expect(listed.content).toContain('Brann (Characters/Brann.md)');
		const resolve = (link: string) => Object.keys(LORE).find((p) => baseName(p) === link) ?? null;
		const messages: StoredMessage[] = [
			userMessage('u1', "What's Kael like?", [], 0),
			{ id: 'a1', role: 'assistant', content: '', createdAt: 0, toolCalls: [{ id: 't1', name: 'related_notes', argumentsJson: '{"path":"Kael"}' }] },
			{ id: 'r1', role: 'tool', content: listed.content, createdAt: 0, toolCallId: 't1', sources: listed.sources },
			{ id: 'a2', role: 'assistant', content: "Brann was Kael's sworn brother [[Brann]]. Kael is gruff [[Kael]].", createdAt: 0 },
		];
		expect(answerSources(messages, {}, resolve).lists.get('a2')?.vault).toEqual([
			{ link: 'Brann', path: 'Characters/Brann.md', status: 'unread' },
			{ link: 'Kael', path: 'Characters/Kael.md', status: 'unread' },
		]);
	});

	it('shows 10 by default, at most 25, and says how many more there are', async () => {
		const notes: Record<string, string> = { 'Hub.md': 'hub' };
		for (let i = 0; i < 40; i++) notes[`Spoke ${String(i).padStart(2, '0')}.md`] = '[[Hub]]';
		const t = tool(notes);
		const byDefault = await t.execute({ path: 'Hub.md' }, ctx);
		expect(byDefault.content).toContain('10. Spoke 09 (Spoke 09.md)');
		expect(byDefault.content).not.toContain('11.');
		expect(byDefault.content).toContain('30 more related notes not shown');
		const most = await t.execute({ path: 'Hub.md', limit: 100 }, ctx);
		expect(most.content).toContain('25. Spoke 24');
		expect(most.content).not.toContain('26.');
		expect(most.content).toContain('15 more related notes not shown');
	});

	it('says so when nothing is related, and fails for a missing note', async () => {
		const t = tool(LORE);
		const none = await t.execute({ path: 'Unrelated.md' }, ctx);
		expect(none.content).toBe('No notes share links or tags with [[Unrelated]] (Unrelated.md).');
		expect(none.sources).toBeUndefined();
		const missing = await t.execute({ path: 'Nobody' }, ctx);
		expect(missing.isError).toBe(true);
		expect(missing.sources).toBeUndefined();
	});
});
