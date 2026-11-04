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

function normalize(text: string): string {
	return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Parse what the model names: `Act Two`, `## Act Two`, or a path through the
 * headings above it, `Act Two > Notes`. Leading `#`s pin the last heading's
 * level.
 */
function parseTarget(raw: string): { path: string[]; level: number | null } {
	const parts = raw.split('>').map((p) => p.trim()).filter((p) => p !== '');
	if (parts.length === 0) throw new SectionError('replace_section needs the text of a heading in "heading".');
	const last = parts[parts.length - 1] ?? '';
	const m = /^(#{1,6})\s*(.*)$/.exec(last);
	const level = m ? (m[1] ?? '').length : null;
	const path = parts.map((p) => normalize(p.replace(/^#{1,6}\s*/, '')));
	if (path.some((p) => p === '')) throw new SectionError('replace_section needs the text of a heading in "heading".');
	return { path, level };
}

/** Whether `wanted`, outermost first, appears in order among the heading's parents. */
function underParents(parents: readonly string[], wanted: readonly string[]): boolean {
	let i = 0;
	for (const p of parents) if (i < wanted.length && normalize(p) === wanted[i]) i++;
	return i === wanted.length;
}

function describe(h: Heading): string {
	return `${'#'.repeat(h.level)} ${h.text}`;
}

/** The one heading `raw` names; throws SectionError naming the note's headings when there is none, or the candidates when there are several. */
export function findHeading(lines: readonly string[], raw: string): Heading {
	const target = parseTarget(raw);
	const headings = listHeadings(lines);
	const name = target.path[target.path.length - 1];
	const matches = headings.filter(
		(h) => normalize(h.text) === name && (target.level === null || h.level === target.level) && underParents(h.parents, target.path.slice(0, -1)),
	);
	if (matches.length === 1) return matches[0] as Heading;
	if (matches.length === 0) {
		const known = headings.length === 0 ? 'The note has no headings.' : `Its headings are: ${headings.slice(0, 30).map(describe).join('; ')}${headings.length > 30 ? '; …' : ''}.`;
		throw new SectionError(`No heading "${raw.trim()}" in the note. ${known} Use one of them exactly, or use find_replace.`);
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
 * next heading is kept as the note had it. If `content` starts with the
 * heading line itself, that line is not repeated.
 */
export function replaceSection(text: string, heading: string, content: string): string {
	const lines = text.split('\n');
	const target = findHeading(lines, heading);
	const next = listHeadings(lines).find((h) => h.line > target.line && h.level <= target.level);
	const end = next ? next.line : lines.length;
	const body = lines.slice(target.line + 1, end);
	const blankAfterHeading = body.length > 0 && (body[0] ?? '').trim() === '';

	let replacement = content.replace(/\r\n/g, '\n').split('\n');
	const firstText = replacement.findIndex((l) => l.trim() !== '');
	if (firstText >= 0) {
		const m = HEADING.exec(replacement[firstText] ?? '');
		if (m && (m[1] ?? '').length === target.level && normalize(m[2] ?? '') === normalize(target.text)) replacement = replacement.slice(firstText + 1);
	}
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
