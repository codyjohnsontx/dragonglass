/**
 * Sections of a note by heading, for `replace_section` edits. A section is a
 * heading and everything after it up to the next heading of the same or a
 * higher level, or the end of the note. Boundaries follow Markdown: `#`
 * headings and underlined (setext) headings count, including an empty `#`
 * heading, which ends a section but cannot be named. Headings inside the
 * frontmatter and inside fenced code blocks do not count.
 */

export interface Heading {
	level: number;
	text: string;
	/** Line index where the heading starts. */
	line: number;
	/** Line index just after the heading: past the underline of a setext heading. */
	body: number;
	/** Texts of the headings it sits under, outermost first. */
	parents: string[];
}

export class SectionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'SectionError';
	}
}

const ATX_HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))??(?:[ \t]+#+)?[ \t]*$/;
const FENCE_OPEN = /^( {0,3}(?:(?:[-+*]|\d{1,9}[.)])[ \t]+)*)(`{3,}(?=[^`]*$)|~{3,})/;
const FENCE_CLOSE = /^[ \t]*(`{3,}|~{3,})[ \t]*$/;
const SETEXT_UNDERLINE = /^ {0,3}(=+|-+)[ \t]*$/;
/** Lines that end a paragraph: a quote, a list that may interrupt one (bullets, or numbered from 1, with text), a rule. */
const ENDS_PARAGRAPH = /^ {0,3}(?:>|[-+*][ \t]+\S|1[.)][ \t]+\S|([*_])(?:[ \t]*\1){2,}[ \t]*$)/;
/** Lines that do not start a paragraph, though they continue one: indented code, a list numbered from anything else. */
const NOT_PARAGRAPH_START = /^(?: {4}|\t| {0,3}\d{1,9}[.)][ \t])/;

/** The note's headings in order, with the headings each one sits under. */
export function listHeadings(lines: readonly string[]): Heading[] {
	const out: Heading[] = [];
	const stack: Heading[] = [];
	const add = (level: number, text: string, line: number, body: number) => {
		while (stack.length > 0 && (stack[stack.length - 1]?.level ?? 0) >= level) stack.pop();
		const heading = { level, text, line, body, parents: stack.map((h) => h.text) };
		out.push(heading);
		if (text !== '') stack.push(heading);
	};
	/** The open fence. Opened after a list marker, `column` is that item's content: a less indented line ends the item and the fence with it. */
	let fence: { marker: string; column: number } | null = null;
	/** First line of the paragraph being read, which an underline turns into a heading. */
	let paragraph: number | null = null;
	for (let i = frontmatterEnd(lines); i < lines.length; i++) {
		const line = (lines[i] ?? '').replace(/\r$/, '');
		if (fence !== null) {
			if (line.trim() === '') continue;
			const indent = line.length - line.trimStart().length;
			if (indent >= fence.column) {
				const close = FENCE_CLOSE.exec(line)?.[1] ?? '';
				if (indent <= fence.column + 3 && close[0] === fence.marker[0] && close.length >= fence.marker.length) fence = null;
				continue;
			}
			fence = null;
		}
		const open = FENCE_OPEN.exec(line);
		const atx = ATX_HEADING.exec(line);
		const underline = SETEXT_UNDERLINE.exec(line)?.[1];
		if (open) {
			const prefix = open[1] ?? '';
			fence = { marker: open[2] ?? '', column: prefix.trim() === '' ? 0 : prefix.length };
			paragraph = null;
		} else if (atx) {
			add((atx[1] ?? '').length, (atx[2] ?? '').trim(), i, i + 1);
			paragraph = null;
		} else if (underline) {
			if (paragraph !== null) {
				const text = lines.slice(paragraph, i).map((l) => l.trim()).join(' ');
				add(underline[0] === '=' ? 1 : 2, text, paragraph, i + 1);
			}
			paragraph = null;
		} else if (line.trim() === '' || ENDS_PARAGRAPH.test(line)) {
			paragraph = null;
		} else if (paragraph === null && !NOT_PARAGRAPH_START.test(line)) {
			paragraph = i;
		}
	}
	return out;
}

/** First line after the frontmatter block, or 0 when there is none. */
function frontmatterEnd(lines: readonly string[]): number {
	if ((lines[0] ?? '').replace(/\r$/, '') !== '---') return 0;
	for (let i = 1; i < lines.length; i++) {
		if (/^(---|\.\.\.)\r?$/.test(lines[i] ?? '')) return i + 1;
	}
	return 0;
}

/** Parse a path through the headings above a heading, `Act Two > Notes`, as named for a heading that appears more than once. */
function parseTarget(raw: string): string[] {
	const path = raw.split('>').map((p) => p.trim());
	if (path.some((p) => p === '')) throw new SectionError('replace_section needs the text of a heading in "heading".');
	return path;
}

/** Whether `wanted`, outermost first, appears in order among the heading's parents. */
function underParents(parents: readonly string[], wanted: readonly string[]): boolean {
	let i = 0;
	for (const p of parents) if (i < wanted.length && p === wanted[i]) i++;
	return i === wanted.length;
}

function describe(h: Heading): string {
	return `${'#'.repeat(h.level)} ${h.text}`;
}

/** The headings a path through the headings above them names. */
function headingsAt(headings: readonly Heading[], path: readonly string[]): Heading[] {
	const name = path[path.length - 1];
	return headings.filter((h) => h.text === name && underParents(h.parents, path.slice(0, -1)));
}

/**
 * The one heading `raw` names: its exact text, or when no heading has that
 * text a path such as `Act Two > Notes`. Throws SectionError naming the
 * note's headings when there is none, or the candidates when there are
 * several.
 */
export function findHeading(lines: readonly string[], raw: string): Heading {
	const headings = listHeadings(lines).filter((h) => h.text !== '');
	const exact = headings.filter((h) => h.text === raw.trim());
	const matches = exact.length > 0 ? exact : headingsAt(headings, parseTarget(raw));
	if (matches.length === 1) return matches[0] as Heading;
	if (matches.length === 0) {
		const known = headings.length === 0 ? 'The note has no headings.' : `Its headings are: ${headings.slice(0, 30).map(describe).join('; ')}${headings.length > 30 ? '; …' : ''}.`;
		throw new SectionError(`No heading "${raw.trim()}" in the note. ${known} Use the text of one of them exactly, without the #s, or use find_replace.`);
	}
	const where = matches
		.slice(0, 10)
		.map((h) => (h.parents.length > 0 ? `${describe(h)} under "${h.parents.join(' > ')}"` : `${describe(h)} at the top level`))
		.join('; ');
	throw new SectionError(
		`The heading "${raw.trim()}" appears ${matches.length} times: ${where}. Name the heading it sits under too, such as "Parent > ${matches[0]?.text ?? ''}", or use find_replace. Nothing was proposed.`,
	);
}

/**
 * Replace the body of the section `heading` names with `content`, keeping
 * the heading itself. A blank line after the heading and before the
 * next heading is kept as the note had it.
 */
export function replaceSection(text: string, heading: string, content: string): string {
	const lines = text.split('\n');
	const target = findHeading(lines, heading);
	const next = listHeadings(lines).find((h) => h.line > target.line && h.level <= target.level);
	const end = next ? next.line : lines.length;
	const body = lines.slice(target.body, end);
	const blankAfterHeading = body.length > 0 && (body[0] ?? '').trim() === '';

	const replacement = content.replace(/\r\n/g, '\n').split('\n');
	while (replacement.length > 0 && (replacement[0] ?? '').trim() === '') replacement.shift();
	while (replacement.length > 0 && (replacement[replacement.length - 1] ?? '').trim() === '') replacement.pop();

	const section: string[] = [];
	if (replacement.length > 0) {
		if (blankAfterHeading) section.push('');
		section.push(...replacement);
	}
	if (next && (body.length === 0 || (body[body.length - 1] ?? '').trim() === '')) section.push('');
	else if (end === lines.length && text.endsWith('\n')) section.push('');
	return [...lines.slice(0, target.body), ...section, ...lines.slice(end)].join('\n');
}
