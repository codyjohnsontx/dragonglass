import type { StoredMessage } from '../persistence/conversation';
import type { ChangeProposal } from '../vault/proposals';

/**
 * Source markers. The model cites a vault note as [[Note name]] and a web
 * page as [web N]; under the answer Dragonglass lists the cited sources,
 * grouped "From your vault" and "From the web". The list is grounded in what
 * the conversation's tool results and attached context actually showed the
 * model, not only in what it typed: a cited note whose text was not in the
 * model's context for the answer is shown as unverified, a cited note that
 * does not exist as missing. A turn saved before sources were recorded has
 * no list: its links stay plain links, unchecked. After such a turn, a cited
 * note the record does not show as read is left unflagged, since the
 * unrecorded turn may have shown it. A link to a note the same turn proposed
 * creating or editing names the change, not a source, and is not listed.
 *
 * Tools report what they showed as `Source`s on their result; the chat view
 * calls `answerSources` on the stored conversation to build the lists.
 */

/** Something a tool result or attached context put in front of the model. */
export type Source = VaultSource | WebSource;

export interface VaultSource {
	kind: 'vault';
	path: string;
	/** `full`: the note's text (possibly cut to the cap); `excerpt`: only part of it, such as a search excerpt or its properties. */
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
	/** Only part of it was shown, such as a search excerpt or its properties. */
	| 'excerpt'
	/** The note exists but its text was not in the model's context for this answer: unverified. */
	| 'unread'
	/** The link does not resolve to a note. */
	| 'missing'
	/** Not in this answer's context as far as the record shows, but an earlier turn has no record: not flagged. */
	| 'unchecked';

export interface VaultEntry {
	/** The link text as cited, without alias or heading. */
	link: string;
	/** Resolved vault path, or null when the link resolves to nothing. */
	path: string | null;
	status: VaultCitationStatus;
}

export interface WebEntry {
	n: number;
	/** Null when the answer cites a number no tool result showed: unverified. */
	source: WebSource | null;
}

export interface AnswerSources {
	/** Cited notes in citation order. */
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

/**
 * The sources list for each answer, keyed by the turn's last assistant
 * message (where the list is shown), plus the turn's web sources keyed by
 * every assistant message of the turn so each can link its markers.
 *
 * A note counts as read when a tool result earlier in the conversation, up to
 * the end of this turn, showed its text (tool results are replayed every
 * turn), or when this turn's attached context did (attached context is sent
 * with its own turn only); a note sent only as a selection counts as an
 * excerpt. Links to notes the turn proposed changes to are left out. Web
 * numbers are per turn, as the tools number them.
 * A turn whose user message has no sources record predates source markers
 * and gets no list; after one, a cited note the record does not show as read
 * is unchecked rather than unread, since the unrecorded turn may have shown it.
 */
export function answerSources(
	messages: StoredMessage[],
	proposals: Record<string, ChangeProposal>,
	resolve: LinkResolver,
): { lists: Map<string, AnswerSources>; web: Map<string, WebSource[]> } {
	const lists = new Map<string, AnswerSources>();
	const webByMessage = new Map<string, WebSource[]>();
	const seenEver = new Map<string, 'full' | 'excerpt'>();
	let historyRecorded = true;

	let i = 0;
	while (i < messages.length) {
		const turnContext = new Map<string, 'full' | 'excerpt'>();
		const proposed = new Set<string>();
		const web: WebSource[] = [];
		const assistants: StoredMessage[] = [];
		const user = messages[i]?.role === 'user' ? messages[i]! : null;
		if (user) {
			for (const s of sanitizeSources(user.sources)) {
				if (s.kind === 'vault' && turnContext.get(s.path) !== 'full') turnContext.set(s.path, s.seen);
			}
			i++;
		}
		const turnRecorded = Array.isArray(user?.sources);
		if (!turnRecorded) historyRecorded = false;
		for (; i < messages.length && messages[i]!.role !== 'user'; i++) {
			const m = messages[i]!;
			if (m.role === 'assistant') assistants.push(m);
			if (m.role !== 'tool') continue;
			const proposal = m.proposalId ? proposals[m.proposalId] : undefined;
			if (proposal) proposed.add(proposal.path);
			for (const s of sanitizeSources(m.sources)) {
				if (s.kind === 'vault') {
					if (s.seen === 'full' || !seenEver.has(s.path)) seenEver.set(s.path, s.seen);
				} else {
					const at = web.findIndex((w) => w.n === s.n);
					if (at >= 0) web[at] = s;
					else web.push(s);
				}
			}
		}
		if (assistants.length === 0) continue;
		for (const a of assistants) webByMessage.set(a.id, web);
		if (!turnRecorded) continue;
		const seen = (path: string) => {
			const sent = turnContext.get(path);
			const shown = seenEver.get(path);
			return sent === 'full' || shown === 'full' ? 'full' : (sent ?? shown);
		};
		const list = buildList(assistants.map((a) => a.content).join('\n\n'), seen, historyRecorded, proposed, web, resolve);
		if (list.vault.length > 0 || list.web.length > 0) lists.set(assistants[assistants.length - 1]!.id, list);
	}
	return { lists, web: webByMessage };
}

function buildList(
	answer: string,
	seen: (path: string) => 'full' | 'excerpt' | undefined,
	historyRecorded: boolean,
	proposed: Set<string>,
	web: WebSource[],
	resolve: LinkResolver,
): AnswerSources {
	const cited = extractCitations(answer);
	const vault: VaultEntry[] = [];
	const citedPaths = new Set<string>();
	for (const link of cited.notes) {
		const path = resolve(link);
		if (isProposed(link, path, proposed)) continue;
		if (path !== null && citedPaths.has(path)) continue;
		if (path !== null) citedPaths.add(path);
		const shown = path === null ? undefined : seen(path);
		const status: VaultCitationStatus =
			path === null ? 'missing' : shown === 'full' ? 'read' : !historyRecorded ? 'unchecked' : shown === 'excerpt' ? 'excerpt' : 'unread';
		vault.push({ link, path, status });
	}
	const byNumber = new Map(web.map((w) => [w.n, w]));
	const webEntries = [...cited.web].sort((a, b) => a - b).map((n) => ({ n, source: byNumber.get(n) ?? null }));
	return { vault, web: webEntries, webSources: web };
}

/** Whether a cited link names a note the turn proposed: by its resolved path, or for a note not created yet, by Obsidian's path-suffix rule. */
function isProposed(link: string, path: string | null, proposed: Set<string>): boolean {
	if (path !== null) return proposed.has(path);
	const wanted = link.toLowerCase().replace(/\.md$/, '');
	for (const p of proposed) {
		const candidate = p.toLowerCase().replace(/\.md$/, '');
		if (candidate === wanted || candidate.endsWith(`/${wanted}`)) return true;
	}
	return false;
}
