import { describe, expect, it } from 'vitest';
import { ToolRegistry, parseToolArguments } from '../src/agent/tools';
import { createVaultTools, searchTerms, searchVault } from '../src/tools/vault-tools';
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

	describe('search ranking and output', () => {
		function searchSetup() {
			const filler = 'Unrelated filler text about other things. '.repeat(6);
			const vault = new MemoryVaultPort({
				'Projects/Risks.md': '---\ntags: [project]\n---\n# Risks\n\n- Sync conflicts, no owner yet\n- Pricing page copy may slip\n',
				'Projects/Budget.md': '---\ntags: [project, finance]\n---\n# Budget\n\nQ4 spend is on track.\n',
				'Meetings/Planning.md': `---\ntype: meeting\n---\n# Planning\n\n${filler}\n## Action items\n\n- [ ] Draft the project risks list\n`,
				'Meetings/Standup.md': '# Standup\n\nShort meeting. Nothing on risks.\n',
				'Recipes.md': '# Recipes\n\nPancakes and waffles.\n',
			});
			const registry = new ToolRegistry();
			for (const t of createVaultTools(vault, new ProposalEngine(vault))) registry.register(t);
			return { vault, registry };
		}

		it('matches notes with any term and ranks by how many terms they contain', async () => {
			const { vault } = searchSetup();
			const hits = await searchVault(vault, 'project meeting', '', 20);
			expect(hits.map((h) => h.path)).toEqual(['Meetings/Planning.md', 'Meetings/Standup.md', 'Projects/Budget.md', 'Projects/Risks.md']);
			expect(hits[0]!.matched).toEqual(['project', 'meeting']);
		});

		it('requires every term in "all" mode', async () => {
			const { vault, registry } = searchSetup();
			expect((await searchVault(vault, 'project meeting', '', 20, 'all')).map((h) => h.path)).toEqual(['Meetings/Planning.md']);
			const r = await registry.get('search_notes')!.execute({ query: 'project waffles', mode: 'all' }, ctx);
			expect(r.content).toMatch(/No notes matched/);
			const search = registry.get('search_notes')!;
			expect(() => parseToolArguments(search, '{"query":"x","mode":"some"}')).toThrow(/one of any, all/);
		});

		it('boosts name and heading matches over body mentions', async () => {
			const { vault } = searchSetup();
			const hits = await searchVault(vault, 'risks', '', 20);
			expect(hits.map((h) => h.path)).toEqual(['Projects/Risks.md', 'Meetings/Planning.md', 'Meetings/Standup.md']);
			const actions = await searchVault(vault, 'action', '', 20);
			expect(actions.map((h) => h.path)).toEqual(['Meetings/Planning.md']);
			expect(actions[0]!.score).toBeGreaterThan(5);
		});

		it('ignores stopwords unless the query has nothing else', async () => {
			const { vault } = searchSetup();
			expect((await searchVault(vault, 'risks and action items', '', 20)).map((h) => h.path)).not.toContain('Recipes.md');
			expect((await searchVault(vault, 'and', '', 20)).map((h) => h.path)).toEqual(['Recipes.md']);
		});

		it('matches terms only at the start of a word and ranks coverage over repetition', async () => {
			const vault = new MemoryVaultPort({
				'Mail.md': 'Send the email again. '.repeat(10) + 'Detail: maintain what was said.',
				'Chat.md': 'AI chat. '.repeat(10),
				'AI risks.md': 'Notes on safety.',
				'Plain.md': 'Mentions risks once.',
			});
			const hits = await searchVault(vault, 'AI risks', '', 20);
			expect(hits.map((h) => h.path)).toEqual(['AI risks.md', 'Chat.md', 'Plain.md']);
			expect(hits[1]!.score).toBe(4);
			expect((await searchVault(vault, 'risk', '', 20)).map((h) => h.path)).toEqual(['AI risks.md', 'Plain.md']);
		});

		it('decides word starts from the preceding character', async () => {
			const vault = new MemoryVaultPort({
				'Starts.md': '(ai) and _ai and 🙂ai',
				'Inside.md': 'said 2ai éai 𝒳ai',
			});
			const hits = await searchVault(vault, 'ai', '', 20);
			expect(hits.map((h) => h.path)).toEqual(['Starts.md']);
			expect(hits[0]!.score).toBe(4);
		});

		it('matches terms in scripts without spaces between words anywhere', async () => {
			const vault = new MemoryVaultPort({
				'Journal/今天.md': '今天的会议记录',
				'Notes/项目会议.md': '没有内容',
				'Thai.md': 'บันทึกการประชุมโครงการ',
				'Mail.md': 'Send the email again.',
				'学习.md': '我在学习Python编程，使用AI工具',
				'データ.md': 'データベースのsql設計',
			});
			const hits = await searchVault(vault, '会议', '', 20);
			expect(hits.map((h) => h.path)).toEqual(['Notes/项目会议.md', 'Journal/今天.md']);
			expect(hits[1]!.excerpt).toBe('今天的会议记录');
			expect((await searchVault(vault, 'โครงการ', '', 20)).map((h) => h.path)).toEqual(['Thai.md']);
			expect((await searchVault(vault, 'ai', '', 20)).map((h) => h.path)).toEqual(['学习.md']);
			expect((await searchVault(vault, 'python', '', 20)).map((h) => h.path)).toEqual(['学习.md']);
			expect((await searchVault(vault, 'sql', '', 20)).map((h) => h.path)).toEqual(['データ.md']);
		});

		it('does not match frontmatter key names but does match their values', async () => {
			const notes: Record<string, string> = {
				'Notes/Sync.md': 'Weekly meeting notes.',
				'Notes/Moved.md': 'The date moved again.',
				'Notes/Typed.md': '---\ntype: meeting\ndate: 2024-10-01\n---\nAgenda.',
			};
			for (let i = 0; i < 25; i++) notes[`Daily/${i}.md`] = `---\ndate: 2024-10-${i}\nDue date: soon\n---\nGroceries.`;
			const vault = new MemoryVaultPort(notes);
			const hits = await searchVault(vault, 'meeting date', '', 20);
			expect(hits.map((h) => h.path)).toEqual(['Notes/Moved.md', 'Notes/Sync.md', 'Notes/Typed.md']);
		});

		it('trims punctuation around query words but keeps it inside them', async () => {
			const { vault } = searchSetup();
			expect(searchTerms('"Project meeting" risks, action items? (c++) c# 2024-10.')).toEqual([
				'project', 'meeting', 'risks', 'action', 'items', 'c++', 'c#', '2024-10',
			]);
			expect(searchTerms('?! "and"')).toEqual(['and']);
			expect(searchTerms('?!')).toEqual([]);
			expect((await searchVault(vault, '"project meeting"', '', 20)).map((h) => h.path)).toEqual(
				(await searchVault(vault, 'project meeting', '', 20)).map((h) => h.path),
			);
			expect((await searchVault(vault, 'risks, action items?', '', 20))[0]!.matched).toEqual(['risks', 'action', 'items']);
			const notes = new MemoryVaultPort({ 'Lang.md': 'Notes on C++ and the 2024-10 release.', 'Other.md': 'Plain C here, 2024 only.' });
			expect((await searchVault(notes, 'c++', '', 20)).map((h) => h.path)).toEqual(['Lang.md']);
			expect((await searchVault(notes, '2024-10', '', 20)).map((h) => h.path)).toEqual(['Lang.md']);
		});

		it('shows the basename, matched terms and a body excerpt around the densest match, with no score', async () => {
			const { registry } = searchSetup();
			const r = await registry.get('search_notes')!.execute({ query: 'project risks action' }, ctx);
			const lines = r.content.split('\n');
			expect(lines[0]).toBe('Planning (Meetings/Planning.md) - matches project, risks, action');
			expect(lines[1]).toContain('Action items');
			expect(lines[1]).toContain('project risks list');
			expect(lines[1]).not.toContain('Unrelated filler text about other things. Unrelated');
			expect(r.content).not.toMatch(/score/);
			expect(r.content).not.toMatch(/tags:|type: meeting/);
			const single = await registry.get('search_notes')!.execute({ query: 'budget' }, ctx);
			expect(single.content).toBe('Budget (Projects/Budget.md)\n  # Budget Q4 spend is on track.');
		});
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
