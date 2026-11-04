import { answerSources, LinkResolver, linkWebMarkers, WebSource } from '../agent/sources';
import type { StoredMessage } from '../persistence/conversation';
import type { ChangeProposal } from '../vault/proposals';

/**
 * The note "Save to vault" proposes for an answer that drew on the web: the
 * answer with its [web N] markers as links, the pages it cited, the date,
 * and frontmatter saying it came from the web so it can be told apart from
 * canon notes later. It is only ever proposed; the user reviews it like any
 * other new note.
 */

export const RESEARCH_FOLDER = 'Web research';

export interface ResearchNoteInput {
	/** The user's question, which names the note. */
	question: string;
	/** The answer as the model wrote it. */
	answer: string;
	/** The web pages the answer cites, in number order. */
	cited: WebSource[];
	/** Web pages shown so far, for linking the answer's markers. */
	webSources: WebSource[];
	date: Date;
	/** Whether a vault path is taken, so the note gets a free name. */
	exists: (path: string) => boolean;
}

export interface ResearchNote {
	path: string;
	content: string;
}

export function buildResearchNote(input: ResearchNoteInput): ResearchNote {
	const title = noteTitle(input.question);
	const day = isoDay(input.date);
	const lines = [
		'---',
		'from-web: true',
		`researched: ${day}`,
		`question: ${yamlString(input.question.replace(/\s+/g, ' ').trim())}`,
		'sources:',
		...input.cited.map((s) => `  - ${yamlString(s.url)}`),
		'---',
		`# ${title}`,
		'',
		`> [!info] From the web`,
		`> Researched with Dragonglass on ${day}. Claims marked [web N] come from the pages listed under Sources; check them before treating this as canon.`,
		'',
		linkWebMarkers(input.answer.trim(), input.webSources),
		'',
		'## Sources',
		'',
		...input.cited.map((s) => `${s.n}. [${linkText(s.title || s.url)}](<${s.url.replace(/>/g, '%3E')}>)`),
		'',
	];
	return { path: freePath(title, input.exists), content: lines.join('\n') };
}

/** A file-safe title from the question: its first line, without characters Obsidian forbids in names or links. */
export function noteTitle(question: string): string {
	const line = question.split('\n').find((l) => l.trim()) ?? '';
	const clean = line.replace(/[\\/:*?"<>|#^[\]]/g, ' ').replace(/\s+/g, ' ').trim().replace(/^\.+/, '').replace(/[. ]+$/, '');
	if (!clean) return 'Web research';
	if (clean.length <= 60) return clean;
	const cut = clean.slice(0, 60);
	const space = cut.lastIndexOf(' ');
	return (space > 30 ? cut.slice(0, space) : cut).replace(/[. ]+$/, '');
}

function freePath(title: string, exists: (path: string) => boolean): string {
	for (let i = 1; ; i++) {
		const path = `${RESEARCH_FOLDER}/${i === 1 ? title : `${title} ${i}`}.md`;
		if (!exists(path)) return path;
	}
}

function isoDay(date: Date): string {
	const pad = (n: number) => String(n).padStart(2, '0');
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** A YAML double-quoted scalar; JSON string escaping is valid YAML. */
function yamlString(value: string): string {
	return JSON.stringify(value);
}

function linkText(text: string): string {
	return text.replace(/[[\]]/g, (c) => `\\${c}`).replace(/\s+/g, ' ').trim();
}

/**
 * The research note for the answer `messageId`, when that answer cites at
 * least one web page a search actually returned; null otherwise. The
 * question is the user message that began the answer's turn.
 */
export function researchNoteFor(
	messages: StoredMessage[],
	proposals: Record<string, ChangeProposal>,
	messageId: string,
	resolve: LinkResolver,
	exists: (path: string) => boolean,
	date: Date,
): ResearchNote | null {
	const at = messages.findIndex((m) => m.id === messageId);
	const answer = messages[at];
	if (!answer || answer.role !== 'assistant' || !answer.content.trim()) return null;
	const list = answerSources(messages, proposals, resolve).lists.get(messageId);
	const cited = (list?.web ?? []).flatMap((w) => (w.source ? [w.source] : []));
	if (!list || cited.length === 0) return null;
	let question = '';
	for (let i = at - 1; i >= 0; i--) {
		const m = messages[i]!;
		if (m.role === 'user') {
			question = m.content;
			break;
		}
	}
	return buildResearchNote({ question, answer: answer.content, cited, webSources: list.webSources, date, exists });
}
