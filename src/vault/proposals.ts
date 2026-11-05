import { diffLines, diffStats, DiffLine } from './diff';
import { hashContent } from './hash';
import { VaultPort } from './port';
import { baseName, parentFolder, validateVaultPath } from './paths';
import { replaceSection, SectionError } from './sections';

/**
 * What a proposal does: create a note, edit its text, create a folder, move
 * or rename a note (`FileManager.renameFile`, which updates links to it), or
 * change its properties (`FileManager.processFrontMatter`).
 */
export type ProposalKind = 'create' | 'edit' | 'folder' | 'move' | 'frontmatter';

export const PROPOSAL_KINDS: readonly ProposalKind[] = ['create', 'edit', 'folder', 'move', 'frontmatter'];

/** One property a frontmatter proposal changes. A missing `before` means the note did not have it; a missing `after` means it is removed. */
export interface PropertyChange {
	key: string;
	before?: unknown;
	after?: unknown;
}

/** A property the model asks to set or remove, before it is compared with the note. */
export type PropertyEdit = { key: string; remove: true } | { key: string; remove?: false; value: unknown };

/**
 * A proposed change to one note or folder. Proposals are created by write
 * tools, shown to the user for review, and only applied through
 * `ProposalEngine.apply` after approval. The base hash guards against
 * clobbering edits the user made after the proposal was computed.
 */
export interface ChangeProposal {
	id: string;
	conversationId: string;
	kind: ProposalKind;
	/** The note (or, for `folder`, the folder) the proposal is about; for `move`, where the note is now. */
	path: string;
	/** Content when the proposal was computed; null for create, folder and move. */
	before: string | null;
	/**
	 * Content after the change: the new note for create and edit, empty for
	 * folder and move. For frontmatter it is empty while pending, since
	 * Obsidian writes the YAML, and set to the note as written once applied.
	 */
	after: string;
	/** SHA-256 of `before` for edit and frontmatter; null otherwise. */
	baseHash: string | null;
	/** Move: the note's new path. */
	newPath?: string;
	/** Move: notes whose links to the note Obsidian rewrites, as computed when proposed and again when applied. */
	linkUpdates?: string[];
	/** Frontmatter: the properties changed. */
	properties?: PropertyChange[];
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
	| { type: 'find_replace'; find: string; replace: string; replaceAll?: boolean }
	| { type: 'replace_section'; heading: string; content: string };

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
	/** New folders. */
	folders: number;
	/** Awaiting review (`pending`) or already known to be out of date (`stale`), in order. */
	pending: ChangeProposal[];
	applied: ChangeProposal[];
	/** The first pending proposal Dragonglass already knows is out of date; Approve all is disabled while there is one. */
	blocker: ChangeProposal | null;
}

/** Whether Undo all can take an applied proposal back. A new folder is never removed; delete it yourself. */
export function undoable(p: ChangeProposal): boolean {
	return p.kind !== 'folder';
}

/** Whether the per-proposal Revert button applies: created notes and folders are not removed by it. */
export function revertible(p: ChangeProposal): boolean {
	return p.kind === 'edit' || p.kind === 'frontmatter' || p.kind === 'move';
}

/** Every vault path a proposal changes or claims: the note, and for a move its new path too. */
export function touchedPaths(p: ChangeProposal): string[] {
	return p.kind === 'move' && p.newPath ? [p.path, p.newPath] : [p.path];
}

/**
 * The order a batch is written in: new folders first, so notes can go into
 * them; then note contents; then moves, so an edit to a note that links to a
 * moved note is checked against the text it was proposed on, before
 * Obsidian rewrites that link.
 */
function applyOrder(proposals: readonly ChangeProposal[]): ChangeProposal[] {
	const phase = (p: ChangeProposal) => (p.kind === 'folder' ? 0 : p.kind === 'move' ? 2 : 1);
	return proposals.map((p, i) => ({ p, i })).sort((a, b) => phase(a.p) - phase(b.p) || a.i - b.i).map(({ p }) => p);
}

export function summarizeBatch(batch: readonly ChangeProposal[]): BatchSummary {
	const pending = batch.filter((p) => p.status === 'pending' || p.status === 'stale');
	return {
		changes: batch.length,
		notes: new Set(batch.filter((p) => p.kind !== 'folder').map((p) => p.path)).size,
		folders: batch.filter((p) => p.kind === 'folder').length,
		pending,
		applied: batch.filter((p) => p.status === 'applied' && undoable(p)),
		blocker: pending.find((p) => p.status === 'stale') ?? null,
	};
}

const SNAPSHOT_DIR = 'snapshots';
const MAX_SNAPSHOTS = 50;

export class ProposalEngine {
	private readonly busy = new Set<ChangeProposal>();

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
		return this.edit(conversationId, path, before, applyOperations(before, ops), summary);
	}

	/**
	 * Propose the whole new content of a note, as the draft insert does from
	 * the editor's text. With `expectedBefore`, the note must still hold that
	 * text: an editor whose edits are not saved yet differs from the vault,
	 * and a proposal built on the editor would be stale the moment it is made.
	 */
	async proposeRewrite(conversationId: string, rawPath: string, after: string, summary: string, expectedBefore?: string): Promise<ChangeProposal> {
		const path = validateVaultPath(rawPath, { configDir: this.vault.configDir });
		const before = await this.vault.readNote(path);
		if (before === null) throw new ProposalError(`No note found at ${path}.`);
		if (expectedBefore !== undefined && before !== expectedBefore) {
			throw new ProposalError(`${path} has edits that are not saved yet. Wait a moment and try again.`);
		}
		return this.edit(conversationId, path, before, after, summary);
	}

	private async edit(conversationId: string, path: string, before: string, after: string, summary: string): Promise<ChangeProposal> {
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

	/** A new folder, with any missing parents. */
	proposeFolder(conversationId: string, rawPath: string, summary: string): ChangeProposal {
		const path = validateVaultPath(rawPath, { markdown: false, configDir: this.vault.configDir });
		if (/\.md$/i.test(path)) throw new ProposalError(`${path} looks like a note. Use propose_create_note for notes; folders are created as needed.`);
		if (this.vault.exists(path)) {
			throw new ProposalError(this.vault.isFolder(path) ? `The folder ${path} already exists.` : `A file already exists at ${path}.`);
		}
		return this.base(conversationId, 'folder', path, null, '', null, summary);
	}

	/** Move or rename a note. Obsidian updates links to it when the move is applied. */
	async proposeMove(conversationId: string, rawPath: string, rawNewPath: string, summary: string): Promise<ChangeProposal> {
		const path = validateVaultPath(rawPath, { configDir: this.vault.configDir });
		const newPath = validateVaultPath(rawNewPath, { configDir: this.vault.configDir });
		if ((await this.vault.readNote(path)) === null) throw new ProposalError(`No note found at ${path}.`);
		if (newPath === path) throw new ProposalError('The new path is the same as the current one.');
		if (this.vault.exists(newPath)) throw new ProposalError(`A file already exists at ${newPath}. Choose another name.`);
		const proposal = this.base(conversationId, 'move', path, null, '', null, summary);
		proposal.newPath = newPath;
		proposal.linkUpdates = await this.linkUpdates(path, newPath);
		return proposal;
	}

	/**
	 * Set or remove properties. The change is written by Obsidian's
	 * `processFrontMatter` when approved; what is reviewed is each property's
	 * value before and after. A value given as text for a property the note
	 * holds as a number or a checkbox keeps that type when the text says one.
	 */
	async proposeFrontmatter(conversationId: string, rawPath: string, edits: PropertyEdit[], summary: string): Promise<ChangeProposal> {
		const path = validateVaultPath(rawPath, { configDir: this.vault.configDir });
		const before = await this.vault.readNote(path);
		if (before === null) throw new ProposalError(`No note found at ${path}.`);
		if (edits.length === 0) throw new ProposalError('No property changes supplied.');
		const current = this.vault.getMetadata(path)?.frontmatter ?? {};
		const changes: PropertyChange[] = [];
		for (const edit of edits) {
			const key = edit.key.trim();
			if (key === '' || /[\n\r]/.test(key)) throw new ProposalError(`"${edit.key}" is not a property name that can be changed.`);
			if (changes.some((c) => c.key === key)) throw new ProposalError(`The property "${key}" is changed more than once. Change each property once.`);
			const had = Object.prototype.hasOwnProperty.call(current, key);
			const change: PropertyChange = { key };
			if (had) change.before = current[key];
			if (!edit.remove) change.after = keepType(current[key], edit.value);
			if (had === (change.after !== undefined) && sameValue(change.before, change.after)) continue;
			changes.push(change);
		}
		if (changes.length === 0) throw new ProposalError('The proposed property change makes no changes.');
		rejectNewPlaceholders(changes.map((c) => formatValue(c.before)).join('\n'), changes.map((c) => formatValue(c.after)).join('\n'));
		const proposal = this.base(conversationId, 'frontmatter', path, before, '', await hashContent(before), summary);
		proposal.properties = changes;
		return proposal;
	}

	private base(
		conversationId: string,
		kind: ProposalKind,
		path: string,
		before: string | null,
		after: string,
		baseHash: string | null,
		summary: string,
	): ChangeProposal {
		return { id: this.newId(), conversationId, kind, path, before, after, baseHash, summary, status: 'pending', createdAt: this.now() };
	}

	/**
	 * Notes whose links Obsidian rewrites when `from` moves to `to`: every
	 * note linking to it when its name changes or the new name is shared
	 * with another note (the shortest link then needs a folder), else the
	 * notes that link to it by path.
	 */
	private async linkUpdates(from: string, to: string): Promise<string[]> {
		const refs = await this.vault.linksTo(from);
		const name = baseName(to).toLowerCase();
		const shared = this.vault.listMarkdownFiles().some((f) => f.path !== from && f.name.toLowerCase() === name);
		const all = baseName(from) !== baseName(to) || shared;
		return [...new Set(refs.filter((r) => all || r.link.includes('/')).map((r) => r.source))].sort();
	}

	diff(p: ChangeProposal): DiffLine[] {
		if (p.kind === 'frontmatter') return propertyDiff(p.properties ?? []);
		if (p.kind === 'folder' || p.kind === 'move') return [];
		return diffLines(p.before ?? '', p.after);
	}

	stats(p: ChangeProposal): { added: number; removed: number } {
		return diffStats(this.diff(p));
	}

	/**
	 * Re-check a pending proposal against the vault. Returns `stale` when the
	 * note changed since the proposal was computed, `missing` when it is gone,
	 * and `exists` when something took the path a create, folder or move needs.
	 */
	async checkFreshness(p: ChangeProposal): Promise<'fresh' | 'stale' | 'missing' | 'exists'> {
		if (p.kind === 'create' || p.kind === 'folder') return this.vault.exists(p.path) ? 'exists' : 'fresh';
		if (p.kind === 'move') {
			if (!this.vault.exists(p.path)) return 'missing';
			return this.vault.exists(p.newPath ?? '') ? 'exists' : 'fresh';
		}
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
		return !this.busy.has(p) && (p.status === 'pending' || p.status === 'stale');
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
		this.claim([p]);
		try {
			return await this.write(p);
		} finally {
			this.release([p]);
		}
	}

	/** Hold proposals while one operation writes them, refusing any another operation already holds. */
	private claim(proposals: readonly ChangeProposal[]): void {
		const held = proposals.find((p) => this.busy.has(p));
		if (held) throw new ProposalError(`${held.path} is already being changed. Wait for that to finish.`);
		for (const p of proposals) this.busy.add(p);
	}

	private release(proposals: readonly ChangeProposal[]): void {
		for (const p of proposals) this.busy.delete(p);
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
			throw new ProposalError(`A file already exists at ${claimedPath(p)}.`);
		}
		try {
			if (p.kind === 'create') {
				await this.vault.createNote(p.path, p.after);
			} else if (p.kind === 'folder') {
				await this.vault.createFolder(p.path);
			} else if (p.kind === 'move') {
				const newPath = p.newPath ?? '';
				p.linkUpdates = await this.linkUpdates(p.path, newPath);
				await this.moveNote(p.path, newPath);
			} else if (p.kind === 'frontmatter') {
				p.snapshotPath = await this.writeSnapshot(p);
				// Final guard inside the atomic write: each property still holds what was reviewed.
				p.after = await this.setProperties(p, 'before', 'after', 'The note changed while applying. Nothing was written.');
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
	 * applied. A note moved back takes with it the folder its move made, while
	 * that is empty. Returns the proposals applied; resolved ones are skipped.
	 */
	async applyAll(batch: readonly ChangeProposal[]): Promise<ChangeProposal[]> {
		const pending = applyOrder(batch.filter((p) => p.status === 'pending' || p.status === 'stale'));
		if (pending.length === 0) return [];
		const seen = new Set<string>();
		for (const p of pending) {
			const repeated = touchedPaths(p).find((path) => seen.has(path));
			if (repeated) {
				throw new ProposalError(
					`Nothing was applied: ${repeated} has more than one change waiting in this batch. Approve or reject those changes one at a time.`,
				);
			}
			touchedPaths(p).forEach((path) => seen.add(path));
		}
		this.claim(pending);
		try {
			for (const p of pending) {
				const freshness = await this.checkFreshness(p);
				if (freshness === 'stale') p.status = 'stale';
				else if (freshness === 'fresh') p.status = 'pending';
				if (freshness !== 'fresh') throw new ProposalError(`Nothing was applied: ${freshnessProblem(p, freshness)}`);
			}
			const written: ChangeProposal[] = [];
			const moveFolders = new Map<ChangeProposal, string | null>();
			for (const p of pending) {
				try {
					if (p.kind === 'move') moveFolders.set(p, this.missingFolder(p.newPath ?? ''));
					await this.write(p);
				} catch (e) {
					const outcome = await this.rollBack(written, moveFolders);
					throw new ProposalError(
						`Applied ${written.length} of ${pending.length} changes, then ${p.path} failed: ${trimDot(errorMessage(e))}.` +
							describeRollback(pending, outcome, 'rolled back', 'written'),
					);
				}
				written.push(p);
			}
			return batch.filter((p) => written.includes(p));
		} finally {
			this.release(pending);
		}
	}

	/**
	 * Undo all: revert every applied proposal of a batch, all or nothing.
	 * Every note is checked first; if any changed since the batch applied,
	 * nothing is undone and the error names it. Changes are undone newest
	 * first, so a note the batch changed twice is checked against its latest
	 * change and walked back one change at a time. Edits are restored from
	 * their snapshots as `revert` does. A note the batch created is moved to
	 * the trash with `trashFile`, only while it still holds exactly what the
	 * batch wrote. Should an undo fail partway, the changes already undone
	 * are put back. Per-note `revert` is unchanged and never removes a
	 * created note. Returns the proposals undone, in batch order.
	 */
	async revertAll(batch: readonly ChangeProposal[]): Promise<ChangeProposal[]> {
		const applied = batch.filter((p) => p.status === 'applied' && undoable(p));
		if (applied.length === 0) return [];
		const order = applyOrder(applied);
		const newestFirst = order
			.map((p, i) => ({ p, i }))
			.sort((a, b) => (b.p.resolvedAt ?? 0) - (a.p.resolvedAt ?? 0) || b.i - a.i)
			.map(({ p }) => p);
		this.claim(applied);
		try {
			const expected = new Map<string, string | null>();
			// Where a note's text is read from during the check: a move undone earlier in the walk puts the note back at its old path.
			const readFrom = new Map<string, string>();
			const vacated = new Set<string>();
			const existsThen = (path: string) => (expected.has(path) ? expected.get(path) !== null : readFrom.has(path) || (this.vault.exists(path) && !vacated.has(path)));
			// Notes whose links a move rewrote: moving it back first rewrites them back, so their text is checked only when they are undone.
			const relinked = new Set<string>();
			for (const p of newestFirst) {
				if (p.kind === 'move') {
					const newPath = p.newPath ?? '';
					if (!existsThen(newPath)) throw new ProposalError(`Nothing was undone: ${newPath} no longer exists.`);
					if (existsThen(p.path)) throw new ProposalError(`Nothing was undone: a file now exists at ${p.path}, so ${newPath} cannot move back.`);
					readFrom.set(p.path, readFrom.get(newPath) ?? newPath);
					readFrom.delete(newPath);
					vacated.add(newPath);
					const text = expected.get(newPath);
					if (text === undefined) expected.delete(p.path);
					else expected.set(p.path, text);
					expected.delete(newPath);
					for (const path of p.linkUpdates ?? []) relinked.add(path);
					if (relinked.delete(newPath)) relinked.add(p.path);
					continue;
				}
				const current = expected.has(p.path) ? (expected.get(p.path) ?? null) : await this.vault.readNote(readFrom.get(p.path) ?? p.path);
				if (current === null) throw new ProposalError(`Nothing was undone: ${p.path} no longer exists.`);
				const unchanged = current === p.after || relinked.has(p.path) || (p.kind === 'frontmatter' && !expected.has(p.path) && this.propertiesHold(p, readFrom.get(p.path) ?? p.path));
				if (!unchanged) {
					throw new ProposalError(`Nothing was undone: ${p.path} changed after this batch was applied. Undoing would overwrite those changes.`);
				}
				expected.set(p.path, p.kind === 'create' ? null : await this.restoreContent(p));
			}
			const undone: ChangeProposal[] = [];
			for (const p of newestFirst) {
				try {
					if (p.kind === 'create') await this.trashCreated(p);
					else if (p.kind === 'move') await this.undoMove(p);
					else if (p.kind === 'frontmatter') await this.undoFrontmatter(p, UNDO_CHANGED);
					else await this.undoEdit(p);
				} catch (e) {
					const outcome = await this.redo(undone);
					throw new ProposalError(
						`Undid ${undone.length} of ${applied.length} changes, then ${p.path} failed: ${trimDot(errorMessage(e))}.` +
							describeRollback(applied, outcome, 'put back', 'undone'),
					);
				}
				p.status = 'reverted';
				p.resolvedAt = this.now();
				undone.push(p);
			}
			return batch.filter((p) => undone.includes(p));
		} finally {
			this.release(applied);
		}
	}

	/** Trash a note the batch created while it still holds exactly what was written; otherwise refuse. */
	private async trashCreated(p: ChangeProposal): Promise<void> {
		const current = await this.vault.readNote(p.path);
		if (current !== p.after) throw new ProposalError(`${p.path} changed after it was written`);
		await this.vault.trashNote(p.path);
	}

	/** Put the notes a failed batch already wrote back to what they held before, newest first. */
	private async rollBack(written: readonly ChangeProposal[], moveFolders: ReadonlyMap<ChangeProposal, string | null>): Promise<RollbackOutcome> {
		const outcome: RollbackOutcome = { done: [], left: [], failed: [] };
		for (const p of [...written].reverse()) {
			try {
				if (p.kind === 'create') {
					await this.trashCreated(p);
				} else if (p.kind === 'folder') {
					if (!this.vault.isFolder(p.path) || !this.emptyTree(p.path)) throw new ProposalError(`${p.path} changed after it was written`);
					await this.vault.trashFolder(p.path);
				} else if (p.kind === 'move') {
					await this.moveBack(p, 'written');
					await this.trashEmptyFolder(moveFolders.get(p) ?? null);
				} else if (p.kind === 'frontmatter') {
					await this.undoFrontmatter(p, `${p.path} changed after it was written`);
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
				if (p.kind === 'frontmatter') p.after = '';
				outcome.done.push(p);
			} catch (e) {
				if (e instanceof ProposalError && /changed after it was written/.test(e.message)) outcome.left.push(p);
				else outcome.failed.push({ proposal: p, error: errorMessage(e) });
			}
		}
		return outcome;
	}

	/** Re-apply the changes a failed Undo all already undid, in the reverse of the order they were undone. */
	private async redo(undone: readonly ChangeProposal[]): Promise<RollbackOutcome> {
		const outcome: RollbackOutcome = { done: [], left: [], failed: [] };
		for (const p of [...undone].reverse()) {
			try {
				if (p.kind === 'create') {
					if (this.vault.exists(p.path)) throw new ProposalError(`${p.path} changed after it was undone`);
					await this.vault.createNote(p.path, p.after);
				} else if (p.kind === 'move') {
					const newPath = p.newPath ?? '';
					if (!this.vault.exists(p.path) || this.vault.exists(newPath)) throw new ProposalError(`${p.path} changed after it was undone`);
					await this.moveNote(p.path, newPath);
				} else if (p.kind === 'frontmatter') {
					p.after = await this.setProperties(p, 'before', 'after', `${p.path} changed after it was undone`);
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
		if (this.refreshable(p)) {
			p.status = 'rejected';
			p.resolvedAt = this.now();
		}
		return p;
	}

	/** Undo an applied edit or property change from its snapshot, or move a moved note back. */
	async revert(p: ChangeProposal): Promise<void> {
		if (p.status !== 'applied') throw new ProposalError('Only applied proposals can be reverted.');
		if (p.kind === 'create') {
			throw new ProposalError('Created notes are not deleted automatically. Delete the note yourself if you do not want it.');
		}
		if (p.kind === 'folder') {
			throw new ProposalError('Created folders are not deleted automatically. Delete the folder yourself if you do not want it.');
		}
		this.claim([p]);
		try {
			if (p.kind === 'move') await this.undoMove(p);
			else if (p.kind === 'frontmatter') await this.undoFrontmatter(p, UNDO_CHANGED);
			else await this.undoEdit(p);
		} finally {
			this.release([p]);
		}
		p.status = 'reverted';
		p.resolvedAt = this.now();
	}

	private async undoMove(p: ChangeProposal): Promise<void> {
		await this.moveBack(p, 'moved');
	}

	/** Move a moved note back to where it was, while it is still at its new path and nothing has taken the old one. */
	private async moveBack(p: ChangeProposal, step: 'written' | 'moved'): Promise<void> {
		const newPath = p.newPath ?? '';
		if (!this.vault.exists(newPath)) {
			throw new ProposalError(step === 'written' ? `${newPath} changed after it was written` : `${newPath} no longer exists, so it cannot be moved back.`);
		}
		if (this.vault.exists(p.path)) {
			throw new ProposalError(step === 'written' ? `${p.path} changed after it was written` : `A file now exists at ${p.path}, so ${newPath} cannot be moved back.`);
		}
		await this.moveNote(newPath, p.path);
	}

	/** Move a note. If the move fails, the folder made for it goes too, so a refused move leaves the vault as it was. */
	private async moveNote(from: string, to: string): Promise<void> {
		const created = this.missingFolder(to);
		try {
			await this.vault.moveNote(from, to);
		} catch (e) {
			await this.trashEmptyFolder(created);
			throw e;
		}
	}

	/** Remove a folder made for a move that did not stay, if it is empty. An empty folder left behind costs nothing, so a failure here is not reported. */
	private async trashEmptyFolder(folder: string | null): Promise<void> {
		if (folder && this.vault.isFolder(folder) && this.emptyTree(folder)) await this.vault.trashFolder(folder).catch(() => undefined);
	}

	/** The outermost folder above `path` that does not exist yet, or null. */
	private missingFolder(path: string): string | null {
		let missing: string | null = null;
		for (let folder = parentFolder(path); folder && !this.vault.exists(folder); folder = parentFolder(folder)) missing = folder;
		return missing;
	}

	/** Whether a folder holds nothing but empty folders. */
	private emptyTree(folder: string): boolean {
		return (this.vault.listFolder(folder)?.children ?? []).every((c) => this.vault.isFolder(c) && this.emptyTree(c));
	}

	private async undoEdit(p: ChangeProposal, changed = UNDO_CHANGED): Promise<void> {
		const restore = await this.restoreContent(p);
		await this.vault.processNote(p.path, (current) => {
			if (current !== p.after) throw new ProposalError(changed);
			return restore;
		});
	}

	/**
	 * Undo a property change: restore the snapshot while the note holds
	 * exactly what was written, else put each property back through
	 * `processFrontMatter` while it still holds the value written, so a
	 * change elsewhere in the note (Obsidian rewriting a link after a move,
	 * an edit to the body) is kept.
	 */
	private async undoFrontmatter(p: ChangeProposal, changed: string): Promise<void> {
		if ((await this.vault.readNote(p.path)) === p.after) {
			try {
				return await this.undoEdit(p, changed);
			} catch (e) {
				if (!(e instanceof ProposalError)) throw e;
			}
		}
		await this.setProperties(p, 'after', 'before', changed);
	}

	/** Through `processFrontMatter`: refuse unless each changed property holds its `from` value, then give it its `to` value (absent means removed). Resolves to the note as written. */
	private setProperties(p: ChangeProposal, from: 'before' | 'after', to: 'before' | 'after', changed: string): Promise<string> {
		const changes = p.properties ?? [];
		return this.vault.processFrontMatter(p.path, (fm) => {
			if (!changes.every((c) => holds(fm, c.key, c[from]))) throw new ProposalError(changed);
			for (const c of changes) {
				const value = c[to];
				if (value === undefined) delete fm[c.key];
				else fm[c.key] = value;
			}
		});
	}

	/** Whether the note's properties, as the metadata cache has them, hold every changed property's written value. */
	private propertiesHold(p: ChangeProposal, path: string): boolean {
		const fm = this.vault.getMetadata(path)?.frontmatter ?? {};
		return (p.properties ?? []).every((c) => holds(fm, c.key, c.after));
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

const UNDO_CHANGED = 'The note changed after this edit was applied. Reverting would overwrite those changes, so nothing was written.';

/** Whether `fm` has `value` under `key`, where an undefined value means the key is absent. */
function holds(fm: Record<string, unknown>, key: string, value: unknown): boolean {
	const has = Object.prototype.hasOwnProperty.call(fm, key);
	return value === undefined ? !has : has && sameValue(fm[key], value);
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
			return `a file already exists at ${claimedPath(p)}.`;
	}
}

/** The path a proposal needs to be free: the new note or folder, or a move's destination. */
function claimedPath(p: ChangeProposal): string {
	return p.kind === 'move' ? (p.newPath ?? p.path) : p.path;
}

/** A property value as the review shows it: text as is, lists as `[a, b]`, anything else as JSON. */
export function formatValue(value: unknown): string {
	if (value === undefined) return '';
	if (typeof value === 'string') return value;
	if (Array.isArray(value)) return `[${value.map((v) => (typeof v === 'string' ? v : JSON.stringify(v))).join(', ')}]`;
	return JSON.stringify(value);
}

/** The review of a property change as diff lines: `key: old` removed, `key: new` added. */
function propertyDiff(changes: readonly PropertyChange[]): DiffLine[] {
	const lines: DiffLine[] = [];
	for (const c of changes) {
		if (c.before !== undefined) lines.push({ op: 'del', text: `${c.key}: ${formatValue(c.before)}` });
		if (c.after !== undefined) lines.push({ op: 'add', text: `${c.key}: ${formatValue(c.after)}` });
	}
	return lines;
}

/** Deep equality for property values (JSON data). */
export function sameValue(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (a === undefined || b === undefined || a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
	if (Array.isArray(a) !== Array.isArray(b)) return false;
	if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => sameValue(v, b[i]));
	const ka = Object.keys(a);
	const kb = Object.keys(b);
	return ka.length === kb.length && ka.every((k) => sameValue((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/** A value given as text for a property that is a number or a checkbox keeps that type when the text spells one. */
function keepType(existing: unknown, value: unknown): unknown {
	if (typeof value !== 'string') return value;
	const text = value.trim();
	if (typeof existing === 'number' && text !== '' && Number.isFinite(Number(text))) return Number(text);
	if (typeof existing === 'boolean' && (text === 'true' || text === 'false')) return text === 'true';
	return value;
}

/** The sentences after a batch failure, in batch order: "The changes to A and B were rolled back. C was changed after it was written and was left as it is." */
function describeRollback(
	batch: readonly ChangeProposal[],
	outcome: RollbackOutcome,
	verb: 'rolled back' | 'put back',
	step: 'written' | 'undone',
): string {
	const order = (list: ChangeProposal[]) => batch.filter((p) => list.includes(p));
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
	for (const f of [...outcome.failed].sort((x, y) => batch.indexOf(x.proposal) - batch.indexOf(y.proposal))) text += ` ${f.proposal.path} could not be ${verb}: ${trimDot(f.error)}.`;
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
			case 'replace_section':
				try {
					text = replaceSection(text, op.heading, op.content);
				} catch (e) {
					if (e instanceof SectionError) throw new ProposalError(e.message);
					throw e;
				}
				break;
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
