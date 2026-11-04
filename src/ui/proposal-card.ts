import { App, Notice, setIcon } from 'obsidian';
import { DragonglassCore } from '../core';
import { Conversation } from '../persistence/conversation';
import { diffStats, toHunks } from '../vault/diff';
import { ChangeProposal, ProposalError, summarizeBatch } from '../vault/proposals';

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
	header.createDiv({ cls: 'dg-batch-title', text: `${plural(summary.changes, 'change')} across ${plural(summary.notes, 'note')}` });
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
				.then((applied) => new Notice(`Applied ${plural(applied.length, 'change')} to ${plural(new Set(applied.map((p) => p.path)).size, 'note')}`))
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

/** Icon, kind and the note's path as a link that opens it. */
function renderTitle(app: App, proposal: ChangeProposal, header: HTMLElement): void {
	const icon = header.createSpan({ cls: 'dg-proposal-icon' });
	setIcon(icon, proposal.kind === 'create' ? 'file-plus' : 'file-pen');
	const titleEl = header.createDiv({ cls: 'dg-proposal-title' });
	titleEl.createSpan({ cls: 'dg-proposal-kind', text: proposal.kind === 'create' ? 'Create' : 'Edit' });
	const pathLink = titleEl.createEl('a', { cls: 'dg-proposal-path', text: proposal.path, href: '#' });
	pathLink.addEventListener('click', (e) => {
		e.preventDefault();
		void app.workspace.openLinkText(proposal.path, '', false);
	});
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

	const lines = core.proposals.diff(proposal);
	const stats = diffStats(lines);
	const statsRow = container.createDiv({ cls: 'dg-proposal-stats' });
	statsRow.createSpan({ text: `+${stats.added} −${stats.removed} lines${showStatus ? ' · ' : ''}` });
	if (showStatus) statsRow.createSpan({ cls: `dg-proposal-status dg-status-${proposal.status}`, text: statusLabel(proposal.status) });

	const diffEl = container.createEl('pre', { cls: 'dg-diff' });
	const hunks = toHunks(lines, 3);
	for (const hunk of hunks) {
		if (hunk.skippedBefore > 0) diffEl.createDiv({ cls: 'dg-diff-skip', text: `… ${hunk.skippedBefore} unchanged lines` });
		for (const line of hunk.lines) {
			const row = diffEl.createDiv({ cls: `dg-diff-line dg-diff-${line.op}` });
			row.createSpan({ cls: 'dg-diff-sign', text: line.op === 'add' ? '+' : line.op === 'del' ? '−' : ' ' });
			row.createSpan({ cls: 'dg-diff-text', text: line.text });
		}
	}
	if (hunks.length === 0) diffEl.createDiv({ cls: 'dg-diff-skip', text: '(no visible changes)' });

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
				.then(() => new Notice(`Applied change to ${proposal.path}`))
				.catch((e: unknown) => new Notice(e instanceof ProposalError ? e.message : `Could not apply: ${String(e)}`))
				.finally(onChange);
		});
		const reject = actions.createEl('button', { text: 'Reject' });
		reject.addEventListener('click', () => {
			core.rejectProposal(conv, proposal);
			onChange();
		});
	} else if (proposal.status === 'applied' && proposal.kind === 'edit') {
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

function plural(n: number, noun: string): string {
	return `${n} ${noun}${n === 1 ? '' : 's'}`;
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
