import type { ContextItem } from './context';
import { attr } from './delimiters';
import { isBareCue, isScriptNote } from './drafting';
import type { StoredMessage } from '../persistence/conversation';
import { DEFAULT_SETTINGS } from '../settings';
import { baseName, InvalidPathError, normalizeVaultPath, validateVaultPath } from '../vault/paths';
import { ChangeProposal, ProposalEngine, ProposalError, rejectNewPlaceholders } from '../vault/proposals';
import type { VaultPort } from '../vault/port';

/**
 * Lore check. The user runs it on the open script note or its selection. The
 * notes the script names go with it (`loreForScript`), the model can look up
 * more, and it answers with a fenced block whose info string is `lore`, one record per contradiction (the same
 * hand-over as a draft, for the same reasons: see decisions). `parseLoreBlock`
 * lifts the records out at the end of the turn and `groundLoreCheck` keeps
 * only what can be checked: a quoted line must be in the script, and the cited
 * note must exist, be lore rather than script, and have been shown to the
 * model. `core` stores the result on the assistant message as a
 * `LoreCheckRecord`; the chat shows it as a list of issues, not as a reply.
 *
 * Each issue offers Fix it, which proposes replacing that line in the script,
 * and Intentional, which proposes recording the change in the sequel canon
 * note. Both are ordinary proposals that the review applies; the proposal's
 * id stays on the issue, so it never joins a turn's batch review.
 *
 * The sequel canon note holds deliberate changes to the original lore. Sent
 * with every message (`canonContext`), it overrides the lore for drafting and
 * for this check. An issue on a line the note quotes is dropped here whatever
 * the model said, so Intentional always sticks; a change the owner wrote in
 * their own words relies on the rule in the prompt.
 */

/** One contradiction between a script line and a lore note. */
export interface LoreIssue {
	/** Unique within the check. */
	id: string;
	/** The whole script line, as the note has it, trimmed. */
	line: string;
	/** What the vault says, in the model's words. */
	says: string;
	/** Name of the note that says it, as cited. */
	note: string;
	/** Where that note is. */
	notePath: string;
	/** The whole line corrected; absent when the model offered none. */
	fix?: string;
	/** The latest Fix it or Intentional proposal made from this issue. */
	proposalId?: string;
}

/** Stored on an assistant message that holds a lore check result. */
export interface LoreCheckRecord {
	/** The script note checked. */
	scriptPath: string;
	issues: LoreIssue[];
	/** Flags left out: their line or their note could not be verified, or their line already has an issue. */
	leftOut?: number;
	/** The model was shown no lore note, so finding nothing means nothing. */
	readNoLore?: true;
	/** The script did not fit: how much of it the model saw. */
	shown?: { chars: number; of: number };
	/** The sequel canon note did not fit: how much of it the model saw. */
	canonShown?: { chars: number; of: number };
	/** How many notes the script names went with it cut short, or not at all. */
	loreCut?: number;
}

/** A record as the model wrote it, before it is checked. */
export interface RawIssue {
	line: string;
	says: string;
	note: string;
	fix?: string;
}

type LoreField = 'line' | 'vault' | 'note' | 'fix';
type LoreFields = Partial<Record<LoreField, string>>;

const OPEN_FENCE = /^```lore\s*$/;
const CLOSE_FENCE = '```';
const FIELD = /^[\s>*_-]*(line|vault|note|fix)[*_]*\s*:[*_]*\s*(.*)$/i;
const NO_FIX = /^(?:none|n\/a|no fix|-+)?\.?$/i;
const NOT_A_FLAG = /\bno (?:change|fix|correction)s? (?:is )?(?:needed|required)\b/i;
const CUE_ALONE = /^[A-Z][A-Z0-9 .'()-]*:?$/;

/**
 * The records of a reply's lore blocks, or null when it has none. An empty
 * block means nothing was found; an unterminated one (a stopped turn) makes
 * the whole reply no result, since what it held is unknown. A model told to
 * write one block can still split its records over several, so all count. A
 * record starts at its LINE field and a field runs on to the next label, so a
 * model that wraps a long sentence loses nothing; a record without a line, a
 * claim or a note is dropped.
 */
export function parseLoreBlock(content: string): RawIssue[] | null {
	const lines = content.split(/\r?\n/);
	let records: LoreFields[] | null = null;
	for (let open = 0; open < lines.length; open++) {
		if (!OPEN_FENCE.test(lines[open]!)) continue;
		const close = lines.findIndex((l, i) => i > open && l.trimEnd() === CLOSE_FENCE);
		if (close < 0) return null;
		records = [...(records ?? []), ...blockRecords(lines.slice(open + 1, close))];
		open = close;
	}
	if (!records) return null;
	const out: RawIssue[] = [];
	for (const r of records) {
		const line = unquote(withoutEndLinks(r.line ?? ''));
		const says = withoutEndLinks(r.vault ?? '').replace(/\[\[(?:[^\]|\n]*\|)?([^\]\n]*)\]\]/g, '$1').trim();
		const note = cleanLink(r.note ?? '');
		// A record that names no note is the model saying the lore has nothing on it.
		if (!line || !says || NO_FIX.test(note)) continue;
		const fix = unquote(withoutEndLinks(r.fix ?? ''));
		// The model listing a line it then says is fine has not flagged anything.
		if (NOT_A_FLAG.test(fix)) continue;
		out.push({ line, says, note, ...(NO_FIX.test(fix) ? {} : { fix }) });
	}
	return out;
}

/** The labelled fields of one block's records, as written. */
function blockRecords(body: string[]): LoreFields[] {
	const records: LoreFields[] = [];
	let field: LoreField | null = null;
	for (const raw of body) {
		const text = raw.trim();
		const m = FIELD.exec(raw);
		if (m) {
			field = m[1]!.toLowerCase() as LoreField;
			if (field === 'line' || records.length === 0) records.push({});
			records[records.length - 1]![field] = m[2]!.trim();
		} else if (/^-{3,}$/.test(text)) {
			field = null;
		} else if (text && field) {
			const record = records[records.length - 1]!;
			// A Fountain cue copied with its dialogue: the dialogue is the value.
			const cueAlone = (field === 'line' || field === 'fix') && CUE_ALONE.test(record[field] ?? '');
			record[field] = cueAlone ? text : `${record[field] ?? ''} ${text}`.trim();
		}
	}
	return records;
}

/** A value without the [[links]] that follow its last sentence: those cite it, while a link inside the text may be the script's own or part of what it says. */
function withoutEndLinks(text: string): string {
	return text.replace(/([.!?…"”'’`)])(?:\s*\[\[[^\]\n]*\]\])+\s*$/, '$1');
}

/** Whether a fix links the note its record cites where the script line does not: a citation, which must not reach the script. */
function citesNote(fix: string, note: string, line: string): boolean {
	const name = baseName(note).toLowerCase();
	return [...fix.matchAll(/\[\[[^\]\n]*\]\]/g)].some(([link]) => baseName(cleanLink(link)).toLowerCase() === name && !line.includes(link));
}

/** A value without the quotes or backticks a model wraps around it. */
function unquote(text: string): string {
	const t = text.trim();
	const m = /^(?:"(.*)"|“(.*)”|`(.*)`)$/.exec(t);
	return (m ? (m[1] ?? m[2] ?? m[3] ?? '') : t).trim();
}

/** A cited note's name: without [[brackets]], an alias, a heading or `.md`. */
function cleanLink(text: string): string {
	const t = text.trim().replace(/^\[\[/, '').replace(/\]\]\.?$/, '');
	return t.split('|')[0]!.split('#')[0]!.replace(/\.md$/i, '').trim();
}

/** A character cue leading a line: `KAEL: Again.`, as a model quotes Fountain dialogue or a script writes it, or the Markdown `**Kael:** Again.`. */
const INLINE_CUE = /^(?:[A-Z][A-Z0-9 .'-]*(?: \([^)]*\))?:|\*\*[^*\n]+:\*\*)\s+/;
/** Longest character cue `leadingCue` looks past. */
const MAX_CUE = 40;

/** A trimmed script line a quote names, and what the line holds around the quote. */
interface LineMatch {
	line: string;
	before: string;
	after: string;
}

/** The lines of `text` that a quote names: the lines equal to it, else those containing it. */
function matchLines(text: string, quote: string): LineMatch[] {
	const lines = text.split('\n').map((l) => l.trim());
	const whole = lines.filter((l) => l === quote);
	if (whole.length > 0) return whole.map((line) => ({ line, before: '', after: '' }));
	const lower = quote.toLowerCase();
	const out: LineMatch[] = [];
	for (const line of lines) {
		const at = line.toLowerCase().indexOf(lower);
		if (at >= 0) out.push({ line, before: line.slice(0, at), after: line.slice(at + quote.length) });
	}
	return out;
}

/** What `groundLoreCheck` checks the model's records against. */
export interface LoreGround {
	scriptPath: string;
	/** The text the check covered: the note or the selection. */
	scope: string;
	scriptFolder: string;
	/** The sequel canon note's text, when it exists. */
	canonText: string | null;
	/** Resolves a cited note's name to its path. */
	resolve: (link: string) => string | null;
	/** Every vault path shown to the model this turn. */
	shown: ReadonlySet<string>;
	newId: () => string;
}

/** Whether a line of the text is a character cue on its own. The rules ask for the spoken line under it, and Fix it would overwrite the cue. */
function isCueLine(scope: string, line: string): boolean {
	const lines = scope.trimEnd().split('\n');
	return lines.some((l, i) => l.trim() === line && isBareCue(lines, i));
}

/** Whether a note can be lore for a check: the script and script pages never are. */
export function isLoreNote(path: string, g: Pick<LoreGround, 'scriptPath' | 'scriptFolder'>): boolean {
	return path !== g.scriptPath && !isScriptNote(path, g.scriptFolder);
}

/**
 * Keep the flags that can be verified. A line must be in the checked text, and
 * be one line: a fragment that fits several names none of them, and a cue names
 * no line, since it says nothing that could contradict a note. A note must
 * exist, must be lore, and must have been shown to the model. A flag that fails is counted
 * in `leftOut`, not shown: an issue the list cannot back is worse than one it
 * misses. A flag on a line the canon note quotes is dropped without a count,
 * since that change is deliberate, as is an exact repeat of a flag. A line is
 * listed once, so a different claim on a line already listed is counted too.
 */
export function groundLoreCheck(raw: readonly RawIssue[], g: LoreGround): Pick<LoreCheckRecord, 'issues' | 'leftOut'> {
	const issues: LoreIssue[] = [];
	const seen = new Set<string>();
	let leftOut = 0;
	for (const r of raw) {
		let found = matchLines(g.scope, r.line);
		const cue = found.length === 0 ? leadingCue(r.line, g.scope) : '';
		if (cue) found = matchLines(g.scope, r.line.slice(cue.length));
		const match = new Set(found.map((f) => f.line)).size === 1 ? found[0] : undefined;
		const notePath = g.resolve(r.note);
		const lore = notePath !== null && isLoreNote(notePath, g) && g.shown.has(notePath);
		if (!match || !lore || isCueLine(g.scope, match.line)) {
			leftOut++;
			continue;
		}
		if (g.canonText !== null && inCanon(g.canonText, match.line)) continue;
		const claim = `${match.line}\n${notePath}\n${r.says}`;
		if (seen.has(claim)) continue;
		seen.add(claim);
		if (issues.some((i) => i.line === match.line)) {
			leftOut++;
			continue;
		}
		const issue: LoreIssue = { id: g.newId(), line: match.line, says: r.says, note: baseName(notePath), notePath };
		const fix = r.fix === undefined || citesNote(r.fix, r.note, match.line) ? undefined : correctedLine(match, r.fix, cue);
		if (fix !== undefined && !keepsLine(fix, match.line)) issue.fix = fix;
		issues.push(issue);
	}
	return { issues, ...(leftOut > 0 ? { leftOut } : {}) };
}

/**
 * The whole corrected line, or undefined when that cannot be shown. Fix it
 * replaces the whole script line, so a fix for part of a line must carry the
 * rest of it, and a line written with a character cue must keep the cue. All
 * that is added back is the quote marks of a prose line, which `unquote` took
 * off the line and the fix alike. A character name on any other line is
 * dropped; `cue` is what the quote had in front of the line's text, which the
 * fix may repeat.
 */
function correctedLine(match: LineMatch, fix: string, cue: string): string | undefined {
	const uncued = cue && fix.toLowerCase().startsWith(cue.toLowerCase()) ? fix.slice(cue.length) : fix;
	const lineCue = INLINE_CUE.exec(match.line)?.[0] ?? '';
	const body = lineCue ? uncued : uncued.replace(INLINE_CUE, '');
	const plain = plainQuotes(body);
	if (!plain.startsWith(plainQuotes(lineCue))) return undefined;
	const head = plain.startsWith(plainQuotes(match.before)) ? '' : match.before;
	const tail = plain.endsWith(plainQuotes(match.after)) ? '' : match.after;
	return /[^"'“”‘’]/.test(head + tail) ? undefined : `${head}${body}${tail}`;
}

/**
 * The character cue in front of a quoted line. `KAEL: ` is one anywhere; without
 * the colon, as in `MIRA I remember`, the words in front count only when what
 * follows is a whole line of the script, since a name cannot be told from the
 * start of a sentence.
 */
function leadingCue(quote: string, scope: string): string {
	const colon = INLINE_CUE.exec(quote)?.[0];
	if (colon) return colon;
	const lines = new Set(scope.split('\n').map((l) => l.trim().toLowerCase()));
	for (const gap of quote.matchAll(/\s+/g)) {
		const rest = gap.index + gap[0].length;
		if (rest > MAX_CUE) break;
		if (lines.has(quote.slice(rest).toLowerCase())) return quote.slice(0, rest);
	}
	return '';
}

/** Whether a fix still holds the whole line, the same or with a note added: what it got wrong is still there, so it corrects nothing. */
function keepsLine(fix: string, line: string): boolean {
	return plainQuotes(fix).includes(plainQuotes(line.replace(/[.!?…]+$/, '')));
}

/** Whether the canon note quotes this script line, as an Intentional entry does. */
export function inCanon(canon: string, line: string): boolean {
	return plainQuotes(canon).includes(`"${plainQuotes(line)}"`);
}

function plainQuotes(text: string): string {
	return text.replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/\s+/g, ' ').toLowerCase();
}

/** Vault paths the turn from `userMessageId` on showed the model: attached context and tool results, read or excerpted. */
export function shownPaths(messages: readonly StoredMessage[], userMessageId: string): Set<string> {
	const start = messages.findIndex((m) => m.id === userMessageId);
	const out = new Set<string>();
	for (const m of messages.slice(Math.max(0, start))) {
		for (const s of m.sources ?? []) if (s.kind === 'vault') out.add(s.path);
	}
	return out;
}

/** Most lore notes that go with a check; the rest are a tool call away. */
export const MAX_LORE_NOTES = 12;
/** Names shorter than this match too many words to mean the note. */
const MIN_NAME_LENGTH = 3;

/** How often `name` appears in `text` as a whole word or phrase. Both lower case. */
function mentions(text: string, name: string): number {
	let count = 0;
	for (let at = text.indexOf(name); at >= 0; at = text.indexOf(name, at + name.length)) {
		const before = text.slice(Math.max(0, at - 2), at);
		const after = text.slice(at + name.length, at + name.length + 2);
		if (!/[\p{L}\p{N}]$/u.test(before) && !/^[\p{L}\p{N}]/u.test(after)) count++;
	}
	return count;
}

/**
 * The lore notes a script names, most mentioned first, as context for the
 * check: every note whose name or alias appears in it, up to `MAX_LORE_NOTES`,
 * leaving out the script, script pages, blank notes and the canon note, which
 * goes anyway. `named` counts them before the cap. A check that relied on the
 * model to look these up found nothing on the runs where it did not: see
 * decisions.
 */
export async function loreForScript(vault: VaultPort, script: string, g: Pick<LoreGround, 'scriptPath' | 'scriptFolder'> & { canonPath: string }): Promise<{ items: ContextItem[]; named: number }> {
	const text = script.toLowerCase();
	const scored: Array<{ path: string; name: string; count: number }> = [];
	for (const file of vault.listMarkdownFiles()) {
		if (file.path === g.canonPath || file.size === 0 || !isLoreNote(file.path, g)) continue;
		const aliases: unknown = vault.getFrontmatter(file.path)?.['aliases'];
		const names: unknown[] = [file.name, ...(Array.isArray(aliases) ? (aliases as unknown[]) : [aliases])];
		let count = 0;
		for (const name of names) {
			if (typeof name === 'string' && name.trim().length >= MIN_NAME_LENGTH) count += mentions(text, name.trim().toLowerCase());
		}
		if (count > 0) scored.push({ path: file.path, name: file.name, count });
	}
	scored.sort((a, b) => b.count - a.count || a.path.localeCompare(b.path));
	const items: ContextItem[] = [];
	for (const { path, name } of scored.slice(0, MAX_LORE_NOTES)) {
		const content = await vault.readNote(path);
		if (content !== null) items.push({ kind: 'lore', label: name, path, content });
	}
	return { items, named: scored.length };
}

/** The user message of a lore check, shown in the chat and sent to the model. */
export function loreCheckRequest(scriptPath: string, selection: boolean): string {
	return `Check the lore of ${selection ? `the selection in ${baseName(scriptPath)}` : baseName(scriptPath)}.`;
}

/** The rules of a lore check turn, in place of the drafting rules. `canon` names the canon note when it was sent. */
export function loreCheckRules(scriptPath: string, toolsEnabled: boolean, canon: string | null): string[] {
	const script = attr(baseName(scriptPath));
	return [
		'',
		`Lore check (the user asked you to check [[${script}]], the script text attached to their message, against the lore in the vault):`,
		toolsEnabled
			? '- The notes for the names in the script are attached. Read them first. For anyone or anything else it names, or a relationship they leave open, use search_notes, read_note and related_notes before you answer.'
			: '- Check against the notes attached and say nothing about what they do not cover.',
		`- The script is never lore: compare it with the other notes, not with itself${toolsEnabled ? ' or with what search_notes shows of it' : ''}.`,
		'- Flag a line only where it contradicts what a lore note says: relationships (who is whose family, ally or enemy), timeline (ages, dates, order of events, who is alive or dead, who was where) and voice (how the note says a character speaks or behaves). Do not flag style, or anything the lore does not mention.',
		'- A contradiction means the line and the note cannot both be true. A line that says the same thing in other words, or with more or less detail, agrees with the lore. VAULT must state a fact the line makes false; if it is only something else true about the same person, leave the line out.',
		...(canon ? [`- The sequel canon note [[${attr(canon)}]], in the <<<canon>>> block, records deliberate changes to the original lore. A script line that agrees with it is not a contradiction, whatever other notes say.`] : []),
		'- Your reply is one fenced block that opens with ```lore and closes with ```, and nothing else. Write one record per contradiction, with a blank line between records:',
		'```lore',
		'LINE: the script line, copied exactly, one line only',
		'VAULT: what the lore note says, in one sentence',
		'NOTE: the name of the lore note that says it',
		'FIX: the whole line rewritten to agree with the lore, keeping its voice',
		'```',
		'- LINE is the one line that is wrong: for dialogue, the spoken line, without the character name above it. FIX has a character name only if LINE does. List only lines that are wrong; a line that agrees with the lore is not listed at all.',
		'- With no contradictions, the block is empty. Never invent one; a clean script is a good result.',
	];
}

// --------------------------------------------------------------- Fix it

/**
 * The note with one line replaced: the line that equals `line` when trimmed,
 * keeping its indent and line ending, or, for a selection that cut a line
 * short, the one place that text appears. The line must still be there, once.
 */
export function replaceLine(note: string, line: string, fix: string): string {
	const lines = note.split('\n');
	const at = lines.flatMap((l, i) => (l.trim() === line ? [i] : []));
	if (at.length > 1) throw new ProposalError(`That line appears ${at.length} times in the note, so it cannot be told which to fix. Edit it by hand.`);
	const [only] = at;
	if (only !== undefined) {
		lines[only] = lines[only]!.replace(line, () => fix);
		return lines.join('\n');
	}
	const first = note.indexOf(line);
	if (first < 0) throw new ProposalError('That line is no longer in the note. Run the lore check again.');
	if (note.indexOf(line, first + line.length) >= 0) throw new ProposalError('That text appears more than once in the note, so it cannot be told which to fix. Edit it by hand.');
	return note.slice(0, first) + fix + note.slice(first + line.length);
}

/**
 * Fix it: propose replacing the issue's line in the script with its corrected
 * line. The engine hashes the note like any edit, so the apply re-checks it.
 */
export async function proposeLoreFix(engine: ProposalEngine, vault: VaultPort, conversationId: string, scriptPath: string, issue: LoreIssue): Promise<ChangeProposal> {
	if (issue.fix === undefined) throw new ProposalError('This issue has no suggested line.');
	const before = await vault.readNote(scriptPath);
	if (before === null) throw new ProposalError(`No note found at ${scriptPath}.`);
	const after = replaceLine(before, issue.line, issue.fix);
	try {
		rejectNewPlaceholders(before, after);
	} catch {
		throw new ProposalError('The suggested line has placeholder text in it. Edit the line by hand, or run the lore check again.');
	}
	return engine.proposeRewrite(conversationId, scriptPath, after, `Replace this line in ${baseName(scriptPath)} to agree with ${issue.note}.`, before);
}

// --------------------------------------------------------- sequel canon

const CANON_INTRO = '# Sequel canon\n\nDeliberate changes to the original lore. Dragonglass reads this note with every message: where it and another note differ, this note wins for drafting and for the lore check.\n\n';

/** The canon note's path from the setting: `.md` added, and the default for an empty or refused path. */
export function canonNotePath(setting: string, configDir: string): string {
	const path = normalizeVaultPath(setting);
	if (path === '') return DEFAULT_SETTINGS.canonNote;
	try {
		return validateVaultPath(/\.md$/i.test(path) ? path : `${path}.md`, { configDir });
	} catch (e) {
		if (e instanceof InvalidPathError) return DEFAULT_SETTINGS.canonNote;
		throw e;
	}
}

/** The line an Intentional adds to the canon note. It quotes the script line, which is what keeps that line from being flagged again. */
export function canonEntry(scriptPath: string, issue: Pick<LoreIssue, 'line' | 'says' | 'note'>): string {
	return `- "${issue.line}" ([[${baseName(scriptPath)}]]) is deliberate. It replaces what [[${issue.note}]] says: ${issue.says}`;
}

/**
 * Intentional: propose adding the change to the canon note, creating the note
 * when it does not exist yet. The canon note is read back the next time it
 * is sent, so nothing else has to know about the entry.
 */
export async function proposeCanonEntry(engine: ProposalEngine, vault: VaultPort, conversationId: string, canonPath: string, scriptPath: string, issue: LoreIssue): Promise<ChangeProposal> {
	const entry = canonEntry(scriptPath, issue);
	const name = baseName(canonPath);
	try {
		if (vault.exists(canonPath)) return await engine.proposeEdit(conversationId, canonPath, [{ type: 'append', content: `${entry}\n` }], `Record this change in ${name} as deliberate.`);
		return await engine.proposeCreate(conversationId, canonPath, `${CANON_INTRO}${entry}\n`, `Create ${name} and record this change as deliberate.`);
	} catch (e) {
		if (e instanceof ProposalError && /placeholder/.test(e.message)) throw new ProposalError('This line has placeholder text in it, so it was not added to the canon note. Add it by hand.');
		throw e;
	}
}

/** The canon note as context for a send, or null when it does not exist or is blank. */
export async function canonContext(vault: VaultPort, canonPath: string): Promise<ContextItem | null> {
	const content = await vault.readNote(canonPath);
	if (content === null || content.trim() === '') return null;
	return { kind: 'canon', label: baseName(canonPath), path: canonPath, content };
}

/** The system prompt's rule for a send that carries the canon note. */
export function canonRule(canon: string): string {
	return `- The sequel canon note [[${attr(canon)}]], in the <<<canon>>> block, records deliberate changes to the original lore. When drafting, it overrides every other note: where they differ, write what it says.`;
}
