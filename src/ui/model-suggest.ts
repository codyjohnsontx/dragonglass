import { AbstractInputSuggest, App } from 'obsidian';
import { ModelChoices } from '../providers/model-choices';
import { ModelInfo } from '../providers/types';

/**
 * Suggests models under a model id text field. The field stays free text, so
 * an id the list does not offer can still be typed. The list is fetched once
 * per focus; until the user types, every model is shown rather than only the
 * one already in the field.
 */
export class ModelSuggest extends AbstractInputSuggest<ModelInfo> {
	private choices: Promise<ModelChoices> | null = null;
	private typed = false;

	constructor(
		app: App,
		inputEl: HTMLInputElement,
		private readonly load: () => Promise<ModelChoices>,
		private readonly onPick: (id: string) => void,
	) {
		super(app, inputEl);
		inputEl.addEventListener('focus', () => {
			this.choices = null;
			this.typed = false;
		});
		inputEl.addEventListener('input', () => {
			this.typed = true;
		});
	}

	protected async getSuggestions(query: string): Promise<ModelInfo[]> {
		this.choices ??= this.load();
		const { models } = await this.choices;
		const q = query.trim().toLowerCase();
		if (!this.typed || !q) return models;
		return models.filter((m) => m.id.toLowerCase().includes(q) || (m.label ?? '').toLowerCase().includes(q));
	}

	renderSuggestion(model: ModelInfo, el: HTMLElement): void {
		const content = el.createDiv({ cls: 'suggestion-content' });
		content.createDiv({ cls: 'suggestion-title', text: model.label ?? model.id });
		if (model.label && model.label !== model.id) content.createDiv({ cls: 'suggestion-note', text: model.id });
	}

	selectSuggestion(model: ModelInfo): void {
		this.setValue(model.id);
		this.onPick(model.id);
		this.typed = false;
		this.close();
	}
}
