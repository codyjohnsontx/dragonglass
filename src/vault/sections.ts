/**
 * Sections of a note by heading, for `replace_section` edits. A section is a
 * heading line and everything after it up to the next heading of the same or
 * a higher level (fewer `#`), or the end of the note. Headings inside the
 * frontmatter and inside fenced code blocks do not count.
 */

export interface Heading {
	level: number;
	text: string;
	/** Line index of the heading. */
	line: number;
	/** Texts of the headings it sits under, outermost first. */
	parents: string[];
}

export class SectionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'SectionError';
	}
}

const HEADING = /^(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*\r?$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/** The note's ATX headings in order, with the headings each one sits under. */
export function listHeadings(lines: readonly string[]): Heading[] {
	const out: Heading[] = [];
	const stack: Heading[] = [];
	let i = frontmatterEnd(lines);
	let fence: string | null = null;
	for (; i < lines.length; i++) {
		const line = lines[i] ?? '';
		const f = FENCE.exec(line);
		if (f) {
			const marker = f[1] ?? '';
			if (fence === null) fence = marker;
			else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null;
			continue;
		}
		if (fence !== null) continue;
		const m = HEADING.exec(line);
		if (!m) continue;
		const level = (m[1] ?? '').length;
		const text = (m[2] ?? '').trim();
		if (text === '') continue;
		while (stack.length > 0 && (stack[stack.length - 1]?.level ?? 0) >= level) stack.pop();
		const heading = { level, text, line: i, parents: stack.map((h) => h.text) };
		out.push(heading);
		stack.push(heading);
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
	const headings = listHeadings(lines);
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
 * the heading line itself. A blank line after the heading and before the
 * next heading is kept as the note had it.
 */
export function replaceSection(text: string, heading: string, content: string): string {
	const lines = text.split('\n');
	const target = findHeading(lines, heading);
	const next = listHeadings(lines).find((h) => h.line > target.line && h.level <= target.level);
	const end = next ? next.line : lines.length;
	const body = lines.slice(target.line + 1, end);
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
	return [...lines.slice(0, target.line + 1), ...section, ...lines.slice(end)].join('\n');
}
