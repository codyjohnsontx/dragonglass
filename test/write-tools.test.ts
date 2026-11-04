import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../src/agent/tools';
import { sanitizeConversation } from '../src/persistence/conversation';
import { VaultSearchIndex } from '../src/search/vault-index';
import { createVaultTools, DEFAULT_TOOL_OPTIONS } from '../src/tools/vault-tools';
import { ChangeProposal, ProposalEngine, summarizeBatch } from '../src/vault/proposals';
import { replaceSection } from '../src/vault/sections';
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
	return { vault, engine, call };
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

	it('replaces the last section to the end of the note and keeps its final newline', () => {
		expect(replaceSection('# A\nold\n', 'A', 'new')).toBe('# A\nnew\n');
		expect(replaceSection('# A\nold', 'A', 'new')).toBe('# A\nnew');
		expect(replaceSection(SCRIPT, '## Act Three', 'Finale.')).toMatch(/## Act Three\n\nFinale\.\n$/);
	});

	it('does not repeat the heading when the content starts with it', () => {
		expect(replaceSection('# A\n\nold\n\n# B\n', 'A', '# A\n\nnew\n')).toBe('# A\n\nnew\n\n# B\n');
	});

	it('refuses a missing heading and names the headings there are', () => {
		expect(() => replaceSection(SCRIPT, 'Act Four', 'x')).toThrow(/No heading "Act Four" in the note\. Its headings are: # Sequel; ## Act One; ### Notes/);
		expect(() => replaceSection('plain text', 'Intro', 'x')).toThrow(/The note has no headings/);
	});

	it('refuses an ambiguous heading and resolves it by the heading above it or by level', () => {
		expect(() => replaceSection(SCRIPT, 'Notes', 'x')).toThrow(/appears 2 times: ### Notes under "Sequel > Act One"; ### Notes under "Sequel > Act Two"/);
		const out = replaceSection(SCRIPT, 'Act Two > Notes', 'Fresh notes.');
		expect(out).toContain('### Notes\n\nFresh notes.\n\n## Act Three');
		expect(out).toContain('Act one notes.');
		expect(() => replaceSection(SCRIPT, '#### Notes', 'x')).toThrow(/No heading/);
		expect(replaceSection(SCRIPT, 'act one', 'Rewritten.')).toContain('## Act One\n\nRewritten.\n\n## Act Two');
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

	it('refuses changes that change nothing, bad arguments, missing notes and placeholders', async () => {
		const { call } = setup({ 'A.md': NOTE });
		const same = await call('propose_update_frontmatter', { path: 'A.md', summary: 's', set: [{ key: 'status', value: 'draft' }], remove: ['nope'] });
		expect(same.content).toMatch(/makes no changes/);
		expect((await call('propose_update_frontmatter', { path: 'A.md', summary: 's' })).content).toMatch(/at least one property/);
		expect((await call('propose_update_frontmatter', { path: 'A.md', summary: 's', set: [{ key: 'x', value: 'a', values: ['b'] }] })).content).toMatch(/exactly one of/);
		expect((await call('propose_update_frontmatter', { path: 'A.md', summary: 's', set: [{ key: 'x', value: 'a' }, { key: 'x', value: 'b' }] })).content).toMatch(/more than once/);
		expect((await call('propose_update_frontmatter', { path: 'A.md', summary: 's', set: [{ key: 'position', value: 'a' }] })).content).toMatch(/not a property name/);
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
		expect(create.content).toMatch(/Gate\.md already has a pending proposal in this turn\. Wait until the user has reviewed it/);
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

	it('removes a folder the move created when it is undone, unless something else is in it now', async () => {
		const { vault, engine, call } = setup(FILES);
		const p = (await call('propose_move_note', { path: 'Notes.md', new_path: 'Archive/Old/Notes.md', summary: 's' })).proposal!;
		await engine.apply(p);
		expect(p.createdFolder).toBe('Archive');
		await engine.revert(p);
		expect(vault.exists('Archive')).toBe(false);
		expect(vault.trashedFolders).toEqual(['Archive']);

		engine.reject(p);
		const q = (await call('propose_move_note', { path: 'Script/Act One.md', new_path: 'Archive/Act One.md', summary: 's' })).proposal!;
		await engine.apply(q);
		vault.seed('Archive/Kept.md', 'mine');
		await engine.revert(q);
		expect(vault.exists('Archive/Kept.md')).toBe(true);
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
