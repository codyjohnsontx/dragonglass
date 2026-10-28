/**
 * Minimal stand-in for the `obsidian` module in unit tests. Only modules that
 * never touch the Obsidian API are exercised in vitest; this stub exists so
 * accidental imports fail loudly instead of silently.
 */
export function normalizePath(p: string): string {
	return p.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\//, '');
}

export class Notice {
	constructor(public message: string) {}
}

function unavailable(name: string): never {
	throw new Error(`obsidian.${name} is not available in unit tests`);
}

export const requestUrl = (): never => unavailable('requestUrl');
export class Plugin {
	constructor() {
		unavailable('Plugin');
	}
}
export class ItemView {
	constructor() {
		unavailable('ItemView');
	}
}
export class PluginSettingTab {
	constructor() {
		unavailable('PluginSettingTab');
	}
}
export class FuzzySuggestModal {
	constructor() {
		unavailable('FuzzySuggestModal');
	}
}
export class MarkdownView {}
export class TFile {}
export class TFolder {}
export const MarkdownRenderer = { render: (): never => unavailable('MarkdownRenderer.render') };
export const setIcon = (): void => undefined;
