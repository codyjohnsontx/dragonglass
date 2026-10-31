import { describe, expect, it } from 'vitest';
import { ToolRegistry, parseToolArguments } from '../src/agent/tools';
import { searchFields, searchTerms, weightedMatches, wordStartFinder } from '../src/search/tokenize';
import { SearchMode, VaultSearchIndex } from '../src/search/vault-index';
import { createVaultTools, DEFAULT_TOOL_OPTIONS, VaultToolOptions } from '../src/tools/vault-tools';
import { ProposalEngine } from '../src/vault/proposals';
import { MemoryVaultPort } from './memory-vault';

const ctx = { conversationId: 'c1', signal: new AbortController().signal };

const noYield = () => Promise.resolve();

function searchVault(vault: MemoryVaultPort, query: string, folder: string, limit: number, mode: SearchMode = 'any') {
	return new VaultSearchIndex(vault, noYield).search(query, { folder, limit, mode });
}

function vaultTools(vault: MemoryVaultPort, options: VaultToolOptions | (() => VaultToolOptions) = DEFAULT_TOOL_OPTIONS) {
	return createVaultTools(vault, new ProposalEngine(vault), options, new VaultSearchIndex(vault, noYield));
}

function setup() {
	const vault = new MemoryVaultPort({
		'Projects/Launch.md': '---\nstatus: active\n---\n# Launch\n\nLaunch date: November 1. See [[Milestones]]. #project\n',
		'Projects/Milestones.md': '# Milestones\n\n- Beta: October 20\n- Launch: see [[Launch]]\n',
		'Journal/2024-01-01.md': 'Nothing about launches here.\n',
	});
	const registry = new ToolRegistry();
	for (const t of vaultTools(vault)) registry.register(t);
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
		// A guessed folder does not resolve into another folder; the error names the note instead.
		const wrongFolder = await read.execute({ path: 'Notes/milestones.md' }, ctx);
		expect(wrongFolder.isError).toBe(true);
		expect(wrongFolder.content).toBe(
			'Error: no note at Notes/milestones.md. A note with that name is in another folder: Projects/Milestones.md. Call again with one of these paths only if it is the note you mean.',
		);
		vault.seed('Archive/Milestones.md', 'old');
		const several = await read.execute({ path: 'Milestones.md' }, ctx);
		expect(several.isError).toBe(true);
		expect(several.content).toContain('several notes match that name: Archive/Milestones.md, Projects/Milestones.md');
		expect((await read.execute({ path: 'Notes/Milestones.md' }, ctx)).content).toContain(
			'Notes with that name are in other folders: Archive/Milestones.md, Projects/Milestones.md.',
		);
		// A partial path picks between them, as Obsidian links do.
		expect((await read.execute({ path: 'Archive/Milestones' }, ctx)).content).toContain('<<<note path="Archive/Milestones.md">>>\nold');
		// Validation still applies to whatever was given.
		expect((await read.execute({ path: '[[../secret]]' }, ctx)).content).toMatch(/traversal/);
		expect((await read.execute({ path: '.obsidian/app' }, ctx)).content).toMatch(/off limits/);
	});

	it('truncates long notes', async () => {
		const vault = new MemoryVaultPort({ 'Big.md': 'x'.repeat(100) });
		const registry = new ToolRegistry();
		for (const t of vaultTools(vault, { maxReadChars: 10, maxSearchResults: 5 })) registry.register(t);
		const r = await registry.get('read_note')!.execute({ path: 'Big.md' }, ctx);
		expect(r.content).toContain('[truncated: showing 10 of 100 characters]');
	});

	it('reads its options on every call so a changed cap applies at once', async () => {
		const vault = new MemoryVaultPort({ 'Big.md': 'x'.repeat(100) });
		const registry = new ToolRegistry();
		let maxReadChars = 100;
		for (const t of vaultTools(vault, () => ({ maxReadChars, maxSearchResults: 5 }))) registry.register(t);
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
			for (const t of vaultTools(vault)) registry.register(t);
			return { vault, registry };
		}

		it('names better matches outside a folder the search was restricted to, and searches the whole vault when it has none', async () => {
			const { registry } = searchSetup();
			const search = registry.get('search_notes')!;
			const wrongFolder = await search.execute({ query: 'risks', folder: 'Meetings' }, ctx);
			const lines = wrongFolder.content.split('\n');
			expect(lines[0]).toBe(
				'Searched only Meetings/. Notes elsewhere match better: Risks (Projects/Risks.md). Search again without folder if the results below do not answer the question.',
			);
			expect(lines[2]).toBe('Standup (Meetings/Standup.md)');

			// A folder with no match searches the whole vault instead and says so.
			const nothingThere = await search.execute({ query: 'pancakes', folder: 'Projects/' }, ctx);
			expect(nothingThere.isError).toBeUndefined();
			expect(nothingThere.content.split('\n').slice(0, 3)).toEqual([
				'No notes in Projects/ matched "pancakes"; these results are from the whole vault.',
				'',
				'Recipes (Recipes.md)',
			]);

			// The folder's best result is also the vault's: no note.
			expect((await search.execute({ query: 'risks', folder: 'Projects' }, ctx)).content).toMatch(/^Risks \(Projects\/Risks\.md\)/);
			expect((await search.execute({ query: 'zzzz', folder: 'Projects' }, ctx)).content).toBe('No notes matched "zzzz".');
		});

		it('matches notes with any term', async () => {
			const { vault } = searchSetup();
			const hits = await searchVault(vault, 'project meeting', '', 20);
			expect(hits.map((h) => h.path).sort()).toEqual(['Meetings/Planning.md', 'Meetings/Standup.md', 'Projects/Budget.md', 'Projects/Risks.md']);
			expect(hits.find((h) => h.path === 'Meetings/Planning.md')!.matched).toEqual(['project', 'meeting']);
		});

		it('ranks rare words over common ones and more of the query over less', async () => {
			const notes: Record<string, string> = {
				'Projects/Nimbus Bridge.md': '# Nimbus Bridge\n\nBudget: $46,300 remaining.\n',
				'Meetings/2024-05-01 Nimbus Bridge sync.md': '# Nimbus Bridge sync\n\nProject status reviewed.\n',
				'Projects/Other.md': '# Other\n\nProject budget remaining is fine.\n',
			};
			for (let i = 0; i < 30; i++) notes[`Notes/Status ${i}.md`] = `Project status update number ${i}.\n`;
			const vault = new MemoryVaultPort(notes);
			const hits = await searchVault(vault, 'nimbus bridge project budget remaining', '', 50);
			expect(hits.slice(0, 3).map((h) => h.path)).toEqual([
				'Projects/Nimbus Bridge.md',
				'Meetings/2024-05-01 Nimbus Bridge sync.md',
				'Projects/Other.md',
			]);
			expect(hits).toHaveLength(33);
		});

		it('ranks a word itself over longer words it starts', async () => {
			const vault = new MemoryVaultPort({
				'Video notes.md': 'Video editing tips.',
				'Nimbus VI.md': 'Sixth of the series.',
				'Views.md': 'Viewing angles.',
			});
			const hits = await searchVault(vault, 'vi', '', 20);
			expect(hits.map((h) => h.path)[0]).toBe('Nimbus VI.md');
			expect(hits).toHaveLength(3);
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
			expect(hits[0]!.path).toBe('Projects/Risks.md');
			expect(hits.map((h) => h.path).sort()).toEqual(['Meetings/Planning.md', 'Meetings/Standup.md', 'Projects/Risks.md']);
			const headings = new MemoryVaultPort({
				'Body.md': 'Intro.\n\nThe action list is short.\n',
				'Heading.md': 'Intro.\n\n## Action\nThe list is short.\n',
			});
			expect((await searchVault(headings, 'action', '', 20)).map((h) => h.path)).toEqual(['Heading.md', 'Body.md']);
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
			expect(hits[1]!.matched).toEqual(['ai']);
			expect((await searchVault(vault, 'risk', '', 20)).map((h) => h.path)).toEqual(['AI risks.md', 'Plain.md']);
		});

		it('decides word starts from the preceding character', async () => {
			const vault = new MemoryVaultPort({
				'Starts.md': '(ai) and _ai and 🙂ai',
				'Inside.md': 'said 2ai éai 𝒳ai',
			});
			const hits = await searchVault(vault, 'ai', '', 20);
			expect(hits.map((h) => h.path)).toEqual(['Starts.md']);
			expect(weightedMatches(searchFields('Starts', '(ai) and _ai and 🙂ai'), wordStartFinder('ai'))).toBe(3);
		});

		it('matches terms in scripts without spaces between words anywhere', async () => {
			const vault = new MemoryVaultPort({
				'Journal/今天.md': '今天的会议记录',
				'Notes/项目会议.md': '没有内容',
				'Thai.md': 'บันทึกการประชุมโครงการ',
				'Mail.md': 'Send the email again.',
				'学习.md': '我在学习Python编程',
				'工具.md': '使用ai工具',
				'データ.md': 'データベースのsql設計',
			});
			const hits = await searchVault(vault, '会议', '', 20);
			expect(hits.map((h) => h.path)).toEqual(['Notes/项目会议.md', 'Journal/今天.md']);
			const tools = vaultTools(vault);
			const out = await tools.find((t) => t.name === 'search_notes')!.execute({ query: '会议' }, ctx);
			expect(out.content).toContain('今天 (Journal/今天.md)\n  今天的会议记录');
			expect((await searchVault(vault, 'โครงการ', '', 20)).map((h) => h.path)).toEqual(['Thai.md']);
			expect((await searchVault(vault, 'ai', '', 20)).map((h) => h.path)).toEqual(['工具.md']);
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

	describe('full text of the best results', () => {
		function autoReadSetup(autoReadTokens: number, maxReadChars = 20_000) {
			const vault = new MemoryVaultPort({
				'Projects/Nimbus.md': '# Nimbus\n\nNimbus budget: $46,300 remaining.\n',
				'Meetings/Nimbus sync.md': `# Nimbus sync\n\n${'Discussed the nimbus timeline at length. '.repeat(40)}`,
				'Notes/Nimbus idea.md': 'A short nimbus idea.',
				'Notes/Weather.md': 'Nimbus clouds bring rain.',
			});
			const registry = new ToolRegistry();
			for (const t of vaultTools(vault, { maxReadChars, maxSearchResults: 20, autoReadTokens })) registry.register(t);
			return registry.get('search_notes')!;
		}

		it('appends whole notes in rank order within the budget and names the ones left out', async () => {
			const search = autoReadSetup(200);
			expect(search.description).toMatch(/full text of the best matches that fit/);
			const r = await search.execute({ query: 'nimbus budget' }, ctx);
			const [list, rest] = r.content.split('\n\nFull text of ');
			expect(list!.split('\n')[0]).toBe('Nimbus (Projects/Nimbus.md) - matches nimbus, budget');
			expect(rest).toMatch(/^the 3 best matches that fit:\n\n<<<note path="Projects\/Nimbus\.md">>>\n# Nimbus\n\nNimbus budget: \$46,300 remaining\.\n\n<<<end note>>>/);
			// The long meeting note does not fit and less than half of it would, so shorter results after it still get in.
			expect(rest).not.toContain('<<<note path="Meetings/Nimbus sync.md">>>');
			expect(rest).toContain('<<<note path="Notes/Nimbus idea.md">>>');
			expect(rest).toContain('<<<note path="Notes/Weather.md">>>');
			expect(rest).toMatch(/\n\nNot shown in full: Nimbus sync \(Meetings\/Nimbus sync\.md\)\. read_note one of them if the text above does not answer the question\.$/);
		});

		it('lists a result it cannot read right now without an excerpt or its text', async () => {
			const vault = new MemoryVaultPort({ 'A.md': 'nimbus alpha', 'B.md': 'nimbus beta' });
			const registry = new ToolRegistry();
			for (const t of vaultTools(vault, { maxReadChars: 20_000, maxSearchResults: 20, autoReadTokens: 4000 })) registry.register(t);
			const search = registry.get('search_notes')!;
			expect((await search.execute({ query: 'nimbus' }, ctx)).content).toContain('<<<note path="A.md">>>');
			const readNote = vault.readNote.bind(vault);
			vault.readNote = (path) => (path === 'A.md' ? Promise.reject(new Error('busy')) : readNote(path));
			const r = await search.execute({ query: 'nimbus' }, ctx);
			expect(r.isError).toBeFalsy();
			expect(r.content).toContain('A (A.md)\n  (could not be read just now)');
			expect(r.content).toContain('<<<note path="B.md">>>');
			expect(r.content).not.toContain('<<<note path="A.md">>>');
			expect(r.content).toContain('Not shown in full: A (A.md).');
		});

		it('cuts a note that does not fit when at least half of it does', async () => {
			const r = await autoReadSetup(400).execute({ query: 'timeline' }, ctx);
			expect(r.content).toContain('Full text of the best match that fit:');
			expect(r.content).toMatch(/<<<note path="Meetings\/Nimbus sync\.md">>>[\s\S]*\[truncated: showing \d+ of 1655 characters\]\n<<<end note>>>/);
			expect(r.content).toContain('Not shown in full: Nimbus sync (Meetings/Nimbus sync.md, cut).');
		});

		it('keeps the per-note character cap', async () => {
			const r = await autoReadSetup(4000, 100).execute({ query: 'timeline' }, ctx);
			expect(r.content).toContain('[truncated: showing 100 of 1655 characters]');
			expect(r.content).toContain('Not shown in full: Nimbus sync (Meetings/Nimbus sync.md, cut).');
		});

		it('shows excerpts only when the budget is zero or nothing fits', async () => {
			const off = autoReadSetup(0);
			expect(off.description).toMatch(/Excerpts are short: read_note a result before relying on its content/);
			expect((await off.execute({ query: 'nimbus' }, ctx)).content).not.toContain('<<<note');
			expect((await autoReadSetup(30).execute({ query: 'timeline' }, ctx)).content).not.toContain('<<<note');
		});
	});

	it('caps folder listings at 500 entries', async () => {
		const notes: Record<string, string> = {};
		for (let i = 0; i < 520; i++) notes[`Big/${String(i).padStart(3, '0')}.md`] = '';
		const vault = new MemoryVaultPort(notes);
		const registry = new ToolRegistry();
		for (const t of vaultTools(vault)) registry.register(t);
		for (const args of [{ folder: 'Big' }, { folder: 'Big', recursive: true }]) {
			const lines = (await registry.get('list_files')!.execute(args, ctx)).content.split('\n');
			expect(lines).toHaveLength(501);
			expect(lines[499]).toBe('Big/499.md');
			expect(lines[500]).toBe('… 20 more; use search_notes or a subfolder to narrow down');
		}
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
		expect(wrongFolder.isError).toBe(true);
		expect(wrongFolder.content).toContain('A note with that name is in another folder: Projects/Milestones.md.');
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
