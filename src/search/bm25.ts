import { isUnderAny } from '../vault/paths';
import { SearchFields, searchFields, termLookup, TermLookup, tokenCounts } from './tokenize';

/**
 * In-memory BM25 index over note tokens (see `tokenCounts`), held in typed
 * arrays: postings live in one compressed sparse row block with the
 * dictionary sorted, so a query word's tokens are one contiguous range,
 * plus a small delta for notes changed since. A changed note is removed
 * and added again; removed notes stay as dead rows until the next
 * compaction drops them.
 */

const K1 = 1.2;
const B = 0.75;
/** Delta and dead postings tolerated before a compaction, as a share of the block, with a floor for small vaults. */
const COMPACT_SHARE = 0.25;
const COMPACT_MIN = 50_000;
const MAX_TF = 65_535;
/**
 * How much a word the query word only starts ("risks" for "risk") counts
 * against the word itself. It still matches; it ranks below an exact word,
 * so "vi" prefers notes about "VI" over ones that mention "video".
 */
const LONGER_WORD_WEIGHT = 0.25;
/** Query terms beyond this many are ignored; each takes one bit of a match mask. */
export const MAX_QUERY_TERMS = 32;

export interface QueryTerm {
	term: string;
	lookup: TermLookup;
}

export function queryTerm(term: string): QueryTerm {
	return { term, lookup: termLookup(term) };
}

export interface RankedNote {
	path: string;
	score: number;
	/** Indexes of the query terms the note matched, in query order. */
	matched: number[];
}

export interface RankOptions {
	/** Only notes under this folder (vault-relative, no trailing slash); "" for all. */
	folder: string;
	limit: number;
	/** `all` keeps only notes that match every term. */
	mode: 'any' | 'all';
}

/**
 * Weighted count of a term in a candidate note, counted the way the index
 * counts tokens; zero when the note does not really contain it.
 */
export type CheckTerm = (path: string, term: number) => Promise<number>;

/** Called between pieces of a long compaction; resolves once the caller has yielded to the UI if it wanted to. */
export type Pause = () => Promise<void>;

/** Items of work (notes, terms, postings, comparisons) between two calls to `Pause`. */
const PAUSE_EVERY = 4096;

class WorkCounter {
	private done = 0;

	constructor(readonly pause: Pause) {}

	/** Count work done; true when it is time to call `pause`. */
	add(items: number): boolean {
		this.done += items;
		if (this.done < PAUSE_EVERY) return false;
		this.done = 0;
		return true;
	}
}

/** Term ids in the order of their strings: a bottom-up merge sort, so it can pause between merges. */
async function sortTermIds(ids: number[], terms: string[], work: WorkCounter): Promise<number[]> {
	let from = ids.slice();
	let to = new Array<number>(from.length);
	for (let width = 1; width < from.length; width *= 2) {
		for (let lo = 0; lo < from.length; lo += 2 * width) {
			const mid = Math.min(lo + width, from.length);
			const hi = Math.min(lo + 2 * width, from.length);
			let i = lo;
			let j = mid;
			for (let k = lo; k < hi; k++) {
				const takeRight = i >= mid || (j < hi && terms[from[j]!]! < terms[from[i]!]!);
				to[k] = takeRight ? from[j++]! : from[i++]!;
				if (work.add(1)) await work.pause();
			}
		}
		[from, to] = [to, from];
	}
	return from;
}

/** Two lists of term ids, each sorted by string, merged into one. */
async function mergeSorted(a: number[], b: number[], terms: string[], work: WorkCounter): Promise<number[]> {
	const out: number[] = [];
	let i = 0;
	let j = 0;
	while (i < a.length || j < b.length) {
		if (j >= b.length || (i < a.length && terms[a[i]!]! < terms[b[j]!]!)) out.push(a[i++]!);
		else out.push(b[j++]!);
		if (work.add(1)) await work.pause();
	}
	return out;
}

export interface IndexStats {
	notes: number;
	terms: number;
	postings: number;
	/** Bytes held in typed arrays (postings and note lengths). */
	bytes: number;
}

export class Bm25Index {
	// Notes, by row. A removed note's row keeps a null path until compaction.
	private paths: Array<string | null> = [];
	private lengths = new Float32Array(64);
	private termsPerRow = new Uint32Array(64);
	private rows = new Map<string, number>();
	private liveNotes = 0;
	private totalLength = 0;

	// Dictionary: ids below `blockTerms` are sorted and indexed in the block; later ids are new since then.
	private terms: string[] = [];
	private termIds = new Map<string, number>();
	private blockTerms = 0;

	// Postings: the block (start offsets per term id, then rows and term frequencies), and the delta.
	private blockStart = new Uint32Array(1);
	private blockRows = new Uint32Array(0);
	private blockTfs = new Uint16Array(0);
	private delta = new Map<number, number[]>();
	private deltaPostings = 0;
	private deadPostings = 0;
	private compacting = false;

	get size(): number {
		return this.liveNotes;
	}

	has(path: string): boolean {
		return this.rows.has(path);
	}

	/** Index a note, replacing what was indexed for its path. */
	upsert(path: string, name: string, content: string): void {
		this.upsertFields(path, searchFields(name, content));
	}

	upsertFields(path: string, fields: SearchFields): void {
		this.assertNotCompacting();
		this.removeRow(path);
		const row = this.paths.length;
		this.paths.push(path);
		this.rows.set(path, row);
		this.ensureRows(row + 1);
		let length = 0;
		let distinct = 0;
		for (const [token, count] of tokenCounts(fields)) {
			let id = this.termIds.get(token);
			if (id === undefined) {
				id = this.terms.length;
				this.terms.push(token);
				this.termIds.set(token, id);
			}
			let list = this.delta.get(id);
			if (!list) this.delta.set(id, (list = []));
			list.push(row, Math.min(count, MAX_TF));
			length += count;
			distinct++;
		}
		this.lengths[row] = length;
		this.termsPerRow[row] = distinct;
		this.deltaPostings += distinct;
		this.totalLength += length;
		this.liveNotes++;
	}

	/** Drop a note, or every note under a folder path. */
	remove(path: string): void {
		this.removeAll([path]);
	}

	/**
	 * Drop notes, and every note under any of the paths that is not itself an
	 * indexed note (a folder), in at most one pass over the index however many
	 * paths there are: a folder rename reports thousands of old paths at once.
	 */
	removeAll(paths: Iterable<string>): void {
		this.assertNotCompacting();
		const folders = new Set<string>();
		for (const p of paths) {
			if (this.rows.has(p)) this.removeRow(p);
			else folders.add(p);
		}
		if (folders.size === 0) return;
		const under: string[] = [];
		for (const p of this.rows.keys()) if (isUnderAny(p, folders)) under.push(p);
		for (const p of under) this.removeRow(p);
	}

	private removeRow(path: string): void {
		const row = this.rows.get(path);
		if (row === undefined) return;
		this.rows.delete(path);
		this.paths[row] = null;
		this.liveNotes--;
		this.totalLength -= this.lengths[row] ?? 0;
		this.deadPostings += this.termsPerRow[row] ?? 0;
	}

	private ensureRows(n: number): void {
		if (n <= this.lengths.length) return;
		const size = Math.max(n, this.lengths.length * 2);
		const lengths = new Float32Array(size);
		lengths.set(this.lengths);
		this.lengths = lengths;
		const termsPerRow = new Uint32Array(size);
		termsPerRow.set(this.termsPerRow);
		this.termsPerRow = termsPerRow;
	}

	/** Whether enough has changed since the last compaction (or nothing was ever compacted) to run one. */
	needsCompaction(): boolean {
		if (this.deltaPostings === 0 && this.deadPostings === 0) return false;
		if (this.blockRows.length === 0) return true;
		const threshold = Math.max(COMPACT_MIN, this.blockRows.length * COMPACT_SHARE);
		return this.deltaPostings > threshold || this.deadPostings > threshold;
	}

	private assertNotCompacting(): void {
		if (this.compacting) throw new Error('search index is compacting');
	}

	/**
	 * Rebuild the block from live postings: rows renumbered densely, terms
	 * sorted, nothing dead or pending. Every pass over notes, terms or
	 * postings calls `pause` every few thousand items so the caller can yield
	 * to the UI; the new arrays replace the old ones only at the end, and the
	 * index must not be changed or searched until the returned promise settles.
	 */
	async compact(pause: Pause): Promise<void> {
		this.assertNotCompacting();
		this.compacting = true;
		try {
			await this.rebuild(pause);
		} finally {
			this.compacting = false;
		}
	}

	private async rebuild(pause: Pause): Promise<void> {
		const work = new WorkCounter(pause);
		const newRow = new Int32Array(this.paths.length).fill(-1);
		const paths: string[] = [];
		for (let row = 0; row < this.paths.length; row++) {
			const p = this.paths[row];
			if (p !== null && p !== undefined) {
				newRow[row] = paths.length;
				paths.push(p);
			}
			if (work.add(1)) await work.pause();
		}
		const counts = new Uint32Array(this.terms.length);
		let total = 0;
		for (let id = 0; id < this.terms.length; id++) {
			let n = 0;
			this.forEachPosting(id, () => n++);
			counts[id] = n;
			total += n;
			if (work.add(n + 1)) await work.pause();
		}
		// Block terms are already in order; only terms added since need sorting, then the two lists merge.
		const old: number[] = [];
		const fresh: number[] = [];
		for (let id = 0; id < this.terms.length; id++) {
			if (counts[id]! > 0) (id < this.blockTerms ? old : fresh).push(id);
			if (work.add(1)) await work.pause();
		}
		const kept = await mergeSorted(old, await sortTermIds(fresh, this.terms, work), this.terms, work);
		const start = new Uint32Array(kept.length + 1);
		const rows = new Uint32Array(total);
		const tfs = new Uint16Array(total);
		let at = 0;
		for (let newId = 0; newId < kept.length; newId++) {
			start[newId] = at;
			this.forEachPosting(kept[newId]!, (row, tf) => {
				rows[at] = newRow[row]!;
				tfs[at] = tf;
				at++;
			});
			if (work.add(counts[kept[newId]!]! + 1)) await work.pause();
		}
		start[kept.length] = at;

		const lengths = new Float32Array(Math.max(64, paths.length));
		const termsPerRow = new Uint32Array(lengths.length);
		const rowIds = new Map<string, number>();
		for (let row = 0; row < this.paths.length; row++) {
			const to = newRow[row]!;
			if (to >= 0) {
				lengths[to] = this.lengths[row]!;
				termsPerRow[to] = this.termsPerRow[row]!;
				rowIds.set(paths[to]!, to);
			}
			if (work.add(1)) await work.pause();
		}
		const terms: string[] = [];
		const termIds = new Map<string, number>();
		for (const id of kept) {
			termIds.set(this.terms[id]!, terms.length);
			terms.push(this.terms[id]!);
			if (work.add(1)) await work.pause();
		}

		this.paths = paths;
		this.lengths = lengths;
		this.termsPerRow = termsPerRow;
		this.rows = rowIds;
		this.terms = terms;
		this.termIds = termIds;
		this.blockTerms = terms.length;
		this.blockStart = start;
		this.blockRows = rows;
		this.blockTfs = tfs;
		this.delta = new Map();
		this.deltaPostings = 0;
		this.deadPostings = 0;
	}

	/** Live postings of one term id, block first, then delta. */
	private forEachPosting(id: number, fn: (row: number, tf: number) => void): void {
		if (id < this.blockTerms) this.forEachBlockPosting(this.blockStart[id]!, this.blockStart[id + 1]!, fn);
		const list = this.delta.get(id);
		if (!list) return;
		for (let i = 0; i < list.length; i += 2) {
			const row = list[i]!;
			if (this.paths[row] !== null) fn(row, list[i + 1]!);
		}
	}

	private forEachBlockPosting(from: number, to: number, fn: (row: number, tf: number) => void): void {
		for (let i = from; i < to; i++) {
			const row = this.blockRows[i]!;
			if (this.paths[row] !== null) fn(row, this.blockTfs[i]!);
		}
	}

	/** Live postings of every token that starts with `prefix`. */
	private forEachPrefixPosting(prefix: string, fn: (row: number, tf: number) => void): void {
		const lo = lowerBound(this.terms, this.blockTerms, prefix);
		let hi = lo;
		while (hi < this.blockTerms && this.terms[hi]!.startsWith(prefix)) hi++;
		this.forEachBlockPosting(this.blockStart[lo]!, this.blockStart[hi]!, fn);
		for (const [id, list] of this.delta) {
			if (!this.terms[id]!.startsWith(prefix)) continue;
			for (let i = 0; i < list.length; i += 2) {
				const row = list[i]!;
				if (this.paths[row] !== null) fn(row, list[i + 1]!);
			}
		}
	}

	private forEachExactPosting(token: string, fn: (row: number, tf: number) => void): void {
		const id = this.termIds.get(token);
		if (id !== undefined) this.forEachPosting(id, fn);
	}

	/**
	 * Rank notes for the query terms by BM25: each term's weighted count in a
	 * note, saturated and normalized by note length, times the term's rarity
	 * across the vault. A query word counts in full where it is the whole
	 * word and less where it starts a longer one. Terms the index cannot
	 * answer exactly are checked on each candidate with `check`.
	 */
	async rank(query: QueryTerm[], options: RankOptions, check: CheckTerm): Promise<RankedNote[]> {
		this.assertNotCompacting();
		const terms = query.slice(0, MAX_QUERY_TERMS);
		const slots = this.paths.length;
		const scores = new Float64Array(slots);
		const masks = new Uint32Array(slots);
		const matchCounts = new Uint8Array(slots);
		const tf = new Float64Array(slots);
		const touched: number[] = [];
		const avgLength = this.liveNotes > 0 ? this.totalLength / this.liveNotes : 1;
		for (const [index, term] of terms.entries()) {
			const found: number[] = [];
			const count = (row: number, n: number) => {
				if (tf[row] === 0) found.push(row);
				tf[row]! += n;
			};
			if (term.lookup.kind === 'prefix') {
				const { prefix, word } = term.lookup;
				if (word) {
					this.forEachPrefixPosting(prefix, (row, n) => count(row, n * LONGER_WORD_WEIGHT));
					this.forEachExactPosting(prefix, (row, n) => count(row, n * (1 - LONGER_WORD_WEIGHT)));
				} else {
					this.forEachPrefixPosting(prefix, count);
				}
			} else {
				for (const row of this.candidates(term.lookup)) {
					const path = this.paths[row];
					const n = path === null || path === undefined ? 0 : await check(path, index);
					if (n > 0) count(row, n);
				}
			}
			const idf = Math.log(1 + (this.liveNotes - found.length + 0.5) / (found.length + 0.5));
			for (const row of found) {
				const n = tf[row]!;
				const norm = K1 * (1 - B + (B * this.lengths[row]!) / avgLength);
				if (masks[row] === 0) touched.push(row);
				scores[row]! += (idf * n * (K1 + 1)) / (n + norm);
				masks[row]! |= 1 << index;
				matchCounts[row]!++;
				tf[row] = 0;
			}
		}
		const prefix = options.folder === '' ? '' : `${options.folder}/`;
		const hits: RankedNote[] = [];
		for (const row of touched) {
			const path = this.paths[row];
			if (path === null || path === undefined || !path.startsWith(prefix)) continue;
			if (options.mode === 'all' && matchCounts[row]! < terms.length) continue;
			const matched = terms.map((_, i) => i).filter((i) => (masks[row]! & (1 << i)) !== 0);
			hits.push({ path, score: scores[row]!, matched });
		}
		hits.sort((a, b) => b.score - a.score || compareStrings(a.path, b.path));
		return hits.slice(0, options.limit);
	}

	/** Rows that hold every token a checked term needs. */
	private candidates(lookup: Extract<TermLookup, { kind: 'check' }>): number[] {
		const needs = [...lookup.exact.map((t) => ({ t, exact: true })), ...lookup.prefixes.map((t) => ({ t, exact: false }))];
		const seen = new Uint32Array(this.paths.length);
		let rows: number[] = [];
		needs.forEach((need, i) => {
			const next: number[] = [];
			const visit = (row: number) => {
				if (seen[row] !== i) return;
				seen[row] = i + 1;
				next.push(row);
			};
			if (need.exact) this.forEachExactPosting(need.t, visit);
			else this.forEachPrefixPosting(need.t, visit);
			rows = next;
		});
		return rows;
	}

	stats(): IndexStats {
		let postings = this.blockRows.length + this.deltaPostings - this.deadPostings;
		if (postings < 0) postings = 0;
		const bytes =
			this.blockStart.byteLength + this.blockRows.byteLength + this.blockTfs.byteLength + this.lengths.byteLength + this.termsPerRow.byteLength;
		return { notes: this.liveNotes, terms: this.termIds.size, postings, bytes };
	}
}

/** Plain UTF-16 order, the order `startsWith` ranges follow. */
function compareStrings(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

/** First index in sorted `items[0, end)` whose value is not below `value`. */
function lowerBound(items: string[], end: number, value: string): number {
	let lo = 0;
	let hi = end;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if (items[mid]! < value) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}
