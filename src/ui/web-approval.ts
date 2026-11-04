import { setIcon } from 'obsidian';
import type { WebSearchDecision, WebSearchRequest } from '../tools/web-tools';
import { PAGES_PER_SEARCH } from '../tools/web-tools';

/**
 * The approval card for one web search: the model's search words in an
 * editable field, what the search will do, and Search / Don't search.
 * Enter in the field searches. Resolves once the user decides, or as
 * declined when `signal` aborts (Stop).
 */
export function renderWebSearchApproval(card: HTMLElement, req: WebSearchRequest, signal: AbortSignal): Promise<WebSearchDecision> {
	card.empty();
	const header = card.createDiv({ cls: 'dg-web-approval-header' });
	setIcon(header.createSpan({ cls: 'dg-web-approval-icon' }), 'globe');
	header.createSpan({ cls: 'dg-web-approval-title', text: 'Search the web?' });

	const label = card.createEl('label', { cls: 'dg-web-approval-label', text: 'Search words' });
	const input = label.createEl('input', { cls: 'dg-web-approval-input', attr: { type: 'text', spellcheck: 'false' } });
	input.value = req.query;

	const where =
		req.sites.length > 0
			? `Searches your preferred sites first (${req.sites.join(', ')}), then the whole web only if nothing turns up there.`
			: 'Searches the whole web with Tavily.';
	card.createDiv({ cls: 'dg-web-approval-desc', text: `${where} Approving also lets the model read up to ${PAGES_PER_SEARCH} of the result pages.` });

	const actions = card.createDiv({ cls: 'dg-web-approval-actions' });
	const search = actions.createEl('button', { cls: 'mod-cta', text: 'Search' });
	const skip = actions.createEl('button', { text: "Don't search" });

	return new Promise<WebSearchDecision>((resolve) => {
		let done = false;
		const finish = (decision: WebSearchDecision) => {
			if (done) return;
			done = true;
			signal.removeEventListener('abort', onAbort);
			resolve(decision);
		};
		const onAbort = () => finish({ approved: false });
		signal.addEventListener('abort', onAbort, { once: true });
		const approve = () => {
			const query = input.value.trim();
			if (!query) {
				input.focus();
				return;
			}
			finish({ approved: true, query });
		};
		const refresh = () => {
			search.disabled = input.value.trim() === '';
		};
		input.addEventListener('input', refresh);
		input.addEventListener('keydown', (evt) => {
			if (evt.key === 'Enter' && !evt.isComposing) {
				evt.preventDefault();
				approve();
			} else if (evt.key === 'Escape') {
				evt.preventDefault();
				finish({ approved: false });
			}
		});
		search.addEventListener('click', approve);
		skip.addEventListener('click', () => finish({ approved: false }));
		refresh();
		// Caret at the end, so typing adds to the words rather than replacing them.
		input.focus();
		input.setSelectionRange(input.value.length, input.value.length);
	});
}
