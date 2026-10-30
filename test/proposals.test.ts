import { describe, expect, it } from 'vitest';
import { applyOperations, ProposalEngine, ProposalError, rejectNewPlaceholders } from '../src/vault/proposals';
import { MemoryVaultPort } from './memory-vault';

function engine(vault: MemoryVaultPort) {
	let t = 1000;
	let n = 0;
	return new ProposalEngine(vault, () => ++t, () => `p${++n}`);
}

describe('applyOperations', () => {
	it('replaces a unique match', () => {
		expect(applyOperations('a b c', [{ type: 'find_replace', find: 'b', replace: 'X' }])).toBe('a X c');
	});
	it('refuses ambiguous matches unless replaceAll', () => {
		expect(() => applyOperations('b b', [{ type: 'find_replace', find: 'b', replace: 'X' }])).toThrow(/more than once/);
		expect(applyOperations('b b', [{ type: 'find_replace', find: 'b', replace: 'X', replaceAll: true }])).toBe('X X');
	});
	it('reports missing text', () => {
		expect(() => applyOperations('abc', [{ type: 'find_replace', find: 'zzz', replace: '' }])).toThrow(/Could not find/);
	});
	it('appends with a separating newline', () => {
		expect(applyOperations('a', [{ type: 'append', content: 'b' }])).toBe('a\nb');
		expect(applyOperations('a\n', [{ type: 'append', content: 'b' }])).toBe('a\nb');
		expect(applyOperations('', [{ type: 'append', content: 'b' }])).toBe('b');
	});
	it('applies operations in order', () => {
		expect(applyOperations('x', [{ type: 'replace_all', content: 'hello' }, { type: 'append', content: 'world' }])).toBe('hello\nworld');
	});
});

describe('rejectNewPlaceholders', () => {
	it('refuses bracketed fill-in text the note did not already have', () => {
		for (const text of ['- [Insert decisions here]', '[insert owner]', 'Owner: [TODO]', '[todo: check budget]', '[Placeholder for summary]']) {
			expect(() => rejectNewPlaceholders('', text)).toThrow(ProposalError);
		}
	});
	it('leaves links, checkboxes, ordinary brackets and existing placeholders alone', () => {
		for (const text of ['See [[Todo list]] and [[Insert Coin]]', '[todo](https://example.com)', '- [ ] buy milk', '- [x] done', '[Insertion sort] notes', 'TODO: later']) {
			expect(() => rejectNewPlaceholders('', text)).not.toThrow();
		}
		expect(() => rejectNewPlaceholders('Owner: [TODO]\n', 'Owner: [TODO]\nMore text\n')).not.toThrow();
	});
	it('finds placeholders at the start of the text, right after other text and next to links', () => {
		for (const text of ['[insert here]', 'x[todo]', 'See [[Plan]] [placeholder]', '[[Todo]][todo: owner]', 'a\n[Insert decisions]\n']) {
			expect(() => rejectNewPlaceholders('', text)).toThrow(ProposalError);
		}
		expect(() => rejectNewPlaceholders('', '[[Todo]]')).not.toThrow();
		expect(() => rejectNewPlaceholders('', '[todo](https://example.com) [[Placeholder]]')).not.toThrow();
	});
});

describe('ProposalEngine', () => {
	it('proposes and applies an edit, writing a snapshot first', async () => {
		const vault = new MemoryVaultPort({ 'A.md': '# A\n\nold text\n' });
		const e = engine(vault);
		const p = await e.proposeEdit('c1', 'A.md', [{ type: 'find_replace', find: 'old text', replace: 'new text' }], 'swap');
		expect(p.status).toBe('pending');
		expect(p.after).toBe('# A\n\nnew text\n');
		expect(e.stats(p)).toEqual({ added: 1, removed: 1 });
		await e.apply(p);
		expect(p.status).toBe('applied');
		expect(vault.files.get('A.md')).toBe('# A\n\nnew text\n');
		expect(p.snapshotPath).toMatch(/^snapshots\//);
		expect(vault.pluginFiles.get(p.snapshotPath as string)).toBe('# A\n\nold text\n');
	});

	it('refuses to apply when the note changed after the proposal', async () => {
		const vault = new MemoryVaultPort({ 'A.md': 'v1\n' });
		const e = engine(vault);
		const p = await e.proposeEdit('c1', 'A.md', [{ type: 'replace_all', content: 'v2\n' }], 'rewrite');
		vault.files.set('A.md', 'user edited\n');
		await expect(e.apply(p)).rejects.toThrow(/changed after this proposal/);
		expect(p.status).toBe('stale');
		expect(vault.files.get('A.md')).toBe('user edited\n');
		expect(await e.checkFreshness(p)).toBe('stale');
	});

	it('refresh marks a pending proposal stale when the note changes and pending again when the change is undone', async () => {
		const vault = new MemoryVaultPort({ 'A.md': 'v1\n' });
		const e = engine(vault);
		const p = await e.proposeEdit('c1', 'A.md', [{ type: 'replace_all', content: 'v2\n' }], 'rewrite');
		expect(await e.refresh(p)).toBe(false);
		expect(p.status).toBe('pending');
		vault.files.set('A.md', 'edited by hand\n');
		expect(await e.refresh(p)).toBe(true);
		expect(p.status).toBe('stale');
		expect(await e.refresh(p)).toBe(false);
		vault.files.set('A.md', 'v1\n');
		expect(await e.refresh(p)).toBe(true);
		expect(p.status).toBe('pending');
		await e.apply(p);
		expect(p.status).toBe('applied');
		// Final states are left alone, whatever the note does.
		vault.files.set('A.md', 'later\n');
		expect(await e.refresh(p)).toBe(false);
		expect(p.status).toBe('applied');
		const c = await e.proposeCreate('c1', 'New.md', 'x', 'make');
		expect(await e.refresh(c)).toBe(false);
		expect(c.status).toBe('pending');
	});

	it('a refresh started by the apply write leaves the applied proposal alone', async () => {
		const vault = new MemoryVaultPort({ 'A.md': 'v1\n' });
		const e = engine(vault);
		const p = await e.proposeEdit('c1', 'A.md', [{ type: 'replace_all', content: 'v2\n' }], 'rewrite');
		// Obsidian fires 'modify' during Vault.process; the view refreshes from there.
		const refreshes: Array<Promise<boolean>> = [];
		const original = vault.processNote.bind(vault);
		vault.processNote = async (path, fn) => {
			await original(path, fn);
			refreshes.push(e.refresh(p));
		};
		await e.apply(p);
		expect(await Promise.all(refreshes)).toEqual([false]);
		expect(p.status).toBe('applied');
		// Same when the refresh resumes while apply is still writing.
		const q = await e.proposeEdit('c1', 'A.md', [{ type: 'replace_all', content: 'v3\n' }], 'rewrite');
		vault.processNote = async (path, fn) => {
			await original(path, fn);
			expect(await e.refresh(q)).toBe(false);
		};
		await e.apply(q);
		expect(q.status).toBe('applied');
	});

	it('guards inside the atomic write as well', async () => {
		const vault = new MemoryVaultPort({ 'A.md': 'v1\n' });
		const e = engine(vault);
		const p = await e.proposeEdit('c1', 'A.md', [{ type: 'replace_all', content: 'v2\n' }], 'rewrite');
		// Simulate a race: content changes between freshness check and write.
		const original = vault.processNote.bind(vault);
		vault.processNote = async (path, fn) => {
			vault.files.set('A.md', 'raced\n');
			return original(path, fn);
		};
		await expect(e.apply(p)).rejects.toThrow(/changed while applying/);
		expect(p.status).toBe('stale');
		expect(vault.files.get('A.md')).toBe('raced\n');
	});

	it('creates notes and refuses to overwrite existing files', async () => {
		const vault = new MemoryVaultPort({ 'A.md': 'x' });
		const e = engine(vault);
		await expect(e.proposeCreate('c1', 'A.md', 'y', 's')).rejects.toThrow(/already exists/);
		const p = await e.proposeCreate('c1', 'New/B.md', '# B\n', 'new');
		vault.seed('New/B.md', 'user made it first');
		await expect(e.apply(p)).rejects.toThrow(/already exists/);
		expect(p.status).toBe('failed');
		const q = await e.proposeCreate('c1', 'New/C.md', '# C\n', 'new');
		await e.apply(q);
		expect(vault.files.get('New/C.md')).toBe('# C\n');
		expect(vault.isFolder('New')).toBe(true);
	});

	it('rejects path traversal and config-folder writes', async () => {
		const vault = new MemoryVaultPort({ 'A.md': 'x' });
		const e = engine(vault);
		await expect(e.proposeCreate('c1', '../outside.md', 'y', 's')).rejects.toThrow(/traversal/);
		await expect(e.proposeCreate('c1', '.obsidian/plugins/evil.md', 'y', 's')).rejects.toThrow(/configuration folder/);
		await expect(e.proposeEdit('c1', 'A.txt', [{ type: 'append', content: 'x' }], 's')).rejects.toThrow(/\.md/);
	});

	it('rejects and reverts', async () => {
		const vault = new MemoryVaultPort({ 'A.md': 'v1\n' });
		const e = engine(vault);
		const p = await e.proposeEdit('c1', 'A.md', [{ type: 'replace_all', content: 'v2\n' }], 'rewrite');
		e.reject(p);
		expect(p.status).toBe('rejected');
		await expect(e.apply(p)).rejects.toThrow(/already rejected/);

		const q = await e.proposeEdit('c1', 'A.md', [{ type: 'replace_all', content: 'v3\n' }], 'rewrite');
		await e.apply(q);
		expect(vault.files.get('A.md')).toBe('v3\n');
		await e.revert(q);
		expect(vault.files.get('A.md')).toBe('v1\n');
		expect(q.status).toBe('reverted');
	});

	it('refuses to revert over edits made after apply', async () => {
		const vault = new MemoryVaultPort({ 'A.md': 'v1\n' });
		const e = engine(vault);
		const p = await e.proposeEdit('c1', 'A.md', [{ type: 'replace_all', content: 'v2\n' }], 'rewrite');
		await e.apply(p);
		vault.files.set('A.md', 'v2\nuser typed more\n');
		await expect(e.revert(p)).rejects.toThrow(/changed after this edit was applied/);
		expect(vault.files.get('A.md')).toBe('v2\nuser typed more\n');
		expect(p.status).toBe('applied');
	});

	it('rejects no-op edits and missing notes', async () => {
		const vault = new MemoryVaultPort({ 'A.md': 'same\n' });
		const e = engine(vault);
		await expect(e.proposeEdit('c1', 'A.md', [{ type: 'replace_all', content: 'same\n' }], 's')).rejects.toThrow(ProposalError);
		await expect(e.proposeEdit('c1', 'Missing.md', [{ type: 'append', content: 'x' }], 's')).rejects.toThrow(/No note found/);
	});

	it('prunes old snapshots', async () => {
		const vault = new MemoryVaultPort({ 'A.md': '0\n' });
		const e = engine(vault);
		for (let i = 1; i <= 55; i++) {
			const p = await e.proposeEdit('c1', 'A.md', [{ type: 'replace_all', content: `${i}\n` }], 's');
			await e.apply(p);
		}
		expect((await vault.listPluginFiles('snapshots')).length).toBe(50);
	});
});
