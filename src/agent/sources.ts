import type { StoredMessage } from '../persistence/conversation';
import { baseName } from '../vault/paths';

/**
 * Source markers. The model cites a vault note as [[Note name]] and a web
 * page as [web N]; under the answer Dragonglass lists the cited sources,
 * grouped "From your vault" and "From the web". The list is grounded in what
 * the conversation's tool results and attached context actually showed the
 * model, not only in what it typed: a cited note it never read is shown as
 * unverified, a cited note that does not exist as missing.
 *
 * Tools report what they showed as `Source`s on their result; the chat view
 * calls `answerSources` on the stored conversation to build the lists.
 */

/** Something a tool result or attached context put in front of the model. */
export type Source = VaultSource | WebSource;

export interface VaultSource {
	kind: 'vault';
	path: string;
	/** `full`: the note's text (possibly cut to the cap); `excerpt`: only a search excerpt. */
	seen: 'full' | 'excerpt';
}

export interface WebSource {
	kind: 'web';
	/** The number the tool showed the model for this page, cited as [web N]. */
	n: number;
	url: string;
	title: string;
}

/** How well a cited vault note is backed by what the model was shown. */
export type VaultCitationStatus =
	/** Its text was in a tool result or attached context. */
	| 'read'
	/** Only a search excerpt of it was shown. */
	| 'excerpt'
	/** The note exists but the model was never shown it: unverified. */
	| 'unread'
	/** The link does not resolve to a note. */
	| 'missing';

export interface VaultEntry {
	/** The link text as cited, without alias or heading; for an uncited note, its basename. */
	link: string;
	/** Resolved vault path, or null when the link resolves to nothing. */
	path: string | null;
	status: VaultCitationStatus;
	cited: boolean;
}

export interface WebEntry {
	n: number;
	/** Null when the answer cites a number no tool result showed: unverified. */
	source: WebSource | null;
}

export interface AnswerSources {
	/** Cited notes in citation order, then notes read in full this turn that the answer does not cite. */
	vault: VaultEntry[];
	/** Cited web pages in number order. */
	web: WebEntry[];
	/** Web sources shown this turn, for turning [web N] markers into links. */
	webSources: WebSource[];
}

/** Resolves a wikilink target to a vault path, as Obsidian would from the vault root. */
export type LinkResolver = (link: string) => string | null;

export const WEB_MARKER = /\[web (\d+)\](?!\()/gi;

/** Fenced code blocks and inline code spans: markers inside them are not citations. */
const CODE = /(^|\n)(```|~~~)[^\n]*\n[\s\S]*?(\n\2[^\n]*(?=\n|$)|$)|`[^`\n]+`/g;
const WIKILINK = /(!?)\[\[([^\]\n]+?)\]\]/g;

function withoutCode(text: string): string {
	return text.replace(CODE, (m) => ' '.repeat(m.length));
}

/** The wikilink targets and web numbers an answer cites, each once, in order of first citation. Embeds are not citations. */
export function extractCitations(text: string): { notes: string[]; web: number[] } {
	const prose = withoutCode(text);
	const notes: string[] = [];
	const seen = new Set<string>();
	for (const m of prose.matchAll(WIKILINK)) {
		if (m[1] === '!') continue;
		const target = (m[2] ?? '').split('|')[0]!.split('#')[0]!.trim();
		if (!target || seen.has(target.toLowerCase())) continue;
		seen.add(target.toLowerCase());
		notes.push(target);
	}
	const web: number[] = [];
	for (const m of prose.matchAll(WEB_MARKER)) {
		const n = Number(m[1]);
		if (!web.includes(n)) web.push(n);
	}
	return { notes, web };
}

/**
 * Turn each [web N] marker outside code into a Markdown link to the page the
 * tool numbered N. A number with no page is left as plain text; the sources
 * list marks it unverified.
 */
export function linkWebMarkers(text: string, web: WebSource[]): string {
	if (web.length === 0) return text;
	const byNumber = new Map(web.map((w) => [w.n, w]));
	const masked = withoutCode(text);
	let out = '';
	let last = 0;
	for (const m of masked.matchAll(WEB_MARKER)) {
		const source = byNumber.get(Number(m[1]));
		if (!source || m.index === undefined) continue;
		out += text.slice(last, m.index) + `[web ${source.n}](<${source.url.replace(/>/g, '%3E')}>)`;
		last = m.index + m[0].length;
	}
	return out + text.slice(last);
}

/** Keep only well-formed sources; stored conversations are read back from disk. */
export function sanitizeSources(raw: unknown): Source[] {
	if (!Array.isArray(raw)) return [];
	return raw.filter((s): s is Source => {
		if (!s || typeof s !== 'object') return false;
		const v = s as Record<string, unknown>;
		if (v['kind'] === 'vault') return typeof v['path'] === 'string' && (v['seen'] === 'full' || v['seen'] === 'excerpt');
		if (v['kind'] === 'web') return typeof v['n'] === 'number' && typeof v['url'] === 'string' && typeof v['title'] === 'string';
		return false;
	});
}

/** What a user message's attached context showed the model. */
function contextSources(m: StoredMessage): VaultSource[] {
	const ctx = m.context;
	if (!ctx) return [];
	const paths = [ctx.activeNotePath, ...ctx.attachments.map((a) => a.path)].filter((p): p is string => typeof p === 'string' && p !== '');
	return paths.map((path) => ({ kind: 'vault', path, seen: 'full' }));
}

/**
 * The sources list for each answer, keyed by the turn's last assistant
 * message (where the list is shown), plus the turn's web sources keyed by
 * every assistant message of the turn so each can link its markers.
 *
 * A note counts as read when anything earlier in the conversation, up to the
 * end of this turn, showed its text: the model still has it in context. Web
 * numbers are per turn, as the tools number them.
 */
export function answerSources(messages: StoredMessage[], resolve: LinkResolver): { lists: Map<string, AnswerSources>; web: Map<string, WebSource[]> } {
	const lists = new Map<string, AnswerSources>();
	const webByMessage = new Map<string, WebSource[]>();
	const seenEver = new Map<string, 'full' | 'excerpt'>();
	const note = (s: VaultSource, turnRead: Set<string>) => {
		if (s.seen === 'full') {
			seenEver.set(s.path, 'full');
			turnRead.add(s.path);
		} else if (!seenEver.has(s.path)) seenEver.set(s.path, 'excerpt');
	};

	let i = 0;
	while (i < messages.length) {
		const turnRead = new Set<string>();
		const web: WebSource[] = [];
		const assistants: StoredMessage[] = [];
		if (messages[i]?.role === 'user') {
			for (const s of contextSources(messages[i]!)) note(s, turnRead);
			i++;
		}
		for (; i < messages.length && messages[i]!.role !== 'user'; i++) {
			const m = messages[i]!;
			if (m.role === 'assistant') assistants.push(m);
			if (m.role !== 'tool') continue;
			for (const s of sanitizeSources(m.sources)) {
				if (s.kind === 'vault') note(s, turnRead);
				else {
					const at = web.findIndex((w) => w.n === s.n);
					if (at >= 0) web[at] = s;
					else web.push(s);
				}
			}
		}
		if (assistants.length === 0) continue;
		for (const a of assistants) webByMessage.set(a.id, web);
		const list = buildList(assistants.map((a) => a.content).join('\n\n'), turnRead, seenEver, web, resolve);
		if (list.vault.length > 0 || list.web.length > 0) lists.set(assistants[assistants.length - 1]!.id, list);
	}
	return { lists, web: webByMessage };
}

function buildList(
	answer: string,
	turnRead: Set<string>,
	seenEver: Map<string, 'full' | 'excerpt'>,
	web: WebSource[],
	resolve: LinkResolver,
): AnswerSources {
	const cited = extractCitations(answer);
	const vault: VaultEntry[] = [];
	const citedPaths = new Set<string>();
	for (const link of cited.notes) {
		const path = resolve(link);
		if (path !== null && citedPaths.has(path)) continue;
		if (path !== null) citedPaths.add(path);
		const seen = path === null ? undefined : seenEver.get(path);
		const status: VaultCitationStatus = path === null ? 'missing' : seen === 'full' ? 'read' : seen === 'excerpt' ? 'excerpt' : 'unread';
		vault.push({ link, path, status, cited: true });
	}
	for (const path of turnRead) {
		if (!citedPaths.has(path)) vault.push({ link: baseName(path), path, status: 'read', cited: false });
	}
	const byNumber = new Map(web.map((w) => [w.n, w]));
	const webEntries = [...cited.web].sort((a, b) => a - b).map((n) => ({ n, source: byNumber.get(n) ?? null }));
	return { vault, web: webEntries, webSources: web };
}
