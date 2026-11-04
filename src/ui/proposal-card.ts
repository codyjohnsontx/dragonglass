import { App, Notice, setIcon } from 'obsidian';
import { DragonglassCore } from '../core';
import { Conversation } from '../persistence/conversation';
import { diffStats, toHunks } from '../vault/diff';
import { baseName, parentFolder } from '../vault/paths';
import { ChangeProposal, ProposalError, revertible, summarizeBatch } from '../vault/proposals';

/** Renders one change proposal with its diff and approve / reject / revert controls. */
export function renderProposalCard(
	app: App,
	core: DragonglassCore,
	conv: Conversation,
	proposal: ChangeProposal,
	container: HTMLElement,
	onChange: () => void,
): void {
	container.empty();
	container.addClass('dg-proposal');
	container.dataset['status'] = proposal.status;
	renderTitle(app, proposal, container.createDiv({ cls: 'dg-proposal-header' }));
	renderDetails(app, core, conv, proposal, container, onChange, true);
}

/**
 * Renders the proposals of one turn as a single review: a header with Approve
 * all and Reject all (or Undo all once applied), then each note's proposal as
 * a collapsible section that keeps its own controls. Approve all is disabled
 * while a note is known to be out of date, and the header names that note.
 */
export function renderBatchCard(
	app: App,
	core: DragonglassCore,
	conv: Conversation,
	batch: readonly ChangeProposal[],
	container: HTMLElement,
	onChange: () => void,
): void {
	container.empty();
	container.addClass('dg-batch');
	const summary = summarizeBatch(batch);
	container.dataset['status'] = summary.pending.length > 0 ? (summary.blocker ? 'stale' : 'pending') : summary.applied.length > 0 ? 'applied' : 'resolved';

	const header = container.createDiv({ cls: 'dg-proposal-header dg-batch-header' });
	setIcon(header.createSpan({ cls: 'dg-proposal-icon' }), 'files');
	header.createDiv({ cls: 'dg-batch-title', text: `${plural(summary.changes, 'change')} across ${across(summary.notes, summary.folders)}` });
	container.createDiv({ cls: 'dg-proposal-stats', text: statusCounts(batch) });

	const actions = container.createDiv({ cls: 'dg-proposal-actions dg-batch-actions' });
	if (summary.pending.length > 0) {
		const blocker = summary.blocker;
		if (blocker) {
			const warning = actions.createDiv({ cls: 'dg-proposal-warning dg-batch-blocked' });
			warning.appendText('Approve all is blocked: ');
			const link = warning.createEl('a', { text: blocker.path, href: '#' });
			link.addEventListener('click', (e) => {
				e.preventDefault();
				revealItem(container, blocker.id);
			});
			warning.appendText(' changed since it was proposed. Reject that change, or undo your edit, to approve the rest together.');
		}
		const approveAll = actions.createEl('button', { cls: 'mod-cta', text: 'Approve all' });
		approveAll.disabled = blocker !== null;
		approveAll.addEventListener('click', () => {
			disableControls(container);
			void core
				.approveAll(conv, batch)
				.then((applied) => {
					const { notes, folders } = summarizeBatch(applied);
					new Notice(`Applied ${plural(applied.length, 'change')} to ${across(notes, folders)}`);
				})
				.catch((e: unknown) => new Notice(e instanceof ProposalError ? e.message : `Could not apply: ${String(e)}`, 10000))
				.finally(onChange);
		});
		const rejectAll = actions.createEl('button', { text: 'Reject all' });
		rejectAll.addEventListener('click', () => {
			core.rejectAll(conv, batch);
			onChange();
		});
	} else if (summary.applied.length > 0) {
		const undoAll = actions.createEl('button', { text: 'Undo all' });
		undoAll.addEventListener('click', () => {
			disableControls(container);
			void core
				.revertAll(conv, batch)
				.then((undone) => new Notice(`Undid ${plural(undone.length, 'change')}`))
				.catch((e: unknown) => new Notice(e instanceof ProposalError ? e.message : `Could not undo: ${String(e)}`, 10000))
				.finally(onChange);
		});
	}

	const items = container.createDiv({ cls: 'dg-batch-items' });
	for (const proposal of batch) {
		const item = items.createEl('details', { cls: 'dg-batch-item' });
		item.dataset['proposalId'] = proposal.id;
		item.dataset['status'] = proposal.status;
		item.open = proposal.status === 'pending' || proposal.status === 'stale';
		const title = item.createEl('summary', { cls: 'dg-proposal-header' });
		renderTitle(app, proposal, title);
		title.createSpan({ cls: `dg-proposal-status dg-status-${proposal.status}`, text: statusLabel(proposal.status) });
		renderDetails(app, core, conv, proposal, item, onChange, false);
	}
}

/** Disable every button of a batch card while Approve all or Undo all runs; the re-render after it finishes restores them. */
function disableControls(container: HTMLElement): void {
	container.querySelectorAll('button').forEach((button) => {
		button.disabled = true;
	});
}

/** Open the section for `proposalId` and scroll it into view. */
function revealItem(container: HTMLElement, proposalId: string): void {
	const item = container.querySelector<HTMLDetailsElement>(`[data-proposal-id="${proposalId}"]`);
	if (!item) return;
	item.open = true;
	item.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/** Icon, kind and the note's path as a link that opens it; a folder's path is plain text. */
function renderTitle(app: App, proposal: ChangeProposal, header: HTMLElement): void {
	const icon = header.createSpan({ cls: 'dg-proposal-icon' });
	setIcon(icon, KIND_ICON[proposal.kind]);
	const titleEl = header.createDiv({ cls: 'dg-proposal-title' });
	titleEl.createSpan({ cls: 'dg-proposal-kind', text: kindLabel(proposal) });
	if (proposal.kind === 'folder') {
		appendPath(titleEl.createSpan({ cls: 'dg-proposal-path' }), `${proposal.path}/`);
		return;
	}
	// Once a move is applied the note lives at its new path.
	const where = proposal.kind === 'move' && proposal.status === 'applied' ? (proposal.newPath ?? proposal.path) : proposal.path;
	const pathLink = titleEl.createEl('a', { cls: 'dg-proposal-path', href: '#' });
	appendPath(pathLink, proposal.path);
	pathLink.addEventListener('click', (e) => {
		e.preventDefault();
		void app.workspace.openLinkText(where, '', false);
	});
}

/** A path that a narrow sidebar may wrap after any slash, rather than inside a name. */
function appendPath(el: HTMLElement, path: string): void {
	path.split('/').forEach((part, i, parts) => {
		el.appendText(i < parts.length - 1 ? `${part}/` : part);
		if (i < parts.length - 1) el.createEl('wbr');
	});
}

const KIND_ICON: Record<ChangeProposal['kind'], string> = {
	create: 'file-plus',
	edit: 'file-pen',
	folder: 'folder-plus',
	move: 'file-symlink',
	frontmatter: 'list',
};

/** Create, Edit, New folder, Properties, and Rename or Move (a rename keeps the folder). */
function kindLabel(p: ChangeProposal): string {
	switch (p.kind) {
		case 'create':
			return 'Create';
		case 'edit':
			return 'Edit';
		case 'folder':
			return 'New folder';
		case 'frontmatter':
			return 'Properties';
		case 'move':
			return parentFolder(p.path) === parentFolder(p.newPath ?? '') ? 'Rename' : 'Move';
	}
}

/** The stats row's text: lines for a text change, properties for a frontmatter change, nothing for a move or folder. */
function statsText(core: DragonglassCore, p: ChangeProposal): string {
	if (p.kind === 'frontmatter') return plural(p.properties?.length ?? 0, 'property', 'properties');
	if (p.kind === 'move' || p.kind === 'folder') return '';
	const stats = diffStats(core.proposals.diff(p));
	return `+${stats.added} −${stats.removed} lines`;
}

/** What a move's card says about links, or null when a move that did not happen, or was undone, has nothing true to say about them. */
export function moveLinksText(p: ChangeProposal): string | null {
	const count = p.linkUpdates?.length ?? 0;
	if (count === 0) return baseName(p.path) === baseName(p.newPath ?? '') ? 'No links need to change.' : 'No other notes link to it.';
	switch (p.status) {
		case 'pending':
		case 'stale':
			return `Obsidian will update the links to it in ${plural(count, 'note')}, and asks first if "Automatically update internal links" is off:`;
		case 'applied':
			return `Obsidian updated the links to it in ${plural(count, 'note')}, unless you chose not to when it asked:`;
		default:
			return null;
	}
}

/** What a move does: from, to, and the notes whose links Obsidian rewrites. */
function renderMove(app: App, p: ChangeProposal, container: HTMLElement): void {
	const box = container.createDiv({ cls: 'dg-move' });
	const row = (label: string, path: string) => {
		const r = box.createDiv({ cls: 'dg-move-row' });
		r.createSpan({ cls: 'dg-move-label', text: label });
		appendPath(r.createSpan({ cls: 'dg-move-path' }), path);
	};
	row('From', p.path);
	row('To', p.newPath ?? '');
	const text = moveLinksText(p);
	if (text === null) return;
	const note = box.createDiv({ cls: 'dg-move-links' });
	note.setText(text);
	const links = p.linkUpdates ?? [];
	if (links.length === 0) return;
	const list = note.createEl('ul', { cls: 'dg-move-link-list' });
	for (const path of links) {
		const a = list.createEl('li').createEl('a', { text: path, href: '#' });
		a.addEventListener('click', (e) => {
			e.preventDefault();
			void app.workspace.openLinkText(path, '', false);
		});
	}
}

/** Summary, stats, diff and the proposal's own approve / reject / revert controls. The status goes on the stats row unless the title already shows it. */
function renderDetails(
	app: App,
	core: DragonglassCore,
	conv: Conversation,
	proposal: ChangeProposal,
	container: HTMLElement,
	onChange: () => void,
	showStatus: boolean,
): void {
	container.createDiv({ cls: 'dg-proposal-summary', text: proposal.summary });

	const stats = statsText(core, proposal);
	if (stats || showStatus) {
		const statsRow = container.createDiv({ cls: 'dg-proposal-stats' });
		if (stats) statsRow.createSpan({ text: `${stats}${showStatus ? ' · ' : ''}` });
		if (showStatus) statsRow.createSpan({ cls: `dg-proposal-status dg-status-${proposal.status}`, text: statusLabel(proposal.status) });
	}

	if (proposal.kind === 'move') renderMove(app, proposal, container);
	else if (proposal.kind !== 'folder') renderDiff(core, proposal, container);

	const actions = container.createDiv({ cls: 'dg-proposal-actions' });
	if (proposal.status === 'pending' || proposal.status === 'stale') {
		if (proposal.status === 'stale') {
			actions.createSpan({ cls: 'dg-proposal-warning', text: 'The note changed since this was proposed. Approving is blocked; reject and ask again.' });
		}
		const approve = actions.createEl('button', { cls: 'mod-cta', text: 'Approve' });
		approve.disabled = proposal.status === 'stale';
		approve.addEventListener('click', () => {
			approve.disabled = true;
			void core
				.approveProposal(conv, proposal)
				.then(() => new Notice(appliedNotice(proposal)))
				.catch((e: unknown) => new Notice(e instanceof ProposalError ? e.message : `Could not apply: ${String(e)}`))
				.finally(onChange);
		});
		const reject = actions.createEl('button', { text: 'Reject' });
		reject.addEventListener('click', () => {
			core.rejectProposal(conv, proposal);
			onChange();
		});
	} else if (proposal.status === 'applied' && !revertible(proposal)) {
		actions.createSpan({
			cls: 'dg-proposal-note',
			text:
				proposal.kind === 'folder'
					? 'Revert and Undo all do not remove a new folder. Delete it yourself if you do not want it.'
					: 'Revert does not delete a new note. Delete it yourself if you do not want it.',
		});
	} else if (proposal.status === 'applied') {
		const revert = actions.createEl('button', { text: 'Revert' });
		revert.addEventListener('click', () => {
			revert.disabled = true;
			void core
				.revertProposal(conv, proposal)
				.then(() => new Notice(`Reverted ${proposal.path}`))
				.catch((e: unknown) => new Notice(e instanceof ProposalError ? e.message : `Could not revert: ${String(e)}`))
				.finally(onChange);
		});
	}
	if (proposal.error) actions.createSpan({ cls: 'dg-proposal-warning', text: proposal.error });
}

/** The change as diff lines: the note's text, or for properties each one's old and new value. */
function renderDiff(core: DragonglassCore, proposal: ChangeProposal, container: HTMLElement): void {
	const diffEl = container.createEl('pre', { cls: 'dg-diff' });
	const hunks = toHunks(core.proposals.diff(proposal), 3);
	for (const hunk of hunks) {
		if (hunk.skippedBefore > 0) diffEl.createDiv({ cls: 'dg-diff-skip', text: `… ${hunk.skippedBefore} unchanged lines` });
		for (const line of hunk.lines) {
			const row = diffEl.createDiv({ cls: `dg-diff-line dg-diff-${line.op}` });
			row.createSpan({ cls: 'dg-diff-sign', text: line.op === 'add' ? '+' : line.op === 'del' ? '−' : ' ' });
			row.createSpan({ cls: 'dg-diff-text', text: line.text });
		}
	}
	if (hunks.length === 0) diffEl.createDiv({ cls: 'dg-diff-skip', text: '(no visible changes)' });
}

function appliedNotice(p: ChangeProposal): string {
	switch (p.kind) {
		case 'create':
			return `Created ${p.path}`;
		case 'folder':
			return `Created the folder ${p.path}`;
		case 'move':
			return `Moved ${p.path} to ${p.newPath ?? ''}`;
		default:
			return `Applied change to ${p.path}`;
	}
}

/** "2 awaiting review · 1 applied", in status order. */
function statusCounts(batch: readonly ChangeProposal[]): string {
	const order: ChangeProposal['status'][] = ['pending', 'stale', 'applied', 'rejected', 'reverted', 'failed'];
	const counts = new Map<ChangeProposal['status'], number>();
	for (const p of batch) counts.set(p.status, (counts.get(p.status) ?? 0) + 1);
	return order
		.filter((s) => counts.has(s))
		.map((s) => `${counts.get(s)} ${statusLabel(s).toLowerCase()}`)
		.join(' · ');
}

/** "3 notes", "1 folder", or "3 notes and 1 folder". */
function across(notes: number, folders: number): string {
	if (folders === 0) return plural(notes, 'note');
	if (notes === 0) return plural(folders, 'folder');
	return `${plural(notes, 'note')} and ${plural(folders, 'folder')}`;
}

function plural(n: number, noun: string, many = `${noun}s`): string {
	return `${n} ${n === 1 ? noun : many}`;
}

function statusLabel(status: ChangeProposal['status']): string {
	switch (status) {
		case 'pending':
			return 'Awaiting review';
		case 'applied':
			return 'Applied';
		case 'rejected':
			return 'Rejected';
		case 'reverted':
			return 'Reverted';
		case 'stale':
			return 'Out of date';
		case 'failed':
			return 'Failed';
	}
}
