import { App, setIcon } from 'obsidian';
import { DraftVersion, latestInsert } from '../agent/drafting';
import { DragonglassCore } from '../core';
import { Conversation } from '../persistence/conversation';
import { baseName } from '../vault/paths';
import { renderProposalCard } from './proposal-card';

/**
 * The draft card under a reply that drafted scene text: one header row (the
 * version stepper when there are several, Copy and Insert) over the scene
 * text, then the review of the latest insert, if any. It sits on the latest
 * version of a draft; earlier versions are a click away through the
 * stepper, and the one shown is what Copy and Insert act on.
 */

export interface DraftCardOptions {
	app: App;
	core: DragonglassCore;
	conv: Conversation;
	/** The thread's versions, oldest first; never empty. */
	versions: DraftVersion[];
	/** The version to show, by message id; the latest when null or unknown. */
	shown: string | null;
	/** The user stepped to a version; remembered across redraws. */
	onStep: (messageId: string) => void;
	/** Insert the version shown into the open note. Resolves when the card should be redrawn. */
	insert: (messageId: string) => Promise<void>;
	/** Draw a Copy button for `text` into `parent`. */
	copy: (parent: HTMLElement, text: string) => void;
	/** Redraw after the insert review changed. */
	onChange: () => void;
}

export function renderDraftCard(container: HTMLElement, opts: DraftCardOptions): void {
	const { versions } = opts;
	const last = versions[versions.length - 1];
	if (!last) return;
	container.empty();
	container.addClass('dg-draft');
	let index = Math.max(0, versions.findIndex((v) => v.messageId === opts.shown));
	if (opts.shown === null) index = versions.length - 1;

	const header = container.createDiv({ cls: 'dg-draft-header' });
	const title = header.createSpan({ cls: 'dg-draft-title' });
	setIcon(title.createSpan({ cls: 'dg-draft-icon' }), 'feather');
	title.appendText('Draft');

	let counter: HTMLElement | null = null;
	let earlier: HTMLButtonElement | null = null;
	let later: HTMLButtonElement | null = null;
	if (versions.length > 1) {
		const stepper = header.createSpan({ cls: 'dg-draft-stepper' });
		earlier = stepper.createEl('button', { cls: 'clickable-icon dg-draft-step', attr: { 'aria-label': 'Earlier version' } });
		setIcon(earlier, 'chevron-left');
		counter = stepper.createSpan({ cls: 'dg-draft-counter' });
		later = stepper.createEl('button', { cls: 'clickable-icon dg-draft-step', attr: { 'aria-label': 'Later version' } });
		setIcon(later, 'chevron-right');
	}
	header.createSpan({ cls: 'dg-draft-spacer' });
	const actions = header.createSpan({ cls: 'dg-draft-actions' });
	const text = container.createEl('pre', { cls: 'dg-draft-text' });

	const show = (): void => {
		const version = versions[index]!;
		text.setText(version.text);
		if (counter) counter.setText(`${version.number} of ${versions.length}`);
		if (earlier) earlier.disabled = index === 0;
		if (later) later.disabled = index === versions.length - 1;
		actions.empty();
		opts.copy(actions, version.text);
		const insert = actions.createEl('button', { cls: 'mod-cta dg-draft-insert' });
		labelInsertButton(insert, opts.core.vault.getActiveContext().path);
		insert.addEventListener('click', () => {
			insert.disabled = true;
			void opts.insert(version.messageId);
		});
	};
	const step = (delta: number): void => {
		index = Math.min(versions.length - 1, Math.max(0, index + delta));
		opts.onStep(versions[index]!.messageId);
		show();
	};
	earlier?.addEventListener('click', () => step(-1));
	later?.addEventListener('click', () => step(1));
	show();

	const proposal = latestInsert(versions, opts.conv.proposals);
	if (proposal) {
		const review = container.createDiv({ cls: 'dg-draft-review' });
		review.dataset['proposalId'] = proposal.id;
		renderProposalCard(opts.app, opts.core, opts.conv, proposal, review, opts.onChange);
	}
}

/** The Insert button names the note it would go into, and waits while no note is open. */
export function labelInsertButton(button: HTMLButtonElement, activePath: string | null): void {
	button.setText(activePath ? `Insert into ${baseName(activePath)}` : 'Insert');
	button.disabled = activePath === null;
	button.setAttribute('aria-label', activePath ? `Insert into ${activePath}, over the selection or at the cursor` : 'Open a note to insert the draft into');
}

/** Relabel every Insert button under `root` for the note now open. */
export function labelInsertButtons(root: HTMLElement, activePath: string | null): void {
	root.querySelectorAll<HTMLButtonElement>('.dg-draft-insert').forEach((b) => labelInsertButton(b, activePath));
}

/** On an earlier version's reply: one line naming the version, which shows it in the card below. */
export function renderDraftRef(parent: HTMLElement, number: number, total: number, onClick: () => void): void {
	const ref = parent.createEl('button', { cls: 'dg-draft-ref', text: `Draft ${number} of ${total}`, attr: { 'aria-label': `Show draft version ${number} of ${total}` } });
	ref.addEventListener('click', onClick);
}
