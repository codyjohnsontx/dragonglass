import { diffLines, diffStats, DiffLine } from './diff';
import { hashContent } from './hash';
import { VaultPort } from './port';
import { validateVaultPath } from './paths';

/**
 * A proposed change to one note. Proposals are created by write tools, shown
 * to the user as a diff, and only applied through `ProposalEngine.apply`
 * after approval. The base hash guards against clobbering edits the user made
 * after the proposal was computed.
 */
export interface ChangeProposal {
	id: string;
	conversationId: string;
	kind: 'create' | 'edit';
	path: string;
	/** Content when the proposal was computed; null for create. */
	before: string | null;
	after: string;
	/** SHA-256 of `before`, null for create. */
	baseHash: string | null;
	summary: string;
	status: 'pending' | 'applied' | 'rejected' | 'reverted' | 'stale' | 'failed';
	createdAt: number;
	resolvedAt?: number;
	/** Plugin-relative path of the pre-change snapshot written on apply. */
	snapshotPath?: string;
	error?: string;
}

export type EditOperation =
	| { type: 'replace_all'; content: string }
	| { type: 'append'; content: string }
	| { type: 'find_replace'; find: string; replace: string; replaceAll?: boolean };

export class ProposalError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ProposalError';
	}
}

export interface ApplyResult {
	proposal: ChangeProposal;
}

/** What a review of one turn's proposals needs to show: counts, what is open, and what blocks Approve all. */
export interface BatchSummary {
	changes: number;
	/** Distinct notes. */
	notes: number;
	/** Awaiting review (`pending`) or already known to be out of date (`stale`), in order. */
	pending: ChangeProposal[];
	applied: ChangeProposal[];
	/** The first pending proposal Dragonglass already knows is out of date; Approve all is disabled while there is one. */
	blocker: ChangeProposal | null;
}

export function summarizeBatch(batch: readonly ChangeProposal[]): BatchSummary {
	const pending = batch.filter((p) => p.status === 'pending' || p.status === 'stale');
	return {
		changes: batch.length,
		notes: new Set(batch.map((p) => p.path)).size,
		pending,
		applied: batch.filter((p) => p.status === 'applied'),
		blocker: pending.find((p) => p.status === 'stale') ?? null,
	};
}

const SNAPSHOT_DIR = 'snapshots';
const MAX_SNAPSHOTS = 50;

export class ProposalEngine {
	private readonly applying = new Set<ChangeProposal>();

	constructor(
		private readonly vault: VaultPort,
		private readonly now: () => number = () => Date.now(),
		private readonly newId: () => string = defaultId,
	) {}

	async proposeCreate(conversationId: string, rawPath: string, content: string, summary: string): Promise<ChangeProposal> {
		const path = validateVaultPath(rawPath, { configDir: this.vault.configDir });
		if (this.vault.exists(path)) {
			throw new ProposalError(`A file already exists at ${path}. Use an edit instead.`);
		}
		rejectNewPlaceholders('', content);
		return {
			id: this.newId(),
			conversationId,
			kind: 'create',
			path,
			before: null,
			after: content,
			baseHash: null,
			summary,
			status: 'pending',
			createdAt: this.now(),
		};
	}

	async proposeEdit(
		conversationId: string,
		rawPath: string,
		ops: EditOperation[],
		summary: string,
	): Promise<ChangeProposal> {
		const path = validateVaultPath(rawPath, { configDir: this.vault.configDir });
		const before = await this.vault.readNote(path);
		if (before === null) throw new ProposalError(`No note found at ${path}.`);
		const after = applyOperations(before, ops);
		if (after === before) throw new ProposalError('The proposed edit makes no changes.');
		rejectNewPlaceholders(before, after);
		return {
			id: this.newId(),
			conversationId,
			kind: 'edit',
			path,
			before,
			after,
			baseHash: await hashContent(before),
			summary,
			status: 'pending',
			createdAt: this.now(),
		};
	}

	diff(p: ChangeProposal): DiffLine[] {
		return diffLines(p.before ?? '', p.after);
	}

	stats(p: ChangeProposal): { added: number; removed: number } {
		return diffStats(this.diff(p));
	}

	/**
	 * Re-check a pending edit against the current note. Returns `stale` when
	 * the note changed since the proposal was computed.
	 */
	async checkFreshness(p: ChangeProposal): Promise<'fresh' | 'stale' | 'missing' | 'exists'> {
		if (p.kind === 'create') return this.vault.exists(p.path) ? 'exists' : 'fresh';
		const current = await this.vault.readNote(p.path);
		if (current === null) return 'missing';
		return (await hashContent(current)) === p.baseHash ? 'fresh' : 'stale';
	}

	/**
	 * Re-check a pending or stale proposal against the note as it is now and
	 * move it between the two states: `stale` once the user edits the note,
	 * back to `pending` if they undo that edit. Returns true when the status
	 * changed. Other states are final and left alone.
	 */
	async refresh(p: ChangeProposal): Promise<boolean> {
		if (!this.refreshable(p)) return false;
		const freshness = await this.checkFreshness(p);
		if (!this.refreshable(p)) return false;
		const next = freshness === 'fresh' ? 'pending' : freshness === 'stale' ? 'stale' : p.status;
		if (next === p.status) return false;
		p.status = next;
		return true;
	}

	private refreshable(p: ChangeProposal): boolean {
		return !this.applying.has(p) && (p.status === 'pending' || p.status === 'stale');
	}

	/**
	 * Apply an approved proposal. Writes a snapshot of the prior content first
	 * so the change can be rolled back, then writes through the vault port.
	 * Throws ProposalError (and marks the proposal) if the note changed.
	 */
	async apply(p: ChangeProposal): Promise<ApplyResult> {
		if (p.status !== 'pending' && p.status !== 'stale') {
			throw new ProposalError(`Proposal is already ${p.status}.`);
		}
		this.applying.add(p);
		try {
			return await this.write(p);
		} finally {
			this.applying.delete(p);
		}
	}

	private async write(p: ChangeProposal): Promise<ApplyResult> {
		const freshness = await this.checkFreshness(p);
		if (freshness === 'stale') {
			p.status = 'stale';
			throw new ProposalError('The note changed after this proposal was made. Reject it and ask again.');
		}
		if (freshness === 'missing') {
			p.status = 'failed';
			p.error = 'note no longer exists';
			throw new ProposalError('The note no longer exists.');
		}
		if (freshness === 'exists') {
			p.status = 'failed';
			p.error = 'file already exists';
			throw new ProposalError(`A file already exists at ${p.path}.`);
		}
		try {
			if (p.kind === 'create') {
				await this.vault.createNote(p.path, p.after);
			} else {
				const snapshotPath = await this.writeSnapshot(p);
				p.snapshotPath = snapshotPath;
				await this.vault.processNote(p.path, (current) => {
					// Final guard inside the atomic write: compare content directly.
					if (current !== p.before) {
						throw new ProposalError('The note changed while applying. Nothing was written.');
					}
					return p.after;
				});
			}
		} catch (e) {
			if (e instanceof ProposalError && /changed while applying/.test(e.message)) {
				p.status = 'stale';
			} else {
				p.status = 'failed';
				p.error = e instanceof Error ? e.message : String(e);
			}
			throw e;
		}
		p.status = 'applied';
		p.resolvedAt = this.now();
		return { proposal: p };
	}

	/**
	 * Approve all: apply every pending proposal of a batch, all or nothing.
	 * Every note is checked first, so one out-of-date note means nothing is
	 * written and the error names it. Each write then goes through the same
	 * per-note path as `apply` (hash re-check, snapshot, equality check inside
	 * the atomic write). If a write fails partway, the notes already written
	 * are put back from their snapshots and a note the batch created is moved
	 * to the trash, each only while it still holds exactly what the batch
	 * wrote; a note the user has since changed is left as it is and stays
	 * applied. Returns the proposals applied; resolved ones are skipped.
	 */
	async applyAll(batch: readonly ChangeProposal[]): Promise<ChangeProposal[]> {
		const pending = batch.filter((p) => p.status === 'pending' || p.status === 'stale');
		if (pending.length === 0) return [];
		for (const p of pending) this.applying.add(p);
		try {
			for (const p of pending) {
				const freshness = await this.checkFreshness(p);
				if (freshness === 'stale') p.status = 'stale';
				else if (freshness === 'fresh') p.status = 'pending';
				if (freshness !== 'fresh') throw new ProposalError(`Nothing was applied: ${freshnessProblem(p, freshness)}`);
			}
			const written: ChangeProposal[] = [];
			for (const p of pending) {
				try {
					await this.write(p);
				} catch (e) {
					const outcome = await this.rollBack(written);
					throw new ProposalError(
						`Applied ${written.length} of ${pending.length} changes, then ${p.path} failed: ${trimDot(errorMessage(e))}.` +
							describeRollback(outcome, 'rolled back', 'written'),
					);
				}
				written.push(p);
			}
			return written;
		} finally {
			for (const p of pending) this.applying.delete(p);
		}
	}

	/**
	 * Undo all: revert every applied proposal of a batch, all or nothing.
	 * Every note is checked first; if any changed since the batch applied,
	 * nothing is undone and the error names it. Edits are restored from their
	 * snapshots as `revert` does. A note the batch created is moved to the
	 * trash, never deleted outright, and only while it still holds exactly
	 * what the batch wrote. Should an undo fail partway, the changes already
	 * undone are put back. Per-note `revert` is unchanged and never removes a
	 * created note.
	 */
	async revertAll(batch: readonly ChangeProposal[]): Promise<ChangeProposal[]> {
		const applied = batch.filter((p) => p.status === 'applied');
		if (applied.length === 0) return [];
		for (const p of applied) {
			const current = await this.vault.readNote(p.path);
			if (current === null) throw new ProposalError(`Nothing was undone: ${p.path} no longer exists.`);
			if (current !== p.after) {
				throw new ProposalError(`Nothing was undone: ${p.path} changed after this batch was applied. Undoing would overwrite those changes.`);
			}
		}
		const undone: ChangeProposal[] = [];
		for (const p of applied) {
			try {
				if (p.kind === 'create') {
					await this.trashCreated(p);
					p.status = 'reverted';
					p.resolvedAt = this.now();
				} else {
					await this.revert(p);
				}
			} catch (e) {
				const outcome = await this.redo(undone);
				throw new ProposalError(
					`Undid ${undone.length} of ${applied.length} changes, then ${p.path} failed: ${trimDot(errorMessage(e))}.` +
						describeRollback(outcome, 'put back', 'undone'),
				);
			}
			undone.push(p);
		}
		return undone;
	}

	/** Trash a note the batch created while it still holds exactly what was written; otherwise refuse. */
	private async trashCreated(p: ChangeProposal): Promise<void> {
		const current = await this.vault.readNote(p.path);
		if (current !== p.after) throw new ProposalError(`${p.path} changed after it was written`);
		await this.vault.trashNote(p.path);
	}

	/** Put the notes a failed batch already wrote back to what they held before, newest first. */
	private async rollBack(written: readonly ChangeProposal[]): Promise<RollbackOutcome> {
		const outcome: RollbackOutcome = { done: [], left: [], failed: [] };
		for (const p of [...written].reverse()) {
			try {
				if (p.kind === 'create') {
					await this.trashCreated(p);
				} else {
					const restore = await this.restoreContent(p);
					await this.vault.processNote(p.path, (current) => {
						if (current !== p.after) throw new ProposalError(`${p.path} changed after it was written`);
						return restore;
					});
				}
				p.status = 'pending';
				delete p.resolvedAt;
				delete p.snapshotPath;
				outcome.done.push(p);
			} catch (e) {
				if (e instanceof ProposalError && /changed after it was written/.test(e.message)) outcome.left.push(p);
				else outcome.failed.push({ proposal: p, error: errorMessage(e) });
			}
		}
		return outcome;
	}

	/** Re-apply the changes a failed Undo all already undid, newest first. */
	private async redo(undone: readonly ChangeProposal[]): Promise<RollbackOutcome> {
		const outcome: RollbackOutcome = { done: [], left: [], failed: [] };
		for (const p of [...undone].reverse()) {
			try {
				if (p.kind === 'create') {
					if (this.vault.exists(p.path)) throw new ProposalError(`${p.path} changed after it was undone`);
					await this.vault.createNote(p.path, p.after);
				} else {
					const restored = await this.restoreContent(p);
					await this.vault.processNote(p.path, (current) => {
						if (current !== restored) throw new ProposalError(`${p.path} changed after it was undone`);
						return p.after;
					});
				}
				p.status = 'applied';
				p.resolvedAt = this.now();
				outcome.done.push(p);
			} catch (e) {
				if (e instanceof ProposalError && /changed after it was undone/.test(e.message)) outcome.left.push(p);
				else outcome.failed.push({ proposal: p, error: errorMessage(e) });
			}
		}
		return outcome;
	}

	/** The content an applied edit is reverted to: its snapshot, else the content at proposal time. */
	private async restoreContent(p: ChangeProposal): Promise<string> {
		const snapshot = p.snapshotPath ? await this.vault.readPluginFile(p.snapshotPath) : null;
		return snapshot ?? p.before ?? '';
	}

	reject(p: ChangeProposal): ChangeProposal {
		if (p.status === 'pending' || p.status === 'stale') {
			p.status = 'rejected';
			p.resolvedAt = this.now();
		}
		return p;
	}

	/** Restore the snapshot taken when an edit proposal was applied. */
	async revert(p: ChangeProposal): Promise<void> {
		if (p.status !== 'applied') throw new ProposalError('Only applied proposals can be reverted.');
		if (p.kind === 'create') {
			throw new ProposalError('Created notes are not deleted automatically. Delete the note yourself if you do not want it.');
		}
		const restore = await this.restoreContent(p);
		await this.vault.processNote(p.path, (current) => {
			if (current !== p.after) {
				throw new ProposalError('The note changed after this edit was applied. Reverting would overwrite those changes, so nothing was written.');
			}
			return restore;
		});
		p.status = 'reverted';
		p.resolvedAt = this.now();
	}

	private async writeSnapshot(p: ChangeProposal): Promise<string> {
		const safeName = p.path.replace(/[^a-zA-Z0-9._-]+/g, '_');
		const rel = `${SNAPSHOT_DIR}/${this.now()}-${p.id}-${safeName}`;
		await this.vault.writePluginFile(rel, p.before ?? '');
		await this.pruneSnapshots();
		return rel;
	}

	private async pruneSnapshots(): Promise<void> {
		const files = (await this.vault.listPluginFiles(SNAPSHOT_DIR)).sort();
		const excess = files.length - MAX_SNAPSHOTS;
		for (let i = 0; i < excess; i++) {
			const f = files[i];
			if (f) await this.vault.deletePluginFile(f);
		}
	}
}

/** What a rollback managed: notes put back, notes left because the user had changed them, and notes it could not touch. */
interface RollbackOutcome {
	done: ChangeProposal[];
	left: ChangeProposal[];
	failed: Array<{ proposal: ChangeProposal; error: string }>;
}

function freshnessProblem(p: ChangeProposal, freshness: 'stale' | 'missing' | 'exists'): string {
	switch (freshness) {
		case 'stale':
			return `${p.path} changed after this proposal was made. Reject it and ask again.`;
		case 'missing':
			return `${p.path} no longer exists.`;
		case 'exists':
			return `a file already exists at ${p.path}.`;
	}
}

/** The sentences after a batch failure, in batch order: "The changes to A and B were rolled back. C was changed after it was written and was left as it is." */
function describeRollback(outcome: RollbackOutcome, verb: 'rolled back' | 'put back', step: 'written' | 'undone'): string {
	const order = (list: ChangeProposal[]) => [...list].reverse();
	let text = '';
	if (outcome.done.length > 0) {
		const done = order(outcome.done);
		text += ` The change${done.length === 1 ? '' : 's'} to ${listPaths(done)} ${done.length === 1 ? 'was' : 'were'} ${verb}.`;
	}
	if (outcome.left.length > 0) {
		const left = order(outcome.left);
		const plural = left.length > 1;
		text += ` ${listPaths(left)} ${plural ? 'were' : 'was'} changed after ${plural ? 'they were' : 'it was'} ${step} and ${plural ? 'were' : 'was'} left as ${plural ? 'they are' : 'it is'}.`;
	}
	for (const f of [...outcome.failed].reverse()) text += ` ${f.proposal.path} could not be ${verb}: ${trimDot(f.error)}.`;
	return text;
}

function listPaths(list: readonly ChangeProposal[]): string {
	const paths = list.map((p) => p.path);
	return paths.length <= 1 ? paths.join('') : `${paths.slice(0, -1).join(', ')} and ${paths[paths.length - 1]}`;
}

function errorMessage(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

function trimDot(s: string): string {
	return s.endsWith('.') ? s.slice(0, -1) : s;
}

export function applyOperations(before: string, ops: EditOperation[]): string {
	if (ops.length === 0) throw new ProposalError('No edit operations supplied.');
	let text = before;
	for (const op of ops) {
		switch (op.type) {
			case 'replace_all':
				text = op.content;
				break;
			case 'append':
				text = text.length === 0 || text.endsWith('\n') ? text + op.content : `${text}\n${op.content}`;
				break;
			case 'find_replace': {
				if (op.find.length === 0) throw new ProposalError('find_replace requires non-empty `find` text.');
				const first = text.indexOf(op.find);
				if (first < 0) {
					throw new ProposalError(
						`Could not find the text to replace. The note may differ from what you read; re-read it and try again. Looked for: ${truncate(op.find, 120)}`,
					);
				}
				if (op.replaceAll) {
					text = text.split(op.find).join(op.replace);
				} else {
					const second = text.indexOf(op.find, first + op.find.length);
					if (second >= 0) {
						throw new ProposalError(
							'The `find` text appears more than once. Include more surrounding context so it is unique, or set replaceAll.',
						);
					}
					text = text.slice(0, first) + op.replace + text.slice(first + op.find.length);
				}
				break;
			}
		}
	}
	return text;
}

/**
 * Bracketed fill-in text such as `[Insert decisions here]` or `[TODO: owner]`,
 * which a model writes when it proposes an edit before gathering the content.
 * Wikilinks (`[[Todo list]]`) and Markdown links (`[todo](url)`) do not count.
 */
// The character before the bracket is matched as a group rather than with a
// lookbehind, which older mobile WebViews do not support.
const PLACEHOLDER = /(^|[^[])(\[(?:insert|todo|placeholder)\b[^\]\n]*\])(?![\]([])/gi;

function placeholders(text: string): string[] {
	return [...text.matchAll(PLACEHOLDER)].map((m) => m[2] ?? '');
}

/** Refuse a proposal that adds placeholder text, counting each placeholder the note already had. */
export function rejectNewPlaceholders(before: string, after: string): void {
	const existing = new Map<string, number>();
	for (const m of placeholders(before)) existing.set(m.toLowerCase(), (existing.get(m.toLowerCase()) ?? 0) + 1);
	const added = placeholders(after).find((m) => {
		const left = existing.get(m.toLowerCase()) ?? 0;
		existing.set(m.toLowerCase(), left - 1);
		return left <= 0;
	});
	if (added) {
		throw new ProposalError(
			`The proposal contains placeholder text (${truncate(added, 80)}). Search and read the notes that hold this information first, then propose the real content; if it cannot be found, tell the user instead of proposing a placeholder.`,
		);
	}
}

function truncate(s: string, n: number): string {
	return s.length > n ? `${s.slice(0, n)}…` : s;
}

function defaultId(): string {
	const rand = Math.random().toString(36).slice(2, 10);
	return `${Date.now().toString(36)}-${rand}`;
}
