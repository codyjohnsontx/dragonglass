/**
 * The matching rules search uses, shared by the index and by the checks it
 * runs on candidate notes: query words, word starts, frontmatter keys,
 * headings and scripts written without spaces. See docs/decisions.md 14.
 */

/**
 * Words dropped from a query unless it has nothing else, so "risks and
 * action items" does not match every note that contains "and".
 */
const STOPWORDS = new Set([
	'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'in', 'is', 'it', 'my', 'of', 'on', 'or', 'the', 'to', 'with',
]);

/**
 * Lowercased query words with surrounding punctuation trimmed, so `"project`
 * and `items?` match like the bare words; inner characters stay ("2024-10"),
 * as does a trailing + or # ("c++", "c#").
 */
export function searchTerms(query: string): string[] {
	const trimmed = query.toLowerCase().split(/\s+/).map((t) => t.replace(/^[^\p{L}\p{N}]+/u, '').replace(/[^\p{L}\p{N}+#]+$/u, ''));
	const words = [...new Set(trimmed.filter((t) => t.length > 0))];
	const meaningful = words.filter((t) => !STOPWORDS.has(t));
	return meaningful.length > 0 ? meaningful : words;
}

const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

/** Scripts written without spaces between words, where a word start cannot be found from the text alone. */
const UNSPACED_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;

/** Offsets (at most `max`) where a term starts a word in `text`. */
export type WordStartFinder = (text: string, max: number) => number[];

/**
 * Finds `term` at word starts, so "risk" finds "risks" but "ai" not "email".
 * A term in an unspaced script such as Chinese or Thai matches anywhere, and
 * a character of such a script ends the word before it ("学习python" has
 * "python" at a word start).
 */
export function wordStartFinder(term: string): WordStartFinder {
	const anywhere = UNSPACED_SCRIPT.test(term);
	return (text, max) => {
		const offsets: number[] = [];
		for (let at = text.indexOf(term); at >= 0 && offsets.length < max; ) {
			const before = [...text.slice(Math.max(0, at - 2), at)].pop() ?? '';
			const starts = anywhere || !LETTER_OR_DIGIT.test(before) || UNSPACED_SCRIPT.test(before);
			if (starts) offsets.push(at);
			at = text.indexOf(term, at + (starts ? term.length : 1));
		}
		return offsets;
	};
}

/** Frontmatter key names (`date:`), blanked so a query word does not match every note with that property. */
const FRONTMATTER_KEY = /^([ \t]*)[\p{L}\p{N}_][\p{L}\p{N}_ .-]*:(?=[ \t\r]|$)/gmu;

export function withoutFrontmatterKeys(content: string): string {
	const start = bodyStart(content);
	return content.slice(0, start).replace(FRONTMATTER_KEY, '$1') + content.slice(start);
}

/** Offset where the note body starts, after a leading YAML frontmatter block. */
export function bodyStart(content: string): number {
	const m = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(\r?\n|$)/.exec(content);
	return m ? m[0].length : 0;
}

export function headingLines(content: string): string[] {
	return content.split('\n').filter((line) => /^#{1,6}\s/.test(line));
}

/** How much a match counts, by where it is: once in the body, plus this much more in a heading or the note's name. */
export const HEADING_WEIGHT = 1;
export const NAME_WEIGHT = 3;

/** A note's text in the lowercased form both the index and the candidate check search. */
export interface SearchFields {
	name: string;
	body: string;
	headings: string;
}

export function searchFields(name: string, content: string): SearchFields {
	const body = withoutFrontmatterKeys(content).toLowerCase();
	return { name: name.toLowerCase(), body, headings: headingLines(body).join('\n') };
}

/** Weighted number of places `find` matches in a note, counted the way the index counts its tokens. */
export function weightedMatches(fields: SearchFields, find: WordStartFinder): number {
	const all = Number.MAX_SAFE_INTEGER;
	return find(fields.body, all).length + HEADING_WEIGHT * find(fields.headings, all).length + NAME_WEIGHT * find(fields.name, all).length;
}

/**
 * Index tokens of a note with their weighted counts. A token is a run of
 * letters and digits starting at a word start, so a query word matches
 * exactly the tokens it is a prefix of. In unspaced scripts, where any
 * position can start a match, each character starts a token of itself and
 * the character after it.
 */
export function tokenCounts(fields: SearchFields): Map<string, number> {
	const counts = new Map<string, number>();
	const add = (weight: number) => (token: string) => counts.set(token, (counts.get(token) ?? 0) + weight);
	forEachToken(fields.body, add(1));
	forEachToken(fields.headings, add(HEADING_WEIGHT));
	forEachToken(fields.name, add(NAME_WEIGHT));
	return counts;
}

const RUN = /[\p{L}\p{N}]+/gu;

function forEachToken(text: string, emit: (token: string) => void): void {
	for (const m of text.matchAll(RUN)) {
		const run = m[0];
		if (UNSPACED_SCRIPT.test(run)) forEachPiece(run, emit);
		else emit(run);
	}
}

/** Splits a letter run that contains unspaced-script characters into word tokens and per-character tokens. */
function forEachPiece(run: string, emit: (token: string) => void): void {
	for (const piece of pieces(run)) {
		if (piece.kind === 'word') emit(piece.text);
		else for (const pair of pairs(piece.text)) emit(pair);
	}
}

/** Each character of an unspaced run joined with the next one, and the last character alone. */
function pairs(text: string): string[] {
	const chars = [...text];
	return chars.map((c, i) => c + (chars[i + 1] ?? ''));
}

interface Piece {
	text: string;
	kind: 'word' | 'unspaced';
	/** Whether the term continues after this piece. */
	followed: boolean;
}

/** Maximal runs of word characters and of unspaced-script characters; anything else separates them. */
function pieces(text: string): Piece[] {
	const out: Piece[] = [];
	let kindBefore: Piece['kind'] | null = null;
	for (const c of text) {
		const kind = UNSPACED_SCRIPT.test(c) ? 'unspaced' : LETTER_OR_DIGIT.test(c) ? 'word' : null;
		const last = out[out.length - 1];
		if (kind !== null && kind === kindBefore && last) last.text += c;
		else if (kind !== null) out.push({ text: c, kind, followed: true });
		kindBefore = kind;
	}
	// The last piece is unfinished when the text ends with a letter or digit, which is that piece's.
	const last = out[out.length - 1];
	if (last && LETTER_OR_DIGIT.test([...text].pop() ?? '')) last.followed = false;
	return out;
}

/**
 * How the index finds a query term. Most terms are a prefix of the tokens
 * they match, which the index answers exactly. A term with punctuation
 * inside ("2024-10", "c++") or longer unspaced text needs every one of its
 * tokens in a note, and those candidates are then checked against the text.
 */
export type TermLookup =
	| { kind: 'prefix'; prefix: string; /** A word, rather than unspaced-script text where every token is a fragment. */ word: boolean }
	| { kind: 'check'; exact: string[]; prefixes: string[] };

export function termLookup(term: string): TermLookup {
	const parts = pieces(term);
	const only = parts.length === 1 ? parts[0] : undefined;
	if (only?.text === term && only.kind === 'word') return { kind: 'prefix', prefix: term, word: true };
	if (only?.text === term && [...term].length <= 2) return { kind: 'prefix', prefix: term, word: false };
	const exact: string[] = [];
	const prefixes: string[] = [];
	if (UNSPACED_SCRIPT.test(term)) {
		// Matches anywhere, so a word piece may sit inside a longer token; only the unspaced pieces bind.
		for (const p of parts) {
			if (p.kind !== 'unspaced') continue;
			const chars = [...p.text];
			if (chars.length === 1) prefixes.push(p.text);
			else for (let i = 0; i + 1 < chars.length; i++) exact.push(`${chars[i]}${chars[i + 1]}`);
		}
	} else {
		// Starts at a word start and every piece but an unfinished last one is a whole token.
		for (const p of parts) (p.followed ? exact : prefixes).push(p.text);
	}
	return { kind: 'check', exact, prefixes };
}
