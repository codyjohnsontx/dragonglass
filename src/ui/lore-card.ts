import { App, setIcon } from 'obsidian';
import type { LoreCheckRecord, LoreIssue } from '../agent/lore-check';
import { DragonglassCore } from '../core';
import { Conversation } from '../persistence/conversation';
import type { ChangeProposal } from '../vault/proposals';
import { renderProposalCard } from './proposal-card';

/**
 * The result of a lore check: one header row, then each issue as the script
 * line, what the vault says with the note linked, and Fix it and Intentional.
 * An issue with a live proposal shows the review in place of its buttons;
 * once that is rejected or undone the buttons come back.
 */

export interface LoreCardOptions {
	app: App;
	core: DragonglassCore;
	conv: Conversation;
	check: LoreCheckRecord;
	/** Propose the issue's corrected line. Resolves when the card should be redrawn. */
	fix: (issue: LoreIssue) => Promise<void>;
	/** Propose recording the issue in the canon note. Resolves when the card should be redrawn. */
	intentional: (issue: LoreIssue) => Promise<void>;
	/** Redraw after a review changed. */
	onChange: () => void;
}

export function renderLoreCard(container: HTMLElement, opts: LoreCardOptions): void {
	const { check } = opts;
	container.empty();
	container.addClass('dg-lore');
	const count = check.issues.length;

	const header = container.createDiv({ cls: 'dg-lore-header' });
	setIcon(header.createSpan({ cls: 'dg-lore-icon' }), 'scan-search');
	header.createSpan({ text: 'Lore check' });
	if (count > 0) header.createSpan({ cls: 'dg-lore-count', text: count === 1 ? '1 issue' : `${count} issues` });

	const clean = cleanMessage(check);
	if (clean) container.createDiv({ cls: 'dg-lore-clean', text: clean });
	if (count > 0) {
		const list = container.createEl('ul', { cls: 'dg-lore-issues' });
		for (const issue of check.issues) renderIssue(list, issue, opts);
	}
	for (const note of loreNotes(check)) container.createDiv({ cls: 'dg-lore-note', text: note });
}

function renderIssue(list: HTMLElement, issue: LoreIssue, opts: LoreCardOptions): void {
	const item = list.createEl('li', { cls: 'dg-lore-issue' });
	item.createDiv({ cls: 'dg-lore-line', text: issue.line });
	const says = item.createDiv({ cls: 'dg-lore-says' });
	says.appendText(`${issue.says} `);
	says.createEl('a', { cls: 'internal-link', text: issue.note, href: issue.notePath, attr: { 'data-href': issue.notePath } });

	const proposal = liveProposal(issue, opts.conv.proposals);
	if (proposal) {
		const review = item.createDiv({ cls: 'dg-lore-review' });
		review.dataset['proposalId'] = proposal.id;
		renderProposalCard(opts.app, opts.core, opts.conv, proposal, review, opts.onChange);
		return;
	}
	const actions = item.createDiv({ cls: 'dg-lore-actions' });
	const buttons: HTMLButtonElement[] = [];
	const add = (text: string, label: string, run: () => Promise<void>, cta: boolean): void => {
		const button = actions.createEl('button', { text, cls: cta ? 'mod-cta' : '', attr: { 'aria-label': label } });
		buttons.push(button);
		button.addEventListener('click', () => {
			for (const b of buttons) b.disabled = true;
			void run();
		});
	};
	if (issue.fix !== undefined) add('Fix it', `Propose this line instead: ${issue.fix}`, () => opts.fix(issue), true);
	add('Intentional', 'Propose recording this change in the sequel canon note', () => opts.intentional(issue), false);
}

/** The proposal an issue's review shows: one awaiting a decision or applied. Rejected, undone or failed, the issue is open again. */
export function liveProposal(issue: LoreIssue, proposals: Readonly<Record<string, ChangeProposal>>): ChangeProposal | null {
	const p = issue.proposalId ? proposals[issue.proposalId] : undefined;
	return p && (p.status === 'pending' || p.status === 'stale' || p.status === 'applied') ? p : null;
}

/** The line a check with nothing to list shows, claiming only what it covered; null with issues, or when nothing was checked. */
export function cleanMessage(check: LoreCheckRecord): string | null {
	if (check.issues.length > 0 || check.readNoLore) return null;
	if (check.leftOut) return 'No contradictions that could be verified.';
	return check.shown || check.canonShown || check.loreCut ? "No contradictions in what fit in the model's context." : 'No contradictions with the vault.';
}

/** What the reader should know about how far a check went. */
export function loreNotes(check: LoreCheckRecord): string[] {
	const notes: string[] = [];
	if (check.readNoLore) notes.push('The model read no lore notes, so nothing was checked. Run the check again.');
	if (check.shown) notes.push(`Only the first ${percentShown(check.shown)}% fit in the model's context. Select the rest to check it.`);
	if (check.canonShown) notes.push(`Only the first ${percentShown(check.canonShown)}% of the sequel canon note fit in the model's context, so a change further down can still be flagged.`);
	const cut = check.loreCut ?? 0;
	if (cut > 0) notes.push(`${cut} ${cut === 1 ? 'note' : 'notes'} the script names did not fit in the model's context in full, so a contradiction with ${cut === 1 ? 'it' : 'them'} can be missed.`);
	const left = check.leftOut ?? 0;
	if (left > 0) notes.push(`${left}${check.issues.length > 0 ? ' more' : ''} ${left === 1 ? 'flag was' : 'flags were'} left out: the line or the note cited could not be verified.`);
	return notes;
}

function percentShown(shown: { chars: number; of: number }): number {
	return Math.max(1, Math.floor((shown.chars / shown.of) * 100));
}
