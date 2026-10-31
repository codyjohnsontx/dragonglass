import { baseName, isUnderAny } from '../vault/paths';
import { VaultChange, VaultPort } from '../vault/port';
import { Bm25Index, IndexStats, queryTerm } from './bm25';
import { searchFields, SearchFields, searchTerms, weightedMatches, wordStartFinder } from './tokenize';

export type SearchMode = 'any' | 'all';

export interface SearchOptions {
	/** Vault-relative folder to search under; "" for the whole vault. */
	folder: string;
	limit: number;
	mode: SearchMode;
}

export interface SearchHit {
	path: string;
	/** Basename without extension, the form wikilinks use. */
	name: string;
	/** Query terms found in the note, in query order. */
	matched: string[];
	/** BM25 score; only its order means anything. */
	score: number;
}

/** Lets the UI run between slices of a long build; a macrotask, because awaiting reads alone never yields. */
export type Yield = () => Promise<void>;

const windowYield: Yield = () => new Promise((resolve) => window.setTimeout(resolve, 0));

/** Work done between yields while building or catching up, in milliseconds. */
const SLICE_MS = 10;

/**
 * The vault's search index: built in memory from the vault's cached note
 * text when the plugin loads, nothing written to disk. Vault changes are
 * queued as they happen and applied before the next search, so a burst of
 * edits costs one re-index per note. Builds and searches run one at a time.
 */
export class VaultSearchIndex {
	private readonly index = new Bm25Index();
	private readonly pending = new Set<string>();
	private built: Promise<void> | null = null;
	private queue: Promise<unknown> = Promise.resolve();
	private unsubscribe: (() => void) | null = null;
	private disposed = false;

	constructor(
		private readonly vault: VaultPort,
		private readonly yieldToUi: Yield = windowYield,
	) {}

	/** Start listening for changes and build the index; the same promise on every call. */
	start(): Promise<void> {
		if (!this.built) {
			this.unsubscribe = this.vault.onChange((change) => this.queueChange(change));
			this.built = this.serialize(() => this.build());
		}
		return this.built;
	}

	dispose(): void {
		this.disposed = true;
		this.unsubscribe?.();
		this.unsubscribe = null;
	}

	async search(query: string, options: SearchOptions): Promise<SearchHit[]> {
		void this.start();
		return this.serialize(async () => {
			await this.catchUp();
			const words = searchTerms(query);
			const finders = words.map(wordStartFinder);
			const fields = new Map<string, SearchFields>();
			const ranked = await this.index.rank(words.map(queryTerm), options, async (path, term) => {
				let f = fields.get(path);
				if (!f) {
					f = searchFields(baseName(path), (await this.vault.readNote(path)) ?? '');
					fields.set(path, f);
				}
				return weightedMatches(f, finders[term]!);
			});
			return ranked.map((r) => ({ path: r.path, name: baseName(r.path), matched: r.matched.map((i) => words[i]!), score: r.score }));
		});
	}

	/** Index size, after the build and any queued changes. */
	async stats(): Promise<IndexStats> {
		await this.start();
		return this.serialize(async () => {
			await this.catchUp();
			return this.index.stats();
		});
	}

	private serialize<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.queue.then(fn);
		this.queue = run.catch(() => undefined);
		return run;
	}

	private queueChange(change: VaultChange): void {
		this.pending.add(change.path);
		if (change.type === 'rename') this.pending.add(change.oldPath);
	}

	private async build(): Promise<void> {
		const slice = new Slicer(this.yieldToUi);
		for (const file of this.vault.listMarkdownFiles()) {
			if (this.disposed) break;
			await this.indexNote(file.path);
			await slice.maybeYield();
		}
		await this.index.compact(() => slice.maybeYield());
	}

	/**
	 * Apply queued changes. A path may be a note, a folder (renamed into place)
	 * or something now gone. Each batch costs work proportional to what
	 * changed: a folder rename that reports the folder and then every file in
	 * it re-indexes each note once and drops the old paths in one pass.
	 */
	private async catchUp(): Promise<void> {
		const slice = new Slicer(this.yieldToUi);
		while (this.pending.size > 0 && !this.disposed) {
			const paths = [...this.pending];
			this.pending.clear();
			const notes = new Set<string>();
			const folders = new Set<string>();
			const gone: string[] = [];
			for (const path of paths) {
				if (this.vault.isFolder(path)) folders.add(path);
				else if (path.endsWith('.md') && this.vault.exists(path)) notes.add(path);
				else gone.push(path);
			}
			if (folders.size > 0) {
				for (const file of this.vault.listMarkdownFiles()) if (isUnderAny(file.path, folders)) notes.add(file.path);
			}
			this.index.removeAll(gone);
			await this.compactIfDue(slice);
			await slice.maybeYield();
			for (const path of notes) {
				if (this.disposed) return;
				await this.indexNote(path);
				await this.compactIfDue(slice);
				await slice.maybeYield();
			}
		}
	}

	private async compactIfDue(slice: Slicer): Promise<void> {
		if (this.index.needsCompaction()) await this.index.compact(() => slice.maybeYield());
	}

	private async indexNote(path: string): Promise<void> {
		let content: string | null;
		try {
			content = await this.vault.readNote(path);
		} catch {
			content = null;
		}
		if (content === null) {
			if (this.index.has(path)) this.index.remove(path);
		} else {
			this.index.upsert(path, baseName(path), content);
		}
	}
}

/** Yields to the UI once a slice of work has run for `SLICE_MS`. */
class Slicer {
	private started = Date.now();

	constructor(private readonly yieldToUi: Yield) {}

	async maybeYield(): Promise<void> {
		if (Date.now() - this.started < SLICE_MS) return;
		await this.yieldToUi();
		this.started = Date.now();
	}
}
