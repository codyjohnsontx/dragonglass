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

	it('returns metadata with links and backlinks', async () => {
		const { registry } = setup();
		const r = await registry.get('get_note_metadata')!.execute({ path: 'Projects/Launch.md' }, ctx);
		const meta = JSON.parse(r.content);
		expect(meta.frontmatter).toEqual({ status: 'active' });
		expect(meta.tags).toEqual(['#project']);
		expect(meta.headings).toEqual([{ level: 1, text: 'Launch' }]);
		expect(meta.outgoingLinks).toEqual(['Projects/Milestones.md']);
		expect(meta.backlinks).toEqual(['Projects/Milestones.md']);
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
