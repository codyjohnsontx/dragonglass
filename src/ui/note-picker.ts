import { App, FuzzySuggestModal, TFile } from 'obsidian';

/** Fuzzy picker for attaching a note to the next message. */
export class NotePickerModal extends FuzzySuggestModal<TFile> {
	constructor(
		app: App,
		private readonly onPick: (file: TFile) => void,
	) {
		super(app);
		this.setPlaceholder('Attach a note as context…');
	}

	getItems(): TFile[] {
		return this.app.vault.getMarkdownFiles().sort((a, b) => b.stat.mtime - a.stat.mtime);
	}

	getItemText(item: TFile): string {
		return item.path;
	}

	onChooseItem(item: TFile): void {
		this.onPick(item);
	}
}
