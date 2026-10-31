/**
 * Search benchmark over a generated vault: index build time and memory,
 * search latency, one-note update cost, how often the note that answers each
 * question ranks in the top k, and how often search_notes' auto-read puts
 * that note's text in front of the model.
 *
 *   node scripts/retrieval-lab/gen-vault.mjs <outdir> 20000 7
 *   node scripts/retrieval-lab/build.mjs
 *   node --expose-gc scripts/retrieval-lab/dist/bench-search.mjs <outdir> [--scan]
 *
 * The longest stretch of synchronous work between two yields to the UI is
 * reported for the build and for catching up on a large folder rename (the
 * rename happens in memory, last, after the search measurements).
 * `--scan` also times what every search cost before the index: lowercasing
 * every note and running each query word's word-start finder over it.
 * `modelQuery` fields (scripts/retrieval-lab/gen-queries.mjs) are scored
 * alongside the full questions when present. Reads the vault, writes nothing.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { searchFields, searchTerms, weightedMatches, wordStartFinder } from '../../src/search/tokenize';
import { VaultSearchIndex } from '../../src/search/vault-index';
import { createVaultTools } from '../../src/tools/vault-tools';
import { ProposalEngine } from '../../src/vault/proposals';
import { DirVaultPort } from './dir-vault';

interface Question {
	id: string;
	kind: string;
	question: string;
	modelQuery?: string;
	answers: string[];
}

const [outdir, ...flags] = process.argv.slice(2);
if (!outdir) throw new Error('usage: bench-search.mjs <outdir> [--scan]');
const questions = JSON.parse(readFileSync(join(outdir, 'questions.json'), 'utf8')) as Question[];
const ctx = { conversationId: 'bench', signal: new AbortController().signal };

const gc = (): void => (globalThis as { gc?: () => void }).gc?.();
const memory = (): number => {
	gc();
	const m = process.memoryUsage();
	return m.heapUsed + m.arrayBuffers;
};
const mb = (bytes: number): string => `${(bytes / 1048576).toFixed(1)} MB`;
const ms = (x: number): string => `${x.toFixed(1)} ms`;
const percentile = (xs: number[], p: number): number => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p * xs.length))] ?? 0;

const vault = new DirVaultPort(join(outdir, 'vault'));
const bytes = [...vault.text.values()].reduce((a, t) => a + t.length, 0);
console.log(`${vault.text.size} notes, ${mb(bytes)} of text, ${questions.length} questions`);

// Build as the plugin does: slices of work with a macrotask yield between them.
// A stall is the synchronous work between resuming from one yield and the next
// (or the end): how long the UI thread would be blocked.
const stalls = { longest: 0, since: performance.now() };
const resetStalls = (): void => {
	stalls.longest = 0;
	stalls.since = performance.now();
};
const endStall = (): number => Math.max(stalls.longest, performance.now() - stalls.since);
const before = memory();
const index = new VaultSearchIndex(vault, async () => {
	stalls.longest = Math.max(stalls.longest, performance.now() - stalls.since);
	await new Promise((resolve) => setTimeout(resolve, 0));
	stalls.since = performance.now();
});
resetStalls();
let t = performance.now();
await index.start();
const buildMs = performance.now() - t;
const buildStall = endStall();
const stats = await index.stats();
console.log(
	`index: build ${ms(buildMs)} (longest stall ${ms(buildStall)}), ${stats.terms} terms, ${stats.postings} postings, typed arrays ${mb(stats.bytes)}, heap and buffers +${mb(memory() - before)}`,
);

const some = [...vault.text.keys()].slice(0, 200);
t = performance.now();
for (const path of some) {
	(index as unknown as { pending: Set<string> }).pending.add(path);
	await index.stats();
}
console.log(`update one changed note: ${((performance.now() - t) / some.length).toFixed(2)} ms`);

const fields = ['question', ...(questions.some((q) => q.modelQuery) ? ['modelQuery'] : [])] as const;
const searchTool = (autoReadTokens: number) =>
	createVaultTools(vault, new ProposalEngine(vault), { maxReadChars: 20_000, maxSearchResults: 20, autoReadTokens }, index).find(
		(tool) => tool.name === 'search_notes',
	)!;

for (const field of fields) {
	const queryOf = (q: Question): string => (field === 'modelQuery' ? q.modelQuery || q.question : q.question);
	const ranks: number[] = [];
	const times: number[] = [];
	for (const q of questions) {
		t = performance.now();
		const hits = await index.search(queryOf(q), { folder: '', limit: 50, mode: 'any' });
		times.push(performance.now() - t);
		const at = hits.findIndex((h) => q.answers.includes(h.path));
		ranks.push(at < 0 ? Infinity : at + 1);
	}
	const recall = (k: number): string => `${Math.round((100 * ranks.filter((r) => r <= k).length) / ranks.length)}%`;
	const mrr = ranks.reduce((a, r) => a + (Number.isFinite(r) ? 1 / r : 0), 0) / ranks.length;
	console.log(
		`\n${field}: search p50 ${ms(percentile(times, 0.5))}, p95 ${ms(percentile(times, 0.95))}; answer note @1 ${recall(1)} @3 ${recall(3)} @5 ${recall(5)} @10 ${recall(10)} @50 ${recall(50)}, MRR ${mrr.toFixed(2)}`,
	);
	const coverage: string[] = [];
	for (const budget of [2000, 4000, 8000]) {
		const tool = searchTool(budget);
		let read = 0;
		for (const q of questions) {
			const out = await tool.execute({ query: queryOf(q) }, ctx);
			if (q.answers.some((a) => out.content.includes(`<<<note path="${a}">>>`))) read++;
		}
		coverage.push(`${budget} tokens ${Math.round((100 * read) / questions.length)}%`);
	}
	console.log(`  answer note's text included by one search_notes call: ${coverage.join(', ')}`);

	if (flags.includes('--scan')) {
		const scanTimes: number[] = [];
		for (const q of questions.slice(0, 30)) {
			t = performance.now();
			const finders = searchTerms(queryOf(q)).map(wordStartFinder);
			for (const file of vault.listMarkdownFiles()) {
				const f = searchFields(file.name, (await vault.readNote(file.path)) ?? '');
				finders.some((find) => weightedMatches(f, find) > 0);
			}
			scanTimes.push(performance.now() - t);
		}
		console.log(`  full scan of every note per search (the cost before the index): p50 ${ms(percentile(scanTimes, 0.5))}, p95 ${ms(percentile(scanTimes, 0.95))}`);
	}
}

// Catch-up after renaming the two largest top-level folders, enough to compact on the way.
const sizes = new Map<string, number>();
for (const path of vault.text.keys()) {
	const top = path.split('/')[0]!;
	if (path.includes('/')) sizes.set(top, (sizes.get(top) ?? 0) + 1);
}
const largest = [...sizes].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([folder]) => folder);
let moved = 0;
for (const folder of largest) moved += vault.renameInMemory(folder, `${folder} renamed`);
resetStalls();
t = performance.now();
const afterRename = await index.stats();
console.log(
	`\nfolder rename of ${largest.join(' and ')} (${moved} notes): catch-up ${ms(performance.now() - t)}, longest stall ${ms(endStall())}, ${afterRename.notes} notes indexed`,
);
