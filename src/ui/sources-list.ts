import { App, Keymap } from 'obsidian';
import { AnswerSources, VaultCitationStatus, VaultEntry } from '../agent/sources';

/**
 * The sources list under an answer: "From your vault" with each cited note
 * as a working link and a tag when its text was not in the model's context
 * for this answer, unless an earlier turn of the conversation predates
 * source records, when it is left unflagged; "From the web" with each cited
 * [web N] page, once web search results exist.
 */
export function renderSourcesList(parent: HTMLElement, sources: AnswerSources): HTMLElement {
	const box = parent.createDiv({ cls: 'dg-sources' });
	if (sources.vault.length > 0) {
		box.createDiv({ cls: 'dg-sources-heading', text: 'From your vault' });
		const list = box.createEl('ul', { cls: 'dg-sources-list' });
		for (const entry of sources.vault) vaultItem(list, entry);
	}
	if (sources.web.length > 0) {
		box.createDiv({ cls: 'dg-sources-heading', text: 'From the web' });
		// Each item carries its own "web N" label, so the list shows no numbers of its own.
		const list = box.createEl('ol', { cls: 'dg-sources-list dg-sources-web' });
		for (const { n, source } of sources.web) {
			const item = list.createEl('li', { attr: { value: String(n) } });
			item.createSpan({ cls: 'dg-cite-web', text: `web ${n}` });
			item.appendText(' ');
			if (source) {
				item.createEl('a', { cls: 'external-link', text: source.title || source.url, href: source.url, attr: { target: '_blank', rel: 'noopener' } });
			} else {
				item.createSpan({ cls: 'dg-source-flag', text: 'no search result has this number: unverified' });
			}
		}
	}
	return box;
}

const FLAGS: Record<VaultCitationStatus, string | null> = {
	read: null,
	excerpt: 'only part of it was read',
	unread: 'not in the model\'s context for this answer: unverified',
	missing: 'no such note',
	unchecked: null,
};

function vaultItem(list: HTMLElement, entry: VaultEntry): void {
	const item = list.createEl('li', { cls: `dg-source-${entry.status}` });
	item.createEl('a', {
		cls: `internal-link${entry.path === null ? ' is-unresolved' : ''}`,
		text: entry.link,
		href: entry.path ?? entry.link,
		attr: { 'data-href': entry.path ?? entry.link },
	});
	const flag = FLAGS[entry.status];
	if (flag) item.createSpan({ cls: 'dg-source-flag', text: ` (${flag})` });
}

function linkTarget(a: Element): string | null {
	return a.getAttribute('data-href') ?? a.getAttribute('href');
}

function resolves(app: App, href: string): boolean {
	return app.metadataCache.getFirstLinkpathDest(href.split('#')[0] ?? href, '') !== null;
}

/**
 * Open [[links]] in rendered replies and sources lists the way a note does:
 * click opens, Mod+click opens in a new tab. A link to a note that does not
 * exist does nothing; opening it would create an empty note.
 */
export function openInternalLink(app: App, evt: MouseEvent): void {
	const target = evt.target instanceof HTMLElement ? evt.target.closest('a.internal-link') : null;
	if (!target) return;
	evt.preventDefault();
	const href = linkTarget(target);
	if (!href || !resolves(app, href)) return;
	void app.workspace.openLinkText(href, '', Keymap.isModEvent(evt));
}

/** Style links to missing notes in a rendered reply as Obsidian does in a note; the renderer leaves them unmarked here. */
export function markUnresolvedLinks(app: App, el: HTMLElement): void {
	el.querySelectorAll('a.internal-link').forEach((a) => {
		const href = linkTarget(a);
		if (href && !resolves(app, href)) a.addClass('is-unresolved');
	});
}
