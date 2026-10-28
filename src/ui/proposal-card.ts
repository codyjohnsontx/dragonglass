import { App, Notice, setIcon } from 'obsidian';
import { DragonglassCore } from '../core';
import { Conversation } from '../persistence/conversation';
import { diffStats, toHunks } from '../vault/diff';
import { ChangeProposal, ProposalError } from '../vault/proposals';

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

	const header = container.createDiv({ cls: 'dg-proposal-header' });
	const icon = header.createSpan({ cls: 'dg-proposal-icon' });
	setIcon(icon, proposal.kind === 'create' ? 'file-plus' : 'file-pen');
	const titleEl = header.createDiv({ cls: 'dg-proposal-title' });
	titleEl.createSpan({ cls: 'dg-proposal-kind', text: proposal.kind === 'create' ? 'Create' : 'Edit' });
	const pathLink = titleEl.createEl('a', { cls: 'dg-proposal-path', text: proposal.path, href: '#' });
	pathLink.addEventListener('click', (e) => {
		e.preventDefault();
		void app.workspace.openLinkText(proposal.path, '', false);
	});
	header.createSpan({ cls: `dg-proposal-status dg-status-${proposal.status}`, text: statusLabel(proposal.status) });

	container.createDiv({ cls: 'dg-proposal-summary', text: proposal.summary });

	const lines = core.proposals.diff(proposal);
	const stats = diffStats(lines);
	container.createDiv({ cls: 'dg-proposal-stats', text: `+${stats.added} −${stats.removed} lines` });

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

function statusLabel(status: ChangeProposal['status']): string {
	switch (status) {
		case 'pending':
			return 'Awaiting review';
		case 'applied':
			return 'Applied';
		case 'rejected':
			return 'Rejected';
		case 'stale':
			return 'Out of date';
		case 'failed':
			return 'Failed';
	}
}
