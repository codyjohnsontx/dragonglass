import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../src/agent/tools';
import { sanitizeConversation } from '../src/persistence/conversation';
import { VaultSearchIndex } from '../src/search/vault-index';
import { createVaultTools, DEFAULT_TOOL_OPTIONS } from '../src/tools/vault-tools';
import { parentFolder } from '../src/vault/paths';
import { ChangeProposal, ProposalEngine, summarizeBatch } from '../src/vault/proposals';
import { replaceSection } from '../src/vault/sections';
import { parseToolArguments } from '../src/agent/tools';
import { toGeminiSchema } from '../src/providers/gemini';
import { MemoryVaultPort } from './memory-vault';

const ctx = { conversationId: 'c1', signal: new AbortController().signal };

function setup(files: Record<string, string>) {
	const vault = new MemoryVaultPort(files);
	let t = 1000;
	let n = 0;
	const engine = new ProposalEngine(vault, () => ++t, () => `p${++n}`);
	const registry = new ToolRegistry();
	for (const tool of createVaultTools(vault, engine, DEFAULT_TOOL_OPTIONS, new VaultSearchIndex(vault, () => Promise.resolve()))) registry.register(tool);
	const call = async (name: string, args: Record<string, unknown>) => registry.get(name)!.execute(args, ctx);
	return { vault, engine, call, registry };
}

const SCRIPT = [
	'---',
	'status: draft',
	'---',
	'# Sequel',
	'',
	'## Act One',
	'',
	'The gate falls.',
	'',
	'### Notes',
	'',
	'Act one notes.',
	'',
	'## Act Two',
	'',
	'Old act two.',
	'',
	'### Notes',
	'',
	'Act two notes.',
	'',
	'```',
	'# not a heading',
	'```',
	'',
	'## Act Three',
	'',
	'The end.',
	'',
].join('\n');

describe('replace_section', () => {
	it('replaces a section up to the next heading of the same or higher level, subheadings included', () => {
		const out = replaceSection(SCRIPT, 'Act Two', 'New act two.');
		expect(out).toContain('## Act Two\n\nNew act two.\n\n## Act Three');
		expect(out).not.toContain('Act two notes.');
		expect(out).not.toContain('# not a heading');
		expect(out).toContain('Act one notes.');
	});

	it('ignores headings inside code blocks and the frontmatter', () => {
		expect(() => replaceSection(SCRIPT, 'not a heading', 'x')).toThrow(/No heading "not a heading"/);
		expect(() => replaceSection('---\n# fake: 1\n---\n# Real\n', 'fake: 1', 'x')).toThrow(/No heading/);
	});

	it('keeps later sections when a line only looks like a code fence', () => {
		const rest = '\n\n# Act Two\n\nkeep me\n';
		expect(replaceSection(`# Act One\n\nold\n\n\`\`\`x\`\`\` is the password${rest}`, 'Act One', 'new')).toBe(`# Act One\n\nnew${rest}`);
		expect(replaceSection(`# Act One\n\n\`\`\`\n\`\`\`js\n# not a heading\n\`\`\`${rest}`, 'Act One', 'new')).toBe(`# Act One\n\nnew${rest}`);
		expect(replaceSection(`# Act One\n\n~~~ \`x\`\n# not a heading\n~~~~${rest}`, 'Act One', 'new')).toBe(`# Act One\n\nnew${rest}`);
		expect(replaceSection(`# Act One\r\n\r\nold\r\n\r\n\`\`\`x\`\`\` y\r\n\r\n# Act Two\r\n\r\nkeep me\r\n`, 'Act One', 'new')).toContain('# Act Two\r\n\r\nkeep me\r\n');
		expect(() => replaceSection('# A\n\n```\n```js\n# not a heading\n```\n', 'not a heading', 'x')).toThrow(/No heading/);
	});

	it('keeps later sections after a fence opened on a list line or indented inside a list item', () => {
		const rest = '\n\n# Act Two\n\nkeep me\n';
		for (const body of ['- ```\n  code\n  ```', '1. ```js\n   code\n   ```', '- ~~~\n  code\n  ~~~', '- a\n  - ```\n    code\n    ```', '- ```\n  unclosed', '- ```\n  a\n  ```\n\nold\n\n- ```\n  b\n  ```']) {
			expect(replaceSection(`# Act One\n\n${body}${rest}`, 'Act One', 'new')).toBe(`# Act One\n\nnew${rest}`);
		}
		expect(replaceSection(`# Act One\n\n- \`\`\`\n  # not a heading\n\n  more\n  \`\`\`${rest}`, 'Act One', 'new')).toBe(`# Act One\n\nnew${rest}`);
		expect(replaceSection('# A\n\n```\n    ```\n# not a heading\n```\n\n# B\n', 'A', 'new')).toBe('# A\n\nnew\n\n# B\n');
	});

	it('finds an underlined heading under text a list marker cannot interrupt, and not under a rule', () => {
		expect(replaceSection('## B\n\nIn the year\n1986. It fell\n---\n\nkeep\n\n## C\n', 'B', 'new')).toBe('## B\n\nnew\n\nIn the year\n1986. It fell\n---\n\nkeep\n\n## C\n');
		expect(replaceSection('## B\n\nold\n\nThe gate\n* \n---\n\nkeep\n', 'B', 'new')).toBe('## B\n\nnew\n\nThe gate\n* \n---\n\nkeep\n');
		expect(replaceSection('## B\n\n***\nThe gate\n---\n\nold\n', 'The gate', 'new')).toBe('## B\n\n***\nThe gate\n---\n\nnew\n');
		expect(replaceSection('## B\n\n___\nThe gate\n---\n\nold\n', 'The gate', 'new')).toBe('## B\n\n___\nThe gate\n---\n\nnew\n');
		expect(replaceSection('## B\n\nold\n\n2. item\n---\n\nmore\n', 'B', 'new')).toBe('## B\n\nnew\n');
		expect(replaceSection('## B\n\nThe gate\n1. item\n---\n\nmore\n', 'B', 'new')).toBe('## B\n\nnew\n');
	});

	it('keeps a plain indented fence open through less indented lines', () => {
		for (const indent of [' ', '  ', '   ']) {
			const note = `# A\n\n${indent}\`\`\`\nrm x\n# remove cache\nrm y\n${indent}\`\`\`\n\nold\n\n# B\n\nkeep\n`;
			expect(replaceSection(note, 'A', 'new')).toBe('# A\n\nnew\n\n# B\n\nkeep\n');
			expect(() => replaceSection(note, 'remove cache', 'x')).toThrow(/No heading/);
		}
	});

	it('ends a section at indented, empty and underlined headings', () => {
		for (const next of ['   # B', '## ', '##', '## ##', 'B\n===', 'B\n---', 'Two lines\nof title\n---', 'Two lines\n    run on\n---']) {
			expect(replaceSection(`## A\n\nold\n\n${next}\n\nkeep me\n`, 'A', 'new')).toBe(`## A\n\nnew\n\n${next}\n\nkeep me\n`);
		}
		expect(replaceSection('# A\n\nold\n\n## B\n---\n\nC\n---\n\nsub\n\nD\n=\n\nkeep me\n', 'A', 'new')).toBe('# A\n\nnew\n\nD\n=\n\nkeep me\n');
	});

	it('does not end a section at text that is not a heading', () => {
		for (const body of ['old\n\n---\n\nmore', '- item\n---\n\nmore', '> quote\n---\n\nmore', '    # indented code\n\nmore', '    code\n---\n\nmore', '#hashtag\n\n####### seven']) {
			expect(replaceSection(`## A\n\n${body}\n`, 'A', 'new')).toBe('## A\n\nnew\n');
		}
	});

	it('rewrites under an underlined heading, keeping its underline', () => {
		expect(replaceSection('Act One\n===\n\nold\n\nAct Two\n===\n', 'Act One', 'new')).toBe('Act One\n===\n\nnew\n\nAct Two\n===\n');
		expect(replaceSection('Two lines\nof title\n---\nold\n', 'Two lines of title', 'new')).toBe('Two lines\nof title\n---\nnew\n');
	});

	it('reads a very long line of list markers without stalling', () => {
		const line = '-  '.repeat(5000);
		expect(replaceSection(`# A\n\n${line}\n\n# B\n`, 'A', 'new')).toBe('# A\n\nnew\n\n# B\n');
	});

	it('cannot name an empty heading, and leaves it out of the headings it lists', () => {
		expect(() => replaceSection('## \n\nold\n', '', 'x')).toThrow(/needs the text of a heading/);
		expect(() => replaceSection('# A\n\n## \n\n### B\n', 'Nope', 'x')).toThrow(/Its headings are: # A; ### B\./);
		expect(() => replaceSection('# A\n\n## \n\n### B\n\n# C\n\n### B\n', 'B', 'x')).toThrow(/### B under "A"; ### B under "C"/);
	});

	it('replaces the last section to the end of the note and keeps its final newline', () => {
		expect(replaceSection('# A\nold\n', 'A', 'new')).toBe('# A\nnew\n');
		expect(replaceSection('# A\nold', 'A', 'new')).toBe('# A\nnew');
		expect(replaceSection(SCRIPT, 'Act Three', 'Finale.')).toMatch(/## Act Three\n\nFinale\.\n$/);
	});

	it('takes content as the section body only, keeping a first line that repeats the heading', () => {
		expect(replaceSection('# A\n\nold\n\n# B\n', 'A', '# A\n\nnew\n')).toBe('# A\n\n# A\n\nnew\n\n# B\n');
	});

	it('matches the heading text exactly: case-sensitive, without #s', () => {
		expect(() => replaceSection(SCRIPT, 'act one', 'x')).toThrow(/No heading "act one" in the note\..*without the #s/);
		expect(() => replaceSection(SCRIPT, '## Act One', 'x')).toThrow(/No heading "## Act One"/);
		expect(replaceSection(SCRIPT, '  Act One  ', 'Rewritten.')).toContain('## Act One\n\nRewritten.\n\n## Act Two');
		const twoCases = '# Gate\n\nupper\n\n# gate\n\nlower\n';
		expect(replaceSection(twoCases, 'gate', 'new')).toBe('# Gate\n\nupper\n\n# gate\n\nnew\n');
	});

	it('names a heading containing > by its exact text before reading > as a path', () => {
		const note = '# Gate\n\n## Road\n\nunder gate\n\n# Gate > Road\n\nold\n\n# Far >\n\nfar\n';
		expect(replaceSection(note, 'Gate > Road', 'new')).toBe('# Gate\n\n## Road\n\nunder gate\n\n# Gate > Road\n\nnew\n\n# Far >\n\nfar\n');
		expect(replaceSection(note, 'Far >', 'near')).toContain('# Far >\n\nnear\n');
		expect(replaceSection('# Gate\n\n## Road\n\nold\n', 'Gate > Road', 'new')).toBe('# Gate\n\n## Road\n\nnew\n');
		expect(() => replaceSection(note, 'Nope >', 'x')).toThrow(/needs the text of a heading/);
	});

	it('refuses a missing heading and names the headings there are', () => {
		expect(() => replaceSection(SCRIPT, 'Act Four', 'x')).toThrow(/No heading "Act Four" in the note\. Its headings are: # Sequel; ## Act One; ### Notes/);
		expect(() => replaceSection('plain text', 'Intro', 'x')).toThrow(/The note has no headings/);
	});

	it('refuses an ambiguous heading and resolves it by the heading above it', () => {
		expect(() => replaceSection(SCRIPT, 'Notes', 'x')).toThrow(/appears 2 times: ### Notes under "Sequel > Act One"; ### Notes under "Sequel > Act Two"/);
		const out = replaceSection(SCRIPT, 'Act Two > Notes', 'Fresh notes.');
		expect(out).toContain('### Notes\n\nFresh notes.\n\n## Act Three');
		expect(out).toContain('Act one notes.');
		expect(() => replaceSection(SCRIPT, 'act two > Notes', 'x')).toThrow(/No heading/);
	});

	it('is proposed through propose_edit_note, reviewed as a diff, and goes stale when the note changes', async () => {
		const { vault, engine, call } = setup({ 'Script.md': SCRIPT });
		const result = await call('propose_edit_note', {
			path: 'Script.md',
			summary: 'Rewrite act two',
			edits: [{ type: 'replace_section', heading: 'Act Two', content: 'New act two.' }],
		});
		const p = result.proposal!;
		expect(p.kind).toBe('edit');
		expect(engine.stats(p).removed).toBeGreaterThan(0);
		vault.seed('Script.md', `${SCRIPT}More.\n`);
		await expect(engine.apply(p)).rejects.toThrow(/changed after this proposal/);
		expect(p.status).toBe('stale');
		engine.reject(p);

		const ambiguous = await call('propose_edit_note', { path: 'Script.md', summary: 's', edits: [{ type: 'replace_section', heading: 'Notes', content: 'x' }] });
		expect(ambiguous.isError).toBe(true);
		expect(ambiguous.content).toMatch(/appears 2 times/);
		const bad = await call('propose_edit_note', { path: 'Script.md', summary: 's', edits: [{ type: 'replace_section', content: 'x' }] });
		expect(bad.content).toMatch(/replace_section needs string "heading" and "content"/);
	});
});

describe('propose_update_frontmatter', () => {
	const NOTE = '---\nstatus: draft\nact: 2\npublished: false\ntags:\n  - lore\n---\n# Ashen Gate\n\nBody.\n';

	it('reviews each property as old and new value and writes through processFrontMatter', async () => {
		const { vault, engine, call } = setup({ 'Lore/Ashen Gate.md': NOTE });
		const result = await call('propose_update_frontmatter', {
			path: 'Lore/Ashen Gate.md',
			summary: 'Mark final',
			set: [
				{ key: 'status', value: 'final' },
				{ key: 'act', value: '3' },
				{ key: 'published', value: 'true' },
				{ key: 'tags', values: ['lore', 'gate'] },
				{ key: 'era', value: 'Second Age' },
			],
		});
		expect(result.isError).toBeUndefined();
		const p = result.proposal!;
		expect(p.kind).toBe('frontmatter');
		expect(p.properties).toEqual([
			{ key: 'status', before: 'draft', after: 'final' },
			{ key: 'act', before: 2, after: 3 },
			{ key: 'published', before: false, after: true },
			{ key: 'tags', before: ['lore'], after: ['lore', 'gate'] },
			{ key: 'era', after: 'Second Age' },
		]);
		expect(engine.diff(p).map((l) => `${l.op} ${l.text}`)).toEqual([
			'del status: draft',
			'add status: final',
			'del act: 2',
			'add act: 3',
			'del published: false',
			'add published: true',
			'del tags: [lore]',
			'add tags: [lore, gate]',
			'add era: Second Age',
		]);
		expect(vault.files.get('Lore/Ashen Gate.md')).toBe(NOTE);

		await engine.apply(p);
		const written = vault.files.get('Lore/Ashen Gate.md')!;
		expect(written).toBe('---\nstatus: final\nact: 3\npublished: true\ntags:\n  - lore\n  - gate\nera: Second Age\n---\n# Ashen Gate\n\nBody.\n');
		expect(p.after).toBe(written);

		await engine.revert(p);
		expect(vault.files.get('Lore/Ashen Gate.md')).toBe(NOTE);
	});

	it('removes properties and adds frontmatter to a note without any', async () => {
		const { vault, engine, call } = setup({ 'A.md': NOTE, 'B.md': '# B\n' });
		const removed = (await call('propose_update_frontmatter', { path: 'A.md', summary: 's', remove: ['tags', 'missing'] })).proposal!;
		expect(removed.properties).toEqual([{ key: 'tags', before: ['lore'] }]);
		await engine.apply(removed);
		expect(vault.files.get('A.md')).not.toContain('tags');
		const added = (await call('propose_update_frontmatter', { path: 'B.md', summary: 's', set: [{ key: 'status', value: 'idea' }] })).proposal!;
		await engine.apply(added);
		expect(vault.files.get('B.md')).toBe('---\nstatus: idea\n---\n# B\n');
	});

	it('writes numbers and booleans as given, and takes a new property given as text as text whatever other notes hold', async () => {
		const { vault, engine, call } = setup({ 'Act One.md': NOTE, 'Act Two.md': '# Act Two\n', 'Act Three.md': '# Act Three\n' });
		const p = (
			await call('propose_update_frontmatter', {
				path: 'Act Two.md',
				summary: 's',
				set: [
					{ key: 'act', value: 2 },
					{ key: 'published', value: false },
					{ key: 'rating', value: '4' },
				],
			})
		).proposal!;
		expect(p.properties).toEqual([
			{ key: 'act', after: 2 },
			{ key: 'published', after: false },
			{ key: 'rating', after: '4' },
		]);
		await engine.apply(p);
		expect(vault.getMetadata('Act Two.md')?.frontmatter).toEqual({ act: 2, published: false, rating: '4' });

		const held = (await call('propose_update_frontmatter', { path: 'Act Three.md', summary: 's', set: [{ key: 'act', value: '3' }, { key: 'published', value: 'true' }] })).proposal!;
		expect(held.properties).toEqual([
			{ key: 'act', after: '3' },
			{ key: 'published', after: 'true' },
		]);
	});

	it('accepts a string, number or boolean value in the tool arguments, and nothing else', () => {
		const { registry } = setup({});
		const tool = registry.get('propose_update_frontmatter')!;
		const args = (value: unknown) => JSON.stringify({ path: 'A.md', summary: 's', set: [{ key: 'k', value }] });
		for (const value of ['final', 3, 2.5, 0, true, false]) expect(parseToolArguments(tool, args(value))).toMatchObject({ set: [{ key: 'k', value }] });
		for (const value of [null, { a: 1 }, ['x']]) expect(() => parseToolArguments(tool, args(value))).toThrow(/"set\[0\]\.value" must be one of string, number, boolean/);
		const set = toGeminiSchema(tool.parameters)['properties'] as { set: { items: { properties: { value: unknown } } } };
		expect(set.set.items.properties.value).toEqual({ anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }] });
	});

	it('refuses a property change to a note whose text change is waiting, telling the model to ask the user to review it', async () => {
		const { call } = setup({ 'Act Two.md': NOTE });
		expect((await call('propose_edit_note', { path: 'Act Two.md', summary: 's', edits: [{ type: 'append', content: 'Gate scene.' }] })).isError).toBeUndefined();
		const props = await call('propose_update_frontmatter', { path: 'Act Two.md', summary: 's', set: [{ key: 'status', value: 'final' }] });
		expect(props.isError).toBe(true);
		expect(props.content).toBe(
			'Error: Act Two.md already has a pending proposal in this turn. It is waiting for the user to review. Ask the user to approve or reject it first, then propose this change; the user reviews one card per note. Nothing was proposed.',
		);
		const edit = await call('propose_edit_note', { path: 'Act Two.md', summary: 's', edits: [{ type: 'append', content: 'More.' }] });
		expect(edit.content).toMatch(/Put every change to the note text in a single propose_edit_note call/);
	});

	it('gives the right refusal hint for every pairing of a pending proposal and a new one on the same path', async () => {
		const combined: Record<string, string> = {
			'edit/edit': 'Put every change to the note text in a single propose_edit_note call (several edits in one call)',
			'frontmatter/frontmatter': 'Put every property change to the note in a single propose_update_frontmatter call (set and remove take several properties)',
		};
		const waiting = 'It is waiting for the user to review. Ask the user to approve or reject it first, then propose this change';
		const earlier: Record<string, { path: string; tool: string; args: Record<string, unknown> }> = {
			create: { path: 'New.md', tool: 'propose_create_note', args: { content: '# New\n' } },
			edit: { path: 'Act Two.md', tool: 'propose_edit_note', args: { edits: [{ type: 'append', content: 'Scene.' }] } },
			frontmatter: { path: 'Act Two.md', tool: 'propose_update_frontmatter', args: { set: [{ key: 'status', value: 'final' }] } },
			move: { path: 'Act Two.md', tool: 'propose_move_note', args: { new_path: 'Acts/Act Two.md' } },
			folder: { path: 'Factions', tool: 'propose_create_folder', args: {} },
		};
		const next: Record<string, (path: string) => [string, Record<string, unknown>]> = {
			create: (path) => ['propose_create_note', { path, content: 'x' }],
			edit: (path) => ['propose_edit_note', { path, edits: [{ type: 'append', content: 'More.' }] }],
			frontmatter: (path) => ['propose_update_frontmatter', { path, set: [{ key: 'act', value: '2' }] }],
			move: (path) => ['propose_move_note', { path, new_path: 'Elsewhere.md' }],
			folder: (path) => ['propose_create_folder', { path }],
		};
		for (const [first, e] of Object.entries(earlier)) {
			for (const [second, make] of Object.entries(next)) {
				const { call } = setup({ 'Act Two.md': NOTE });
				expect((await call(e.tool, { path: e.path, summary: 's', ...e.args })).isError, `${first} proposed`).toBeUndefined();
				const [tool, args] = make(e.path);
				const refused = await call(tool, { ...args, summary: 's' });
				expect(refused.content, `${first}/${second}`).toBe(
					`Error: ${e.path} already has a pending proposal in this turn. ${combined[`${first}/${second}`] ?? waiting}; the user reviews one card per note. Nothing was proposed.`,
				);
			}
		}
	});

	it('changes a property named position like any other, and reverts it', async () => {
		const note = '---\nposition: Warden of the Gate\n---\n# Kael\n';
		const { vault, engine, call } = setup({ 'Kael.md': note });
		const p = (await call('propose_update_frontmatter', { path: 'Kael.md', summary: 's', set: [{ key: 'position', value: 'Keeper of the Ember' }] })).proposal!;
		expect(p.properties).toEqual([{ key: 'position', before: 'Warden of the Gate', after: 'Keeper of the Ember' }]);
		await engine.apply(p);
		expect(vault.files.get('Kael.md')).toBe('---\nposition: Keeper of the Ember\n---\n# Kael\n');
		await engine.revert(p);
		expect(vault.files.get('Kael.md')).toBe(note);
	});

	it('refuses changes that change nothing, bad arguments, missing notes and placeholders', async () => {
		const { call } = setup({ 'A.md': NOTE });
		const same = await call('propose_update_frontmatter', { path: 'A.md', summary: 's', set: [{ key: 'status', value: 'draft' }], remove: ['nope'] });
		expect(same.content).toMatch(/makes no changes/);
		expect((await call('propose_update_frontmatter', { path: 'A.md', summary: 's' })).content).toMatch(/at least one property/);
		expect((await call('propose_update_frontmatter', { path: 'A.md', summary: 's', set: [{ key: 'x', value: 'a', values: ['b'] }] })).content).toMatch(/exactly one of/);
		expect((await call('propose_update_frontmatter', { path: 'A.md', summary: 's', set: [{ key: 'x', value: 'a' }, { key: 'x', value: 'b' }] })).content).toMatch(/more than once/);
		expect((await call('propose_update_frontmatter', { path: 'A.md', summary: 's', set: [{ key: 'a\nb', value: 'a' }] })).content).toMatch(/not a property name/);
		expect((await call('propose_update_frontmatter', { path: 'Nope.md', summary: 's', set: [{ key: 'x', value: 'a' }] })).content).toMatch(/No note found/);
		expect((await call('propose_update_frontmatter', { path: 'A.md', summary: 's', set: [{ key: 'x', value: '[Insert era]' }] })).content).toMatch(/placeholder/);
	});

	it('goes stale when the note changes, and the guard inside the write refuses a property that changed', async () => {
		const { vault, engine, call } = setup({ 'A.md': NOTE });
		const p = (await call('propose_update_frontmatter', { path: 'A.md', summary: 's', set: [{ key: 'status', value: 'final' }] })).proposal!;
		vault.seed('A.md', NOTE.replace('Body.', 'Edited.'));
		await expect(engine.apply(p)).rejects.toThrow(/changed after this proposal/);
		expect(p.status).toBe('stale');
		engine.reject(p);

		vault.seed('A.md', NOTE);
		const q = (await call('propose_update_frontmatter', { path: 'A.md', summary: 's2', set: [{ key: 'act', value: '4' }] })).proposal!;
		// The note changes between the hash check and Obsidian's write.
		const original = vault.processFrontMatter.bind(vault);
		vault.processFrontMatter = (path, fn) => {
			vault.files.set(path, NOTE.replace('act: 2', 'act: 5'));
			return original(path, fn);
		};
		await expect(engine.apply(q)).rejects.toThrow(/changed while applying/);
		expect(q.status).toBe('stale');
		expect(vault.files.get('A.md')).toContain('act: 5');
	});
});

describe('propose_move_note', () => {
	const FILES = {
		'Lore/Ashen Gate.md': '# Ashen Gate\n',
		'Script/Act One.md': 'The [[Ashen Gate]] falls.\n',
		'Script/Act Two.md': 'Back at [[Lore/Ashen Gate|the gate]].\n',
		'Notes.md': 'Nothing linked.\n',
	};

	it('renames a note, lists the notes whose links change, updates them on approval, and moves back on revert', async () => {
		const { vault, engine, call } = setup(FILES);
		const result = await call('propose_move_note', { path: 'Lore/Ashen Gate.md', new_path: 'Lore/The Ashen Gate.md', summary: 'Full name' });
		const p = result.proposal!;
		expect(p.kind).toBe('move');
		expect(p.before).toBeNull();
		expect(p.after).toBe('');
		expect(p.linkUpdates).toEqual(['Script/Act One.md', 'Script/Act Two.md']);
		expect(result.content).toMatch(/Obsidian updates the links to it in 2 other notes/);
		expect(vault.exists('Lore/Ashen Gate.md')).toBe(true);

		await engine.apply(p);
		expect(vault.exists('Lore/Ashen Gate.md')).toBe(false);
		expect(vault.files.get('Lore/The Ashen Gate.md')).toBe('# Ashen Gate\n');
		expect(vault.files.get('Script/Act One.md')).toBe('The [[The Ashen Gate]] falls.\n');

		await engine.revert(p);
		expect(p.status).toBe('reverted');
		expect(vault.exists('Lore/The Ashen Gate.md')).toBe(false);
		expect(vault.files.get('Script/Act One.md')).toBe('The [[Ashen Gate]] falls.\n');
	});

	it('lists only links written as paths when a note moves folder and keeps its name', async () => {
		const { vault, engine, call } = setup(FILES);
		const p = (await call('propose_move_note', { path: 'Lore/Ashen Gate.md', new_path: 'Places/Ashen Gate.md', summary: 's' })).proposal!;
		expect(p.linkUpdates).toEqual(['Script/Act Two.md']);
		await engine.apply(p);
		expect(vault.isFolder('Places')).toBe(true);
		expect(vault.exists('Places/Ashen Gate.md')).toBe(true);
	});

	it('refuses a taken destination, the same path, a missing note, and a second claim on either path this turn', async () => {
		const { call } = setup(FILES);
		expect((await call('propose_move_note', { path: 'Lore/Ashen Gate.md', new_path: 'Notes.md', summary: 's' })).content).toMatch(/already exists at Notes\.md/);
		expect((await call('propose_move_note', { path: 'Lore/Ashen Gate.md', new_path: 'Lore/Ashen Gate.md', summary: 's' })).content).toMatch(/same as the current/);
		expect((await call('propose_move_note', { path: 'Nope.md', new_path: 'X.md', summary: 's' })).content).toMatch(/No note found/);
		expect((await call('propose_move_note', { path: 'Lore/Ashen Gate.md', new_path: 'Gate.md', summary: 's' })).isError).toBeUndefined();
		const create = await call('propose_create_note', { path: 'Gate.md', content: 'x', summary: 's' });
		expect(create.content).toMatch(/Gate\.md already has a pending proposal in this turn\. It is waiting for the user to review\. Ask the user to approve or reject it first/);
		expect((await call('propose_edit_note', { path: 'Lore/Ashen Gate.md', summary: 's', edits: [{ type: 'append', content: 'x' }] })).isError).toBe(true);
	});

	it('fails on approval when the destination was taken or the note is gone', async () => {
		const { vault, engine, call } = setup(FILES);
		const p = (await call('propose_move_note', { path: 'Lore/Ashen Gate.md', new_path: 'Gate.md', summary: 's' })).proposal!;
		vault.seed('Gate.md', 'mine');
		await expect(engine.apply(p)).rejects.toThrow(/already exists at Gate\.md/);
		expect(p.status).toBe('failed');
		const q = (await call('propose_move_note', { path: 'Script/Act One.md', new_path: 'One.md', summary: 's' })).proposal!;
		vault.delete('Script/Act One.md');
		await expect(engine.apply(q)).rejects.toThrow(/no longer exists/);
	});

	it('leaves a folder the move created when it is undone, as any created folder is left', async () => {
		const { vault, engine, call } = setup(FILES);
		const p = (await call('propose_move_note', { path: 'Notes.md', new_path: 'Archive/Old/Notes.md', summary: 's' })).proposal!;
		await engine.apply(p);
		await engine.revert(p);
		expect(vault.files.get('Notes.md')).toBe('Nothing linked.\n');
		expect(vault.isFolder('Archive/Old')).toBe(true);

		const q = (await call('propose_move_note', { path: 'Script/Act One.md', new_path: 'Filed/Act One.md', summary: 's' })).proposal!;
		await engine.applyAll([q]);
		await engine.revertAll([q]);
		expect(vault.exists('Script/Act One.md')).toBe(true);
		expect(vault.isFolder('Filed')).toBe(true);
		expect(vault.trashedFolders).toEqual([]);
	});

	it('will not move back over a file now at the old path', async () => {
		const { vault, engine, call } = setup(FILES);
		const p = (await call('propose_move_note', { path: 'Notes.md', new_path: 'Old Notes.md', summary: 's' })).proposal!;
		await engine.apply(p);
		vault.seed('Notes.md', 'new');
		await expect(engine.revert(p)).rejects.toThrow(/A file now exists at Notes\.md/);
		expect(vault.files.get('Old Notes.md')).toBe('Nothing linked.\n');
	});
});

describe('propose_create_folder', () => {
	it('creates the folder on approval and says it cannot be reverted', async () => {
		const { vault, engine, call } = setup({ 'A.md': 'a' });
		const result = await call('propose_create_folder', { path: 'Lore/Factions', summary: 'For faction notes' });
		const p = result.proposal!;
		expect(p.kind).toBe('folder');
		expect(vault.exists('Lore/Factions')).toBe(false);
		await engine.apply(p);
		expect(vault.isFolder('Lore/Factions')).toBe(true);
		await expect(engine.revert(p)).rejects.toThrow(/Created folders are not deleted automatically/);
	});

	it('refuses an existing folder or file, a note path, and goes failed when the folder appears first', async () => {
		const { vault, engine, call } = setup({ 'Lore/A.md': 'a' });
		expect((await call('propose_create_folder', { path: 'Lore', summary: 's' })).content).toMatch(/The folder Lore already exists/);
		expect((await call('propose_create_folder', { path: 'Lore/A.md', summary: 's' })).content).toMatch(/looks like a note/);
		expect((await call('propose_create_folder', { path: '.obsidian/x', summary: 's' })).isError).toBe(true);
		const p = (await call('propose_create_folder', { path: 'Places', summary: 's' })).proposal!;
		await vault.createFolder('Places');
		await expect(engine.apply(p)).rejects.toThrow(/already exists at Places/);
		expect(p.status).toBe('failed');
	});
});

describe('batches with the new kinds', () => {
	it('applies folders first and moves last, so a note goes into a new folder and an edit to a linking note still applies', async () => {
		const { vault, engine, call } = setup({ 'Lore/Gate.md': '# Gate\n', 'Act.md': 'See [[Gate]].\n' });
		const move = (await call('propose_move_note', { path: 'Lore/Gate.md', new_path: 'Lore/Ashen Gate.md', summary: 's' })).proposal!;
		const edit = (await call('propose_edit_note', { path: 'Act.md', summary: 's', edits: [{ type: 'append', content: 'More.' }] })).proposal!;
		const note = (await call('propose_create_note', { path: 'Factions/Wardens.md', content: '# Wardens\n', summary: 's' })).proposal!;
		const folder = (await call('propose_create_folder', { path: 'Factions', summary: 's' })).proposal!;
		const batch = [move, edit, note, folder];

		expect(await engine.applyAll(batch)).toEqual(batch);
		expect(vault.files.get('Act.md')).toBe('See [[Ashen Gate]].\nMore.');
		expect(vault.exists('Factions/Wardens.md')).toBe(true);
		expect(summarizeBatch(batch).applied).toEqual([move, edit, note]);

		// Undo all takes back the move, the edit and the new note; the folder stays.
		vault.seed('Act.md', 'See [[Gate]].\nMore.');
		const undone = await engine.revertAll(batch);
		expect(undone).toEqual([move, edit, note]);
		expect(vault.exists('Lore/Gate.md')).toBe(true);
		expect(vault.files.get('Act.md')).toBe('See [[Gate]].\n');
		expect(vault.exists('Factions/Wardens.md')).toBe(false);
		expect(vault.isFolder('Factions')).toBe(true);
		expect(folder.status).toBe('applied');
	});

	it('rolls back a new folder and a move when a later write fails', async () => {
		const { vault, engine, call } = setup({ 'A.md': 'a', 'B.md': 'b' });
		const folder = (await call('propose_create_folder', { path: 'New', summary: 's' })).proposal!;
		const move = (await call('propose_move_note', { path: 'A.md', new_path: 'New/A.md', summary: 's' })).proposal!;
		const second = (await call('propose_move_note', { path: 'B.md', new_path: 'New/B.md', summary: 's' })).proposal!;
		const original = vault.moveNote.bind(vault);
		vault.moveNote = (from, to) => (from === 'B.md' ? Promise.reject(new Error('disk full')) : original(from, to));
		await expect(engine.applyAll([folder, move, second])).rejects.toThrow(/Applied 2 of 3 changes, then B\.md failed: disk full\. The changes to New and A\.md were rolled back\./);
		expect(vault.exists('A.md')).toBe(true);
		expect(vault.isFolder('New')).toBe(false);
		expect(vault.trashedFolders).toEqual(['New']);
		expect([folder.status, move.status]).toEqual(['pending', 'pending']);
	});

	/** Like Obsidian refusing a file name: the port has made the parent folder by the time the rename fails. */
	function refuseRename(vault: MemoryVaultPort, from: string, before?: () => void): void {
		const original = vault.moveNote.bind(vault);
		vault.moveNote = async (source, to) => {
			if (source !== from) return original(source, to);
			await vault.createFolder(parentFolder(to));
			before?.();
			throw new Error('File name cannot contain any of the following characters: \\ / :');
		};
	}

	it('removes the folders a refused move made, and reports why it failed', async () => {
		const { vault, engine, call } = setup({ 'Notes.md': 'notes' });
		const p = (await call('propose_move_note', { path: 'Notes.md', new_path: 'Archive/Old/Gate: Two.md', summary: 's' })).proposal!;
		refuseRename(vault, 'Notes.md');
		await expect(engine.apply(p)).rejects.toThrow(/File name cannot contain/);
		expect(p.status).toBe('failed');
		expect(p.error).toMatch(/File name cannot contain/);
		expect(vault.exists('Notes.md')).toBe(true);
		expect(vault.isFolder('Archive')).toBe(false);
		expect(vault.trashedFolders).toEqual(['Archive']);
	});

	it('removes the folder an applied move made when a later write fails the batch', async () => {
		const { vault, engine, call } = setup({ 'A.md': 'a', 'B.md': 'b' });
		const move = (await call('propose_move_note', { path: 'A.md', new_path: 'New/Deep/A.md', summary: 's' })).proposal!;
		const second = (await call('propose_move_note', { path: 'B.md', new_path: 'C.md', summary: 's' })).proposal!;
		const moveNote = vault.moveNote.bind(vault);
		vault.moveNote = (from, to) => (from === 'B.md' ? Promise.reject(new Error('disk full')) : moveNote(from, to));
		await expect(engine.applyAll([move, second])).rejects.toThrow(/The change to A\.md was rolled back\./);
		expect(vault.files.get('A.md')).toBe('a');
		expect(vault.isFolder('New')).toBe(false);
		expect(vault.trashedFolders).toEqual(['New']);
		expect(move.status).toBe('pending');
	});

	it('reports a move as rolled back even if the folder it made cannot be removed', async () => {
		const { vault, engine, call } = setup({ 'A.md': 'a', 'B.md': 'b' });
		const move = (await call('propose_move_note', { path: 'A.md', new_path: 'New/A.md', summary: 's' })).proposal!;
		const second = (await call('propose_move_note', { path: 'B.md', new_path: 'C.md', summary: 's' })).proposal!;
		const moveNote = vault.moveNote.bind(vault);
		vault.moveNote = (from, to) => (from === 'B.md' ? Promise.reject(new Error('disk full')) : moveNote(from, to));
		vault.trashFolder = () => Promise.reject(new Error('trash unavailable'));
		await expect(engine.applyAll([move, second])).rejects.toThrow(/The change to A\.md was rolled back\./);
		expect(vault.files.get('A.md')).toBe('a');
		expect(move.status).toBe('pending');
	});

	it('removes the folder a refused move made in a batch, along with what the batch already wrote', async () => {
		const files = { 'A.md': '---\nstatus: draft\n---\nBody.\n', 'B.md': 'b' };
		const { vault, engine, call } = setup(files);
		const props = (await call('propose_update_frontmatter', { path: 'A.md', summary: 's', set: [{ key: 'status', value: 'final' }] })).proposal!;
		const move = (await call('propose_move_note', { path: 'B.md', new_path: 'New/B: Two.md', summary: 's' })).proposal!;
		refuseRename(vault, 'B.md');
		await expect(engine.applyAll([props, move])).rejects.toThrow(/Applied 1 of 2 changes, then B\.md failed: File name cannot contain .*\. The change to A\.md was rolled back\./);
		expect(Object.fromEntries(vault.files)).toEqual(files);
		expect(vault.isFolder('New')).toBe(false);
		expect(vault.trashedFolders).toEqual(['New']);
	});

	it('keeps a folder a refused move made once something else is in it', async () => {
		const { vault, engine, call } = setup({ 'Notes.md': 'notes' });
		const p = (await call('propose_move_note', { path: 'Notes.md', new_path: 'Archive/Gate: Two.md', summary: 's' })).proposal!;
		refuseRename(vault, 'Notes.md', () => vault.seed('Archive/Kept.md', 'mine'));
		await expect(engine.apply(p)).rejects.toThrow(/File name cannot contain/);
		expect(vault.files.get('Archive/Kept.md')).toBe('mine');
		expect(vault.trashedFolders).toEqual([]);
	});

	it('reports why a move failed even if its folder cannot be removed', async () => {
		const { vault, engine, call } = setup({ 'Notes.md': 'notes' });
		const p = (await call('propose_move_note', { path: 'Notes.md', new_path: 'Archive/Gate: Two.md', summary: 's' })).proposal!;
		refuseRename(vault, 'Notes.md');
		vault.trashFolder = () => Promise.reject(new Error('trash unavailable'));
		await expect(engine.apply(p)).rejects.toThrow(/File name cannot contain/);
		expect(p.error).toMatch(/File name cannot contain/);
	});

	it('undoes a batch whose move rewrote links in notes the same batch changed', async () => {
		const files = { 'Lore/Gate.md': '# Gate\n', 'Act One.md': '---\nstatus: draft\n---\nThe [[Gate]] falls.\n', 'Act Two.md': 'At the [[Gate]].\n' };
		const { vault, engine, call } = setup(files);
		const props = (await call('propose_update_frontmatter', { path: 'Act One.md', summary: 's', set: [{ key: 'status', value: 'revised' }] })).proposal!;
		const edit = (await call('propose_edit_note', { path: 'Act Two.md', summary: 's', edits: [{ type: 'append', content: 'Night.' }] })).proposal!;
		const move = (await call('propose_move_note', { path: 'Lore/Gate.md', new_path: 'Lore/Ashen Gate.md', summary: 's' })).proposal!;
		await engine.applyAll([props, edit, move]);
		expect(vault.files.get('Act One.md')).toBe('---\nstatus: revised\n---\nThe [[Ashen Gate]] falls.\n');
		expect(vault.files.get('Act Two.md')).toBe('At the [[Ashen Gate]].\nNight.');

		await engine.revertAll([props, edit, move]);
		expect(Object.fromEntries(vault.files)).toEqual(files);
	});

	it('reverts a property change on its own and keeps what changed elsewhere in the note', async () => {
		const { vault, engine, call } = setup({ 'A.md': '---\nstatus: draft\n---\nBody.\n' });
		const p = (await call('propose_update_frontmatter', { path: 'A.md', summary: 's', set: [{ key: 'status', value: 'final' }] })).proposal!;
		await engine.apply(p);
		vault.seed('A.md', '---\nstatus: final\n---\nBody, edited.\n');
		await engine.revert(p);
		expect(vault.files.get('A.md')).toBe('---\nstatus: draft\n---\nBody, edited.\n');

		const q = (await call('propose_update_frontmatter', { path: 'A.md', summary: 's', set: [{ key: 'status', value: 'final' }] })).proposal!;
		await engine.apply(q);
		vault.seed('A.md', '---\nstatus: abandoned\n---\nBody, edited.\n');
		await expect(engine.revert(q)).rejects.toThrow(/changed after this edit was applied/);
		expect(vault.files.get('A.md')).toContain('status: abandoned');
	});

	it('undoes edits on both sides of a move', async () => {
		const { vault, engine, call } = setup({ 'A.md': 'one' });
		const first = (await call('propose_edit_note', { path: 'A.md', summary: 's', edits: [{ type: 'replace_all', content: 'two' }] })).proposal!;
		await engine.apply(first);
		const move = (await call('propose_move_note', { path: 'A.md', new_path: 'B.md', summary: 's' })).proposal!;
		await engine.apply(move);
		const last = (await call('propose_edit_note', { path: 'B.md', summary: 's', edits: [{ type: 'replace_all', content: 'three' }] })).proposal!;
		await engine.apply(last);
		await engine.revertAll([first, move, last]);
		expect(Object.fromEntries(vault.files)).toEqual({ 'A.md': 'one' });
	});

	it('undoes a property change followed by a move and an edit', async () => {
		const note = '---\nstatus: draft\n---\nBody.\n';
		const { vault, engine, call } = setup({ 'A.md': note });
		const props = (await call('propose_update_frontmatter', { path: 'A.md', summary: 's', set: [{ key: 'status', value: 'final' }] })).proposal!;
		await engine.apply(props);
		const move = (await call('propose_move_note', { path: 'A.md', new_path: 'B.md', summary: 's' })).proposal!;
		await engine.apply(move);
		const edit = (await call('propose_edit_note', { path: 'B.md', summary: 's', edits: [{ type: 'append', content: 'More.' }] })).proposal!;
		await engine.apply(edit);
		await engine.revertAll([props, move, edit]);
		expect(Object.fromEntries(vault.files)).toEqual({ 'A.md': note });
	});

	it('undoes a move whose old path the batch filled with a new note', async () => {
		const { vault, engine, call } = setup({ 'A.md': 'old' });
		const move = (await call('propose_move_note', { path: 'A.md', new_path: 'B.md', summary: 's' })).proposal!;
		await engine.apply(move);
		const created = (await call('propose_create_note', { path: 'A.md', content: 'fresh', summary: 's' })).proposal!;
		await engine.apply(created);
		await engine.revertAll([move, created]);
		expect(Object.fromEntries(vault.files)).toEqual({ 'A.md': 'old' });
	});

	it('undoes a moved note whose properties still hold though its body changed since', async () => {
		const { vault, engine, call } = setup({ 'A.md': '---\nstatus: draft\n---\nBody.\n' });
		const props = (await call('propose_update_frontmatter', { path: 'A.md', summary: 's', set: [{ key: 'status', value: 'final' }] })).proposal!;
		await engine.apply(props);
		const move = (await call('propose_move_note', { path: 'A.md', new_path: 'B.md', summary: 's' })).proposal!;
		await engine.apply(move);
		vault.seed('B.md', '---\nstatus: final\n---\nBody, reworked.\n');
		await engine.revertAll([props, move]);
		expect(Object.fromEntries(vault.files)).toEqual({ 'A.md': '---\nstatus: draft\n---\nBody, reworked.\n' });
	});

	it('undoes an edit to a note that moved before another move rewrote its links', async () => {
		const files = { 'Gate.md': '# Gate\n', 'Act.md': 'At the [[Gate]].\n' };
		const { vault, engine, call } = setup(files);
		const edit = (await call('propose_edit_note', { path: 'Act.md', summary: 's', edits: [{ type: 'append', content: 'Night.' }] })).proposal!;
		await engine.apply(edit);
		const moveAct = (await call('propose_move_note', { path: 'Act.md', new_path: 'Script/Act.md', summary: 's' })).proposal!;
		await engine.apply(moveAct);
		const moveGate = (await call('propose_move_note', { path: 'Gate.md', new_path: 'Ashen Gate.md', summary: 's' })).proposal!;
		await engine.apply(moveGate);
		expect(vault.files.get('Script/Act.md')).toBe('At the [[Ashen Gate]].\nNight.');
		await engine.revertAll([edit, moveAct, moveGate]);
		expect(Object.fromEntries(vault.files)).toEqual(files);
	});

	it('refuses Undo all when a moved note can no longer move back', async () => {
		const { vault, engine, call } = setup({ 'A.md': 'a', 'B.md': 'b' });
		const move = (await call('propose_move_note', { path: 'A.md', new_path: 'C.md', summary: 's' })).proposal!;
		const edit = (await call('propose_edit_note', { path: 'B.md', summary: 's', edits: [{ type: 'append', content: 'x' }] })).proposal!;
		await engine.applyAll([move, edit]);
		vault.seed('A.md', 'taken');
		await expect(engine.revertAll([move, edit])).rejects.toThrow(/Nothing was undone: a file now exists at A\.md/);
		expect(vault.files.get('B.md')).toBe('b\nx');
	});

	it('loads stored proposals of every kind', () => {
		const kinds: ChangeProposal['kind'][] = ['create', 'edit', 'folder', 'move', 'frontmatter'];
		const proposals = Object.fromEntries(kinds.map((kind) => [kind, { id: kind, conversationId: 'c', kind, path: 'A.md', before: null, after: '', baseHash: null, summary: '', status: 'pending', createdAt: 1 }]));
		const conv = sanitizeConversation({ id: 'c', title: 't', createdAt: 1, updatedAt: 1, messages: [], proposals: { ...proposals, bad: { ...proposals['edit'], kind: 'delete' } } });
		expect(Object.keys(conv!.proposals).sort()).toEqual([...kinds].sort());
	});
});
