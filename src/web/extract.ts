/**
 * Plain text from a web page, extracted in-house so reading a page needs no
 * runtime dependency and no DOM (it runs the same in tests). It is a reader,
 * not a browser: scripts, styles and page furniture (navigation, footers,
 * sidebars, forms) are dropped, the main or article element is preferred when
 * the page has one with real text in it, block elements become line breaks
 * and entities are decoded. Pages that build their text with JavaScript come
 * back nearly empty, and the caller says so.
 */

export interface ExtractedPage {
	title: string;
	text: string;
}

/** More HTML than this is not looked at; a lore page is far smaller, a runaway page is not worth parsing. */
export const MAX_HTML_CHARS = 2_000_000;

/** Elements whose content is never page text. */
const DROPPED = ['script', 'style', 'noscript', 'template', 'svg', 'math', 'head', 'iframe', 'object', 'canvas', 'select', 'button', 'form'];
/** Page furniture: dropped when the page has a main or article element, or when they hold mostly links. */
const FURNITURE = ['nav', 'footer', 'aside', 'header'];

/** A main or article region shorter than this is a stub (a teaser, a cookie notice), and the whole body is used instead. */
const MIN_MAIN_TEXT = 200;

const BLOCK = /<\/?(?:p|div|section|article|main|blockquote|pre|table|thead|tbody|tfoot|tr|ul|ol|dl|dd|dt|figure|figcaption|hr|address|details|summary|center)\b[^>]*>/gi;

export function extractPageText(html: string): ExtractedPage {
	let doc = html.length > MAX_HTML_CHARS ? html.slice(0, MAX_HTML_CHARS) : html;
	const title = cleanInline(decodeEntities(stripTags(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(doc)?.[1] ?? '')));
	doc = doc.replace(/<!--[\s\S]*?(?:-->|$)/g, ' ').replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, ' ');
	for (const tag of DROPPED) doc = dropElement(doc, tag);
	const main = region(doc, 'main') ?? region(doc, 'article');
	if (main !== null) {
		doc = main;
		for (const tag of FURNITURE) doc = dropElement(doc, tag);
	} else {
		for (const tag of FURNITURE) doc = dropElement(doc, tag, mostlyLinks);
		doc = /<body\b[^>]*>([\s\S]*)$/i.exec(doc)?.[1] ?? doc;
	}
	return { title, text: toText(doc) };
}

/** The content of the page's first `tag` element up to its last closing tag, when it holds real text. */
function region(doc: string, tag: string): string | null {
	const open = new RegExp(`<${tag}\\b[^>]*>`, 'i').exec(doc);
	if (!open) return null;
	const start = open.index + open[0].length;
	const close = doc.toLowerCase().lastIndexOf(`</${tag}`);
	const inner = close > start ? doc.slice(start, close) : doc.slice(start);
	return toText(inner).length >= MIN_MAIN_TEXT ? inner : null;
}

/** Remove every `tag` element with its content (or, with `when`, only those it accepts). Unclosed ones run to the end. */
function dropElement(doc: string, tag: string, when?: (inner: string) => boolean): string {
	const pattern = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)(?:<\\/${tag}\\s*>|$)`, 'gi');
	return doc.replace(pattern, (whole, inner: string) => (!when || when(inner) ? ' ' : whole));
}

/** Navigation-like: most of its text sits inside links. */
function mostlyLinks(inner: string): boolean {
	const all = cleanInline(decodeEntities(stripTags(inner))).length;
	if (all === 0) return true;
	let linked = 0;
	for (const m of inner.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a\s*>/gi)) linked += cleanInline(decodeEntities(stripTags(m[1] ?? ''))).length;
	return linked / all > 0.5;
}

function toText(html: string): string {
	const text = html
		.replace(/<br\s*\/?>/gi, '\n')
		.replace(/<h([1-6])\b[^>]*>/gi, (_m, level: string) => `\n\n${'#'.repeat(Number(level))} `)
		.replace(/<\/h[1-6]\s*>/gi, '\n\n')
		.replace(/<li\b[^>]*>/gi, '\n- ')
		.replace(/<\/li\s*>/gi, '\n')
		.replace(/<\/?(?:td|th)\b[^>]*>/gi, ' ')
		.replace(BLOCK, '\n\n');
	return decodeEntities(stripTags(text))
		.split('\n')
		.map(cleanInline)
		.join('\n')
		// Empty headings and bullets left by dropped content.
		.replace(/^(?:#+|-)$/gm, '')
		.replace(/\n{3,}/g, '\n\n')
		// List items on consecutive lines.
		.replace(/^(- [^\n]*)\n\n(?=- )/gm, '$1\n')
		.trim();
}

function stripTags(html: string): string {
	return html.replace(/<\/?[a-zA-Z][^>]*>/g, '').replace(/<\/?[a-zA-Z][^>]*$/, '');
}

function cleanInline(text: string): string {
	return text.replace(/[\t\f\v \u00a0\u2000-\u200b\u3000]+/g, ' ').trim();
}

const NAMED: Record<string, string> = {
	amp: '&',
	lt: '<',
	gt: '>',
	quot: '"',
	apos: "'",
	nbsp: ' ',
	ensp: ' ',
	emsp: ' ',
	thinsp: ' ',
	ndash: '–',
	mdash: '—',
	hellip: '…',
	lsquo: '‘',
	rsquo: '’',
	ldquo: '“',
	rdquo: '”',
	laquo: '«',
	raquo: '»',
	middot: '·',
	bull: '•',
	copy: '©',
	reg: '®',
	trade: '™',
	deg: '°',
	times: '×',
	divide: '÷',
	sect: '§',
	para: '¶',
	dagger: '†',
	Dagger: '‡',
	shy: '',
	zwj: '',
	zwnj: '',
};

export function decodeEntities(text: string): string {
	return text.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z][a-z0-9]{1,31});/gi, (whole, name: string) => {
		if (name[0] === '#') {
			const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
			if (!Number.isFinite(code) || code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '�';
			return String.fromCodePoint(code);
		}
		return NAMED[name] ?? NAMED[name.toLowerCase()] ?? whole;
	});
}
