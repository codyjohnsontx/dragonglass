/**
 * Line-based diff (LCS) used to render proposal reviews. Dependency-free and
 * small; good enough for note-sized inputs. For very large files we fall back
 * to a coarse "replace all" diff to keep the UI responsive.
 */

export type DiffOp = 'same' | 'add' | 'del';

export interface DiffLine {
	op: DiffOp;
	text: string;
}

export interface DiffStats {
	added: number;
	removed: number;
}

const MAX_LCS_LINES = 4000;

export function diffLines(before: string, after: string): DiffLine[] {
	const a = splitForDiff(before);
	const b = splitForDiff(after);
	if (a.length * b.length > MAX_LCS_LINES * MAX_LCS_LINES) {
		return [...a.map((text) => ({ op: 'del' as const, text })), ...b.map((text) => ({ op: 'add' as const, text }))];
	}
	// Trim common prefix and suffix to shrink the LCS table.
	let start = 0;
	while (start < a.length && start < b.length && a[start] === b[start]) start++;
	let endA = a.length;
	let endB = b.length;
	while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
		endA--;
		endB--;
	}
	const midA = a.slice(start, endA);
	const midB = b.slice(start, endB);
	const out: DiffLine[] = [];
	for (let i = 0; i < start; i++) out.push({ op: 'same', text: a[i] ?? '' });
	out.push(...lcsDiff(midA, midB));
	for (let i = endA; i < a.length; i++) out.push({ op: 'same', text: a[i] ?? '' });
	return out;
}

function lcsDiff(a: string[], b: string[]): DiffLine[] {
	const n = a.length;
	const m = b.length;
	if (n === 0) return b.map((text) => ({ op: 'add' as const, text }));
	if (m === 0) return a.map((text) => ({ op: 'del' as const, text }));
	// dp[i][j] = LCS length of a[i..] and b[j..]
	const width = m + 1;
	const dp = new Uint32Array((n + 1) * width);
	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) {
			dp[i * width + j] =
				a[i] === b[j]
					? (dp[(i + 1) * width + j + 1] ?? 0) + 1
					: Math.max(dp[(i + 1) * width + j] ?? 0, dp[i * width + j + 1] ?? 0);
		}
	}
	const out: DiffLine[] = [];
	let i = 0;
	let j = 0;
	while (i < n && j < m) {
		if (a[i] === b[j]) {
			out.push({ op: 'same', text: a[i] ?? '' });
			i++;
			j++;
		} else if ((dp[(i + 1) * width + j] ?? 0) >= (dp[i * width + j + 1] ?? 0)) {
			out.push({ op: 'del', text: a[i] ?? '' });
			i++;
		} else {
			out.push({ op: 'add', text: b[j] ?? '' });
			j++;
		}
	}
	while (i < n) out.push({ op: 'del', text: a[i++] ?? '' });
	while (j < m) out.push({ op: 'add', text: b[j++] ?? '' });
	return out;
}

function splitForDiff(text: string): string[] {
	if (text === '') return [];
	const lines = text.split('\n');
	if (lines[lines.length - 1] === '' && text.endsWith('\n')) lines.pop();
	return lines;
}

export function diffStats(lines: DiffLine[]): DiffStats {
	let added = 0;
	let removed = 0;
	for (const l of lines) {
		if (l.op === 'add') added++;
		else if (l.op === 'del') removed++;
	}
	return { added, removed };
}

export interface DiffHunk {
	lines: DiffLine[];
	/** Number of unchanged lines skipped before this hunk. */
	skippedBefore: number;
}

/** Collapse long runs of unchanged lines, keeping `context` lines around changes. */
export function toHunks(lines: DiffLine[], context = 3): DiffHunk[] {
	const keep = new Array<boolean>(lines.length).fill(false);
	for (let i = 0; i < lines.length; i++) {
		if (lines[i]?.op === 'same') continue;
		for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) keep[k] = true;
	}
	const hunks: DiffHunk[] = [];
	let current: DiffHunk | null = null;
	let skipped = 0;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (!line) continue;
		if (keep[i]) {
			if (!current) {
				current = { lines: [], skippedBefore: skipped };
				hunks.push(current);
				skipped = 0;
			}
			current.lines.push(line);
		} else {
			current = null;
			skipped++;
		}
	}
	return hunks;
}

/** Render a unified-style text diff, used for tests and copy-to-clipboard. */
export function formatUnified(lines: DiffLine[]): string {
	return lines
		.map((l) => (l.op === 'add' ? `+${l.text}` : l.op === 'del' ? `-${l.text}` : ` ${l.text}`))
		.join('\n');
}
