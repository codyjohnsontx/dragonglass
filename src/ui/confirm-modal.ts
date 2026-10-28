import { App, Modal } from 'obsidian';

export interface ConfirmOptions {
	title: string;
	body: string;
	/** Label of the confirming button, for example "Delete". */
	confirmText: string;
	/** Styles the confirming button as a warning and keeps focus on Cancel. */
	destructive?: boolean;
	onConfirm: () => void | Promise<void>;
}

/** A small yes/no dialog. Escape and the Cancel button both dismiss it without calling back. */
export class ConfirmModal extends Modal {
	constructor(
		app: App,
		private readonly opts: ConfirmOptions,
	) {
		super(app);
	}

	onOpen(): void {
		this.setTitle(this.opts.title);
		this.contentEl.createEl('p', { text: this.opts.body });
		const row = this.contentEl.createDiv({ cls: 'modal-button-container' });
		const confirm = row.createEl('button', {
			cls: this.opts.destructive ? 'mod-warning' : 'mod-cta',
			text: this.opts.confirmText,
		});
		confirm.addEventListener('click', () => {
			this.close();
			void this.opts.onConfirm();
		});
		const cancel = row.createEl('button', { text: 'Cancel' });
		cancel.addEventListener('click', () => this.close());
		(this.opts.destructive ? cancel : confirm).focus();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
