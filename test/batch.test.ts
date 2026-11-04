import { describe, expect, it } from 'vitest';
import { Conversation, newConversation, proposalTurns, StoredMessage } from '../src/persistence/conversation';
import { ChangeProposal, ProposalEngine, ProposalError, summarizeBatch } from '../src/vault/proposals';
import { MemoryVaultPort } from './memory-vault';

function engine(vault: MemoryVaultPort) {
	let t = 1000;
	let n = 0;
	return new ProposalEngine(vault, () => ++t, () => `p${++n}`);
}

function proposal(id: string, path: string, status: ChangeProposal['status'] = 'pending', kind: ChangeProposal['kind'] = 'edit'): ChangeProposal {
	return { id, conversationId: 'c1', kind, path, before: kind === 'edit' ? 'old' : null, after: 'new', baseHash: null, summary: 's', status, createdAt: 1 };
}

function msg(id: string, role: StoredMessage['role'], extra: Partial<StoredMessage> = {}): StoredMessage {
	return { id, role, content: '', createdAt: 1, ...extra };
}

describe('proposalTurns', () => {
	it('groups the proposals made between one user message and the next, anchored on the turn\'s last proposal', () => {
		const conv: Conversation = newConversation('c1', 1);
		conv.messages = [
			msg('u1', 'user'),
			msg('a1', 'assistant'),
			msg('t1', 'tool', { proposalId: 'p1' }),
			msg('t2', 'tool'),
			msg('t3', 'tool', { proposalId: 'p2' }),
			msg('a2', 'assistant'),
			msg('u2', 'user'),
			msg('a3', 'assistant'),
			msg('t4', 'tool', { proposalId: 'p3' }),
			msg('a4', 'assistant'),
			msg('u3', 'user'),
			msg('a5', 'assistant'),
		];
		conv.proposals = { p1: proposal('p1', 'A.md'), p2: proposal('p2', 'B.md', 'rejected'), p3: proposal('p3', 'C.md', 'applied') };
		const turns = proposalTurns(conv);
		expect(turns.map((t) => ({ turnId: t.turnId, ids: t.proposals.map((p) => p.id), anchor: t.anchorMessageId }))).toEqual([
			{ turnId: 'u1', ids: ['p1', 'p2'], anchor: 't3' },
			{ turnId: 'u2', ids: ['p3'], anchor: 't4' },
		]);
	});

	it('skips a tool message whose proposal is gone and groups proposals before any user message under an empty turn', () => {
		const conv: Conversation = newConversation('c1', 1);
		conv.messages = [msg('t0', 'tool', { proposalId: 'p0' }), msg('t1', 'tool', { proposalId: 'missing' }), msg('u1', 'user'), msg('t2', 'tool', { proposalId: 'p1' })];
		conv.proposals = { p0: proposal('p0', 'Z.md'), p1: proposal('p1', 'A.md') };
		const turns = proposalTurns(conv);
		expect(turns.map((t) => [t.turnId, t.proposals.map((p) => p.id), t.anchorMessageId])).toEqual([
			['', ['p0'], 't0'],
			['u1', ['p1'], 't2'],
		]);
	});

	it('groups a saved conversation on reopening without any batch field on the data', () => {
		// The same shape sanitizeConversation produces from a file written before batches existed.
		const conv: Conversation = {
			id: 'c1',
			title: 't',
			createdAt: 1,
			updatedAt: 1,
			messages: [msg('u1', 'user'), msg('t1', 'tool', { proposalId: 'p1' }), msg('t2', 'tool', { proposalId: 'p2' })],
			proposals: { p1: proposal('p1', 'A.md', 'applied'), p2: proposal('p2', 'B.md', 'applied') },
		};
		expect(JSON.stringify(conv)).not.toContain('batch');
		expect(proposalTurns(conv)[0]?.proposals.map((p) => p.path)).toEqual(['A.md', 'B.md']);
	});
});

describe('summarizeBatch', () => {
	it('counts changes and notes, splits pending from applied, and names the first out-of-date note as the blocker', () => {
		const batch = [proposal('p1', 'A.md'), proposal('p2', 'B.md', 'stale'), proposal('p3', 'C.md', 'applied'), proposal('p4', 'A.md', 'rejected'), proposal('p5', 'D.md', 'stale')];
		const s = summarizeBatch(batch);
		expect(s.changes).toBe(5);
		expect(s.notes).toBe(4);
		expect(s.pending.map((p) => p.id)).toEqual(['p1', 'p2', 'p5']);
		expect(s.applied.map((p) => p.id)).toEqual(['p3']);
		expect(s.blocker?.id).toBe('p2');
		expect(summarizeBatch([proposal('p1', 'A.md', 'applied'), proposal('p2', 'B.md', 'rejected')])).toMatchObject({ pending: [], blocker: null, notes: 2, changes: 2 });
	});
});

describe('ProposalEngine.applyAll', () => {
	async function threeNotes() {
		const vault = new MemoryVaultPort({ 'A.md': 'a1\n', 'B.md': 'b1\n' });
		const e = engine(vault);
		const a = await e.proposeEdit('c1', 'A.md', [{ type: 'replace_all', content: 'a2\n' }], 'a');
		const n = await e.proposeCreate('c1', 'New/N.md', '# N\n', 'n');
		const b = await e.proposeEdit('c1', 'B.md', [{ type: 'replace_all', content: 'b2\n' }], 'b');
		return { vault, e, a, n, b };
	}

	it('applies every pending proposal through the per-note apply path and skips resolved ones', async () => {
		const { vault, e, a, n, b } = await threeNotes();
		const c = await e.proposeEdit('c1', 'A.md', [{ type: 'append', content: 'x' }], 'c');
		e.reject(c);
		const applied = await e.applyAll([a, n, b, c]);
		expect(applied.map((p) => p.id)).toEqual([a.id, n.id, b.id]);
		expect([a.status, n.status, b.status, c.status]).toEqual(['applied', 'applied', 'applied', 'rejected']);
		expect(vault.files.get('A.md')).toBe('a2\n');
		expect(vault.files.get('B.md')).toBe('b2\n');
		expect(vault.files.get('New/N.md')).toBe('# N\n');
		expect(vault.pluginFiles.get(a.snapshotPath as string)).toBe('a1\n');
		expect(vault.pluginFiles.get(b.snapshotPath as string)).toBe('b1\n');
		expect(n.snapshotPath).toBeUndefined();
	});

	it('writes nothing when any pending note is out of date, and names that note', async () => {
		const { vault, e, a, n, b } = await threeNotes();
		vault.files.set('B.md', 'edited by hand\n');
		await expect(e.applyAll([a, n, b])).rejects.toThrow(/Nothing was applied: B\.md changed after this proposal was made/);
		expect(vault.files.get('A.md')).toBe('a1\n');
		expect(vault.exists('New/N.md')).toBe(false);
		expect(vault.files.get('B.md')).toBe('edited by hand\n');
		expect([a.status, n.status, b.status]).toEqual(['pending', 'pending', 'stale']);
		expect(a.snapshotPath).toBeUndefined();
	});

	it('names a created note whose path now exists and a note that no longer exists', async () => {
		const { vault, e, a, n, b } = await threeNotes();
		vault.seed('New/N.md', 'made by the user');
		await expect(e.applyAll([a, n, b])).rejects.toThrow(/Nothing was applied: a file already exists at New\/N\.md/);
		expect(vault.files.get('A.md')).toBe('a1\n');
		expect([a.status, n.status, b.status]).toEqual(['pending', 'pending', 'pending']);
		vault.delete('New/N.md');
		vault.delete('A.md');
		await expect(e.applyAll([a, n, b])).rejects.toThrow(/Nothing was applied: A\.md no longer exists/);
		expect(vault.exists('New/N.md')).toBe(false);
		expect(b.status).toBe('pending');
	});

	it('rolls back the notes it already wrote when a later write fails, trashing a note it created', async () => {
		const { vault, e, a, n, b } = await threeNotes();
		const original = vault.processNote.bind(vault);
		vault.processNote = (path, fn) => (path === 'B.md' ? Promise.reject(new Error('disk full')) : original(path, fn));
		await expect(e.applyAll([a, n, b])).rejects.toThrow(/Applied 2 of 3 changes, then B\.md failed: disk full\. The changes to A\.md and New\/N\.md were rolled back/);
		expect(vault.files.get('A.md')).toBe('a1\n');
		expect(vault.exists('New/N.md')).toBe(false);
		expect(vault.trashed.get('New/N.md')).toBe('# N\n');
		expect(vault.files.get('B.md')).toBe('b1\n');
		expect([a.status, n.status, b.status]).toEqual(['pending', 'pending', 'failed']);
		expect(a.snapshotPath).toBeUndefined();
		expect(b.error).toBe('disk full');
		// The rolled-back proposals are fresh again and can be applied on their own.
		vault.processNote = original;
		await e.apply(a);
		expect(vault.files.get('A.md')).toBe('a2\n');
	});

	it('leaves a written note alone during rollback once it no longer holds exactly what the batch wrote', async () => {
		const { vault, e, a, n, b } = await threeNotes();
		const original = vault.processNote.bind(vault);
		vault.processNote = (path, fn) => {
			if (path !== 'B.md') return original(path, fn);
			// Between the batch's writes, the user types into both notes it has already written.
			vault.files.set('New/N.md', '# N\n\nmy own line\n');
			vault.files.set('A.md', 'a2\nmy own line\n');
			return Promise.reject(new Error('disk full'));
		};
		await expect(e.applyAll([a, n, b])).rejects.toThrow(/B\.md failed: disk full\. A\.md and New\/N\.md were changed after they were written and were left as they are/);
		expect(vault.files.get('New/N.md')).toBe('# N\n\nmy own line\n');
		expect(vault.trashed.size).toBe(0);
		expect(vault.files.get('A.md')).toBe('a2\nmy own line\n');
		expect([a.status, n.status, b.status]).toEqual(['applied', 'applied', 'failed']);
	});

	it('refreshes a stale proposal back to pending before applying when the user undid their edit', async () => {
		const { vault, e, a, n, b } = await threeNotes();
		vault.files.set('A.md', 'typo\n');
		expect(await e.refresh(a)).toBe(true);
		expect(a.status).toBe('stale');
		vault.files.set('A.md', 'a1\n');
		await e.applyAll([a, n, b]);
		expect([a.status, n.status, b.status]).toEqual(['applied', 'applied', 'applied']);
	});

	it('does nothing for a batch with no pending proposals', async () => {
		const { e, a } = await threeNotes();
		e.reject(a);
		expect(await e.applyAll([a])).toEqual([]);
		expect(a.status).toBe('rejected');
	});
});

describe('ProposalEngine.revertAll', () => {
	async function appliedBatch() {
		const vault = new MemoryVaultPort({ 'A.md': 'a1\n', 'B.md': 'b1\n' });
		const e = engine(vault);
		const a = await e.proposeEdit('c1', 'A.md', [{ type: 'replace_all', content: 'a2\n' }], 'a');
		const n = await e.proposeCreate('c1', 'New/N.md', '# N\n', 'n');
		const b = await e.proposeEdit('c1', 'B.md', [{ type: 'replace_all', content: 'b2\n' }], 'b');
		await e.applyAll([a, n, b]);
		return { vault, e, a, n, b };
	}

	it('restores every edited note from its snapshot and trashes the notes the batch created', async () => {
		const { vault, e, a, n, b } = await appliedBatch();
		const reverted = await e.revertAll([a, n, b]);
		expect(reverted.map((p) => p.id)).toEqual([a.id, n.id, b.id]);
		expect(vault.files.get('A.md')).toBe('a1\n');
		expect(vault.files.get('B.md')).toBe('b1\n');
		expect(vault.exists('New/N.md')).toBe(false);
		expect(vault.trashed.get('New/N.md')).toBe('# N\n');
		expect([a.status, n.status, b.status]).toEqual(['reverted', 'reverted', 'reverted']);
	});

	it('undoes nothing when any note changed since the batch applied, and names it', async () => {
		const { vault, e, a, n, b } = await appliedBatch();
		vault.files.set('New/N.md', '# N\n\nkept\n');
		await expect(e.revertAll([a, n, b])).rejects.toThrow(/Nothing was undone: New\/N\.md changed after this batch was applied/);
		expect(vault.files.get('A.md')).toBe('a2\n');
		expect(vault.files.get('B.md')).toBe('b2\n');
		expect(vault.files.get('New/N.md')).toBe('# N\n\nkept\n');
		expect([a.status, n.status, b.status]).toEqual(['applied', 'applied', 'applied']);
		vault.files.set('New/N.md', '# N\n');
		vault.delete('B.md');
		await expect(e.revertAll([a, n, b])).rejects.toThrow(/Nothing was undone: B\.md no longer exists/);
		expect(vault.files.get('A.md')).toBe('a2\n');
		expect(vault.exists('New/N.md')).toBe(true);
	});

	it('covers only the applied proposals and leaves per-note undo of a created note refused', async () => {
		const { vault, e, a, n, b } = await appliedBatch();
		await expect(e.revert(n)).rejects.toThrow(/Created notes are not deleted automatically/);
		expect(vault.exists('New/N.md')).toBe(true);
		await e.revert(a);
		const reverted = await e.revertAll([a, n, b]);
		expect(reverted.map((p) => p.id)).toEqual([n.id, b.id]);
		expect(vault.exists('New/N.md')).toBe(false);
		expect([a.status, n.status, b.status]).toEqual(['reverted', 'reverted', 'reverted']);
		expect(await e.revertAll([a, n, b])).toEqual([]);
	});

	it('puts back what it already undid when a later undo fails', async () => {
		const { vault, e, a, n, b } = await appliedBatch();
		const original = vault.processNote.bind(vault);
		vault.processNote = (path, fn) => (path === 'A.md' ? Promise.reject(new Error('disk full')) : original(path, fn));
		await expect(e.revertAll([a, n, b])).rejects.toThrow(/Undid 2 of 3 changes, then A\.md failed: disk full\. The changes to New\/N\.md and B\.md were put back/);
		expect(vault.files.get('A.md')).toBe('a2\n');
		expect(vault.files.get('New/N.md')).toBe('# N\n');
		expect(vault.files.get('B.md')).toBe('b2\n');
		expect([a.status, n.status, b.status]).toEqual(['applied', 'applied', 'applied']);
		// The created note is back in place; the copy the undo trashed stays in the trash.
		expect(vault.trashed.get('New/N.md')).toBe('# N\n');
	});
});

describe('a note changed twice in one turn', () => {
	it('undoes both changes newest first when the first was approved before the second was proposed', async () => {
		const vault = new MemoryVaultPort({ 'A.md': 'a1\n', 'B.md': 'b1\n' });
		const e = engine(vault);
		const first = await e.proposeEdit('c1', 'A.md', [{ type: 'replace_all', content: 'a2\n' }], 'first');
		await e.apply(first);
		const second = await e.proposeEdit('c1', 'A.md', [{ type: 'replace_all', content: 'a3\n' }], 'second');
		const b = await e.proposeEdit('c1', 'B.md', [{ type: 'replace_all', content: 'b2\n' }], 'b');
		await e.applyAll([first, second, b]);
		expect(vault.files.get('A.md')).toBe('a3\n');
		const undone = await e.revertAll([first, second, b]);
		expect(undone.map((p) => p.id)).toEqual([first.id, second.id, b.id]);
		expect(vault.files.get('A.md')).toBe('a1\n');
		expect(vault.files.get('B.md')).toBe('b1\n');
		expect([first.status, second.status, b.status]).toEqual(['reverted', 'reverted', 'reverted']);
	});

	it('still refuses Undo all when the note changed after its latest change', async () => {
		const vault = new MemoryVaultPort({ 'A.md': 'a1\n' });
		const e = engine(vault);
		const first = await e.proposeEdit('c1', 'A.md', [{ type: 'replace_all', content: 'a2\n' }], 'first');
		await e.apply(first);
		const second = await e.proposeEdit('c1', 'A.md', [{ type: 'replace_all', content: 'a3\n' }], 'second');
		await e.applyAll([first, second]);
		vault.files.set('A.md', 'mine\n');
		await expect(e.revertAll([first, second])).rejects.toThrow(/Nothing was undone: A\.md changed after this batch was applied/);
		expect(vault.files.get('A.md')).toBe('mine\n');
		expect([first.status, second.status]).toEqual(['applied', 'applied']);
	});
});

describe('a saved turn with two pending changes to one note', () => {
	it('applies nothing and names the note instead of failing on its own first write', async () => {
		const vault = new MemoryVaultPort({ 'A.md': 'a1\n', 'B.md': 'b1\n' });
		const e = engine(vault);
		const first = await e.proposeEdit('c1', 'A.md', [{ type: 'replace_all', content: 'a2\n' }], 'first');
		const second = await e.proposeEdit('c1', 'A.md', [{ type: 'append', content: 'more\n' }], 'second');
		const b = await e.proposeEdit('c1', 'B.md', [{ type: 'replace_all', content: 'b2\n' }], 'b');
		await expect(e.applyAll([first, b, second])).rejects.toThrow(
			/Nothing was applied: A\.md has more than one change waiting in this batch\. Approve or reject those changes one at a time\./,
		);
		expect(vault.files.get('A.md')).toBe('a1\n');
		expect(vault.files.get('B.md')).toBe('b1\n');
		expect([first.status, second.status, b.status]).toEqual(['pending', 'pending', 'pending']);
		e.reject(second);
		expect(await e.applyAll([first, b, second])).toEqual([first, b]);
		expect(vault.files.get('A.md')).toBe('a2\n');
	});
});

describe('a proposal held by a running batch', () => {
	it('ignores Reject and refuses a per-note Approve until Approve all finishes', async () => {
		const vault = new MemoryVaultPort({ 'A.md': 'a1\n', 'B.md': 'b1\n' });
		const e = engine(vault);
		const a = await e.proposeEdit('c1', 'A.md', [{ type: 'replace_all', content: 'a2\n' }], 'a');
		const b = await e.proposeEdit('c1', 'B.md', [{ type: 'replace_all', content: 'b2\n' }], 'b');
		const running = e.applyAll([a, b]);
		e.reject(b);
		await expect(e.apply(b)).rejects.toThrow(/B\.md is already being changed/);
		await expect(e.applyAll([a, b])).rejects.toThrow(/A\.md is already being changed/);
		expect(await running).toEqual([a, b]);
		expect([a.status, b.status]).toEqual(['applied', 'applied']);
		expect(vault.files.get('B.md')).toBe('b2\n');
	});

	it('refuses a per-note Revert while Undo all runs', async () => {
		const vault = new MemoryVaultPort({ 'A.md': 'a1\n' });
		const e = engine(vault);
		const a = await e.proposeEdit('c1', 'A.md', [{ type: 'replace_all', content: 'a2\n' }], 'a');
		await e.applyAll([a]);
		const running = e.revertAll([a]);
		await expect(e.revert(a)).rejects.toThrow(/A\.md is already being changed/);
		expect(await running).toEqual([a]);
		expect(vault.files.get('A.md')).toBe('a1\n');
	});
});

describe('ProposalError', () => {
	it('is what every batch failure throws', async () => {
		const vault = new MemoryVaultPort({ 'A.md': 'a1\n' });
		const e = engine(vault);
		const a = await e.proposeEdit('c1', 'A.md', [{ type: 'replace_all', content: 'a2\n' }], 'a');
		vault.files.set('A.md', 'x\n');
		await expect(e.applyAll([a])).rejects.toBeInstanceOf(ProposalError);
	});
});
