import { describe, expect, it } from 'vitest';
import { ToolRegistry, parseToolArguments } from '../src/agent/tools';
import { createVaultTools, searchVault } from '../src/tools/vault-tools';
import { ProposalEngine } from '../src/vault/proposals';
import { MemoryVaultPort } from './memory-vault';

const ctx = { conversationId: 'c1', signal: new AbortController().signal };

function setup() {
	const vault = new MemoryVaultPort({
		'Projects/Launch.md': '---\nstatus: active\n---\n# Launch\n\nLaunch date: November 1. See [[Milestones]]. #project\n',
		'Projects/Milestones.md': '# Milestones\n\n- Beta: October 20\n- Launch: see [[Launch]]\n',
		'Journal/2024-01-01.md': 'Nothing about launches here.\n',
	});
	const registry = new ToolRegistry();
	for (const t of createVaultTools(vault, new ProposalEngine(vault))) registry.register(t);
	return { vault, registry };
}

describe('vault tools', () => {
	it('lists the root and folders', async () => {
		const { registry } = setup();
		const list = registry.get('list_files')!;
		expect((await list.execute({}, ctx)).content.split('\n')).toEqual(['Journal/', 'Projects/']);
		expect((await list.execute({ folder: 'Projects' }, ctx)).content).toBe('Projects/Launch.md\nProjects/Milestones.md');
		expect((await list.execute({ folder: 'Nope' }, ctx)).isError).toBe(true);
		expect((await list.execute({ recursive: true }, ctx)).content.split('\n')).toHaveLength(3);
	});

	it('reads notes with delimiters and rejects bad paths', async () => {
		const { registry } = setup();
		const read = registry.get('read_note')!;
		const r = await read.execute({ path: 'Projects/Launch.md' }, ctx);
		expect(r.content).toContain('<<<note path="Projects/Launch.md">>>');
		expect(r.content).toContain('Launch date: November 1');
		expect((await read.execute({ path: '../x.md' }, ctx)).isError).toBe(true);
		expect((await read.execute({ path: 'Missing.md' }, ctx)).content).toMatch(/no note at/);
	});

	it('resolves a wikilink name to the one note it means, and lists the candidates when several match', async () => {
		const { vault, registry } = setup();
		const read = registry.get('read_note')!;
		for (const path of ['Milestones', 'Milestones.md', '[[Milestones]]', '[[Milestones|the plan]]', '[[Milestones#Beta]]', 'milestones.md']) {
			const r = await read.execute({ path }, ctx);
			expect(r.isError).toBeFalsy();
			expect(r.content).toMatch(/^\(Resolved .+ to Projects\/Milestones\.md; use the full path next time\.\)\n<<<note path="Projects\/Milestones\.md">>>/);
		}
		// An existing path is read as given, with no notice.
		expect((await read.execute({ path: 'Projects/Milestones.md' }, ctx)).content).toMatch(/^<<<note path=/);
		// A guessed folder falls back to the one note with that basename.
		const wrongFolder = await read.execute({ path: 'Notes/milestones.md' }, ctx);
		expect(wrongFolder.isError).toBeFalsy();
		expect(wrongFolder.content).toMatch(/^\(Resolved Notes\/milestones\.md to Projects\/Milestones\.md; use the full path next time\.\)\n<<<note path="Projects\/Milestones\.md">>>/);
		vault.seed('Archive/Milestones.md', 'old');
		for (const path of ['Milestones.md', 'Notes/Milestones.md']) {
			const several = await read.execute({ path }, ctx);
			expect(several.isError).toBe(true);
			expect(several.content).toContain('several notes match that name: Archive/Milestones.md, Projects/Milestones.md');
		}
		// A partial path picks between them, as Obsidian links do.
		expect((await read.execute({ path: 'Archive/Milestones' }, ctx)).content).toContain('<<<note path="Archive/Milestones.md">>>\nold');
		// Validation still applies to whatever was given.
		expect((await read.execute({ path: '[[../secret]]' }, ctx)).content).toMatch(/traversal/);
		expect((await read.execute({ path: '.obsidian/app' }, ctx)).content).toMatch(/off limits/);
	});

	it('truncates long notes', async () => {
		const vault = new MemoryVaultPort({ 'Big.md': 'x'.repeat(100) });
		const registry = new ToolRegistry();
		for (const t of createVaultTools(vault, new ProposalEngine(vault), { maxReadChars: 10, maxSearchResults: 5 })) registry.register(t);
		const r = await registry.get('read_note')!.execute({ path: 'Big.md' }, ctx);
		expect(r.content).toContain('[truncated: showing 10 of 100 characters]');
	});

	it('reads its options on every call so a changed cap applies at once', async () => {
		const vault = new MemoryVaultPort({ 'Big.md': 'x'.repeat(100) });
		const registry = new ToolRegistry();
		let maxReadChars = 100;
		for (const t of createVaultTools(vault, new ProposalEngine(vault), () => ({ maxReadChars, maxSearchResults: 5 }))) registry.register(t);
		expect((await registry.get('read_note')!.execute({ path: 'Big.md' }, ctx)).content).not.toContain('[truncated');
		maxReadChars = 10;
		expect((await registry.get('read_note')!.execute({ path: 'Big.md' }, ctx)).content).toContain('[truncated: showing 10 of 100 characters]');
	});

	it('searches names and content, ranking name hits higher', async () => {
		const { vault, registry } = setup();
		const hits = await searchVault(vault, 'launch', '', 10);
		expect(hits.map((h) => h.path)).toEqual(['Projects/Launch.md', 'Projects/Milestones.md', 'Journal/2024-01-01.md']);
		const r = await registry.get('search_notes')!.execute({ query: 'november', folder: 'Projects' }, ctx);
		expect(r.content).toContain('Projects/Launch.md');
		expect(r.content).not.toContain('Projects/Milestones.md');
		expect((await registry.get('search_notes')!.execute({ query: 'zzzz' }, ctx)).content).toMatch(/No notes matched/);
		expect((await registry.get('search_notes')!.execute({ query: '  ' }, ctx)).isError).toBe(true);
	});

	it('returns metadata with links and backlinks as wikilink names beside their paths', async () => {
		const { registry } = setup();
		const tool = registry.get('get_note_metadata')!;
		expect(tool.description).toMatch(/backlinks/);
		expect(tool.description).toMatch(/what links to X/);
		const r = await tool.execute({ path: 'Projects/Launch.md' }, ctx);
		const meta = JSON.parse(r.content);
		expect(meta.frontmatter).toEqual({ status: 'active' });
		expect(meta.tags).toEqual(['#project']);
		expect(meta.headings).toEqual([{ level: 1, text: 'Launch' }]);
		expect(meta.outgoingLinks).toEqual(['Milestones (Projects/Milestones.md)']);
		expect(meta.backlinks).toEqual(['Milestones (Projects/Milestones.md)']);
		// A wikilink name resolves here too.
		const byName = await tool.execute({ path: '[[Milestones]]' }, ctx);
		expect(byName.content).toMatch(/^\(Resolved Milestones\.md to Projects\/Milestones\.md/);
		expect(JSON.parse(byName.content.slice(byName.content.indexOf('{'))).backlinks).toEqual(['Launch (Projects/Launch.md)']);
		const wrongFolder = await tool.execute({ path: 'Notes/Milestones.md' }, ctx);
		expect(wrongFolder.content).toMatch(/^\(Resolved Notes\/Milestones\.md to Projects\/Milestones\.md/);
		expect(JSON.parse(wrongFolder.content.slice(wrongFolder.content.indexOf('{'))).backlinks).toEqual(['Launch (Projects/Launch.md)']);
		expect((await tool.execute({ path: 'Nowhere' }, ctx)).content).toMatch(/no note at Nowhere\.md\. Use list_files or search_notes/);
	});

	it('reads the active note and selection', async () => {
		const { vault, registry } = setup();
		expect((await registry.get('get_active_note')!.execute({}, ctx)).content).toBe('No note is currently open.');
		vault.active = { path: 'Projects/Launch.md', selection: 'November 1' };
		const r = await registry.get('get_active_note')!.execute({}, ctx);
		expect(r.content).toContain('<<<selection>>>\nNovember 1');
	});

	it('write tools only propose', async () => {
		const { vault, registry } = setup();
		const r = await registry.get('propose_edit_note')!.execute(
			{ path: 'Projects/Launch.md', summary: 'date', edits: [{ type: 'find_replace', find: 'November 1', replace: 'November 15' }] },
			ctx,
		);
		expect(r.proposal?.status).toBe('pending');
		expect(r.content).toMatch(/must approve/);
		expect(vault.files.get('Projects/Launch.md')).toContain('November 1.');
		const c = await registry.get('propose_create_note')!.execute({ path: 'New.md', content: 'hi', summary: 's' }, ctx);
		expect(c.proposal?.kind).toBe('create');
		expect(vault.exists('New.md')).toBe(false);
		const bad = await registry.get('propose_edit_note')!.execute({ path: 'Projects/Launch.md', summary: 's', edits: [{ type: 'nope' }] }, ctx);
		expect(bad.isError).toBe(true);
	});

	it('refuses proposals with placeholder text and tells the model to gather the content', async () => {
		const { registry } = setup();
		const edit = await registry.get('propose_edit_note')!.execute(
			{ path: 'Projects/Launch.md', summary: 'decisions', edits: [{ type: 'append', content: '## Decisions\n\n- [Insert decisions from October meetings here]\n' }] },
			ctx,
		);
		expect(edit.isError).toBe(true);
		expect(edit.proposal).toBeUndefined();
		expect(edit.content).toMatch(/placeholder text \(\[Insert decisions from October meetings here\]\)\. Search and read/);
		const create = await registry.get('propose_create_note')!.execute({ path: 'New.md', content: 'Owner: [TODO: find owner]', summary: 's' }, ctx);
		expect(create.isError).toBe(true);
	});
});

describe('parseToolArguments', () => {
	it('validates required fields, types, enums and nested arrays', () => {
		const { registry } = setup();
		const edit = registry.get('propose_edit_note')!;
		expect(() => parseToolArguments(edit, '{}')).toThrow(/missing required "path"/);
		expect(() => parseToolArguments(edit, '{"path":1,"summary":"s","edits":[]}')).toThrow(/"path" must be a string/);
		expect(() => parseToolArguments(edit, '{"path":"a.md","summary":"s","edits":[{"type":"zap"}]}')).toThrow(/edits\[0\]\.type/);
		expect(() => parseToolArguments(edit, 'not json')).toThrow(/not valid JSON/);
		expect(() => parseToolArguments(edit, '[]')).toThrow(/JSON object/);
		expect(parseToolArguments(registry.get('list_files')!, '')).toEqual({});
		const search = registry.get('search_notes')!;
		expect(() => parseToolArguments(search, '{"query":"x","limit":1000}')).toThrow(/<= 100/);
		expect(() => parseToolArguments(search, '{"query":"x","limit":1.5}')).toThrow(/integer/);
	});
});
