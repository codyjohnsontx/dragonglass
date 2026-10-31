import { describe, expect, it } from 'vitest';
import { Bm25Index, queryTerm } from '../src/search/bm25';
import { searchFields, searchTerms, termLookup, tokenCounts, weightedMatches, wordStartFinder } from '../src/search/tokenize';
import { VaultSearchIndex } from '../src/search/vault-index';
import { baseName } from '../src/vault/paths';
import { MemoryVaultPort } from './memory-vault';

const noYield = () => Promise.resolve();

function rankPaths(index: Bm25Index, query: string, folder = '', mode: 'any' | 'all' = 'any') {
	return index.rank(searchTerms(query).map(queryTerm), { folder, limit: 100, mode }, () => Promise.reject(new Error('no check expected')));
}

describe('search tokens', () => {
	it('counts word tokens with name and heading weight, without frontmatter keys', () => {
		const counts = tokenCounts(searchFields('Launch plan', '---\ndate: 2024-10-01\ntags: [launch]\n---\n# Launch\n\nThe launch-date moved.\n'));
		expect(Object.fromEntries(counts)).toEqual({
			'2024': 1, '10': 1, '01': 1, launch: 3 + 1 + 3, the: 1, date: 1, moved: 1, plan: 3,
		});
	});

	it('splits unspaced scripts into characters paired with the next one, and ends words at them', () => {
		expect([...tokenCounts(searchFields('', '我在学习Python编程')).keys()]).toEqual(['我在', '在学', '学习', '习', 'python', '编程', '程']);
		expect([...tokenCounts(searchFields('', 'กิน')).keys()]).toEqual(['กิ', 'ิน', 'น']);
	});

	it('looks most words up as token prefixes and checks the rest on candidates', () => {
		expect(termLookup('risk')).toEqual({ kind: 'prefix', prefix: 'risk', word: true });
		expect(termLookup('会议')).toEqual({ kind: 'prefix', prefix: '会议', word: false });
		expect(termLookup('2024-10')).toEqual({ kind: 'check', exact: ['2024'], prefixes: ['10'] });
		expect(termLookup('c++')).toEqual({ kind: 'check', exact: ['c'], prefixes: [] });
		expect(termLookup('项目会议')).toEqual({ kind: 'check', exact: ['项目', '目会', '会议'], prefixes: [] });
		expect(termLookup('python编程')).toEqual({ kind: 'check', exact: ['编程'], prefixes: [] });
		expect(termLookup('学python')).toEqual({ kind: 'check', exact: [], prefixes: ['学'] });
	});

	// The index must match exactly the notes the word-start scan matched before it (decision 14).
	it('matches exactly what a word-start scan of every note matches', async () => {
		let seed = 42;
		const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
		const pick = <T,>(items: T[]): T => items[Math.floor(rnd() * items.length)]!;
		const words = ['risk', 'risks', 'ai', 'email', 'said', 'c++', 'c#', 'c', '2024-10-01', '2024', '10', 'o\'neil', 'co-op', 'café', 'cafés',
			'会议', '今天的会议记录', '学习python编程', 'データベースのsql設計', 'โครงการ', 'ไม่กินข้าว', 'ไม่', '_ai', '(ai)', '🙂ai', 'x2ai', 'e-mail', 'ai-risks', 'İstanbul'];
		const notes: Record<string, string> = {};
		for (let n = 0; n < 60; n++) {
			const body = Array.from({ length: 12 }, () => pick(words)).join(pick([' ', ', ', '\n', '/']));
			const front = rnd() < 0.3 ? `---\n${pick(['risk', 'date', 'ai'])}: ${pick(words)}\n---\n` : '';
			const heading = rnd() < 0.3 ? `# ${pick(words)}\n` : '';
			notes[`${pick(['A', 'B/C', 'B'])}/${pick(words).replace(/[/#]/g, '')} ${n}.md`] = `${front}${heading}${body}\n`;
		}
		const vault = new MemoryVaultPort(notes);
		const index = new VaultSearchIndex(vault, noYield);
		const queries = ['risk', 'ai', 'c++', 'c#', '2024-10', '10', 'o\'neil', '会议', '会', '项目', 'python', 'sql', 'データ', 'cafe', 'co-op', 'ai-risks', 'mail',
			'istanbul', 'กิน', 'ไม่', 'ข้าว', 'risk ai', '"risks," 2024 会议?', 'e-mail c'];
		let compared = 0;
		for (const query of queries) {
			const terms = searchTerms(query);
			const expected = new Map<string, string[]>();
			for (const [path, content] of vault.files) {
				const fields = searchFields(baseName(path), content);
				const matched = terms.filter((t) => weightedMatches(fields, wordStartFinder(t)) > 0);
				if (matched.length > 0) expected.set(path, matched);
			}
			const hits = await index.search(query, { folder: '', limit: 1000, mode: 'any' });
			expect(new Map(hits.map((h) => [h.path, h.matched])), query).toEqual(expected);
			compared += expected.size;
			const all = await index.search(query, { folder: '', limit: 1000, mode: 'all' });
			expect(all.map((h) => h.path).sort(), query).toEqual([...expected].filter(([, m]) => m.length === terms.length).map(([p]) => p).sort());
		}
		expect(compared).toBeGreaterThan(300);
	});
});

describe('Bm25Index', () => {
	it('scores rarer words higher and keeps results to the folder', async () => {
		const index = new Bm25Index();
		index.upsert('Projects/Nimbus.md', 'Nimbus', 'Project budget.');
		for (let i = 0; i < 10; i++) index.upsert(`Notes/${i}.md`, `${i}`, 'Project notes.');
		const hits = await rankPaths(index, 'nimbus project');
		expect(hits[0]).toMatchObject({ path: 'Projects/Nimbus.md', matched: [0, 1] });
		expect(hits).toHaveLength(11);
		expect((await rankPaths(index, 'project', 'Notes')).every((h) => h.path.startsWith('Notes/'))).toBe(true);
		expect(await rankPaths(index, 'project', 'Not')).toEqual([]);
	});

	it('replaces a note on upsert and drops notes and folders on remove', async () => {
		const index = new Bm25Index();
		index.upsert('A/One.md', 'One', 'apple');
		index.upsert('A/Two.md', 'Two', 'apple');
		index.upsert('B.md', 'B', 'apple');
		index.upsert('A/One.md', 'One', 'banana');
		expect((await rankPaths(index, 'apple')).map((h) => h.path).sort()).toEqual(['A/Two.md', 'B.md']);
		expect((await rankPaths(index, 'banana')).map((h) => h.path)).toEqual(['A/One.md']);
		index.remove('A');
		expect(index.size).toBe(1);
		expect((await rankPaths(index, 'apple banana')).map((h) => h.path)).toEqual(['B.md']);
		index.remove('Missing.md');
		expect(index.size).toBe(1);
	});

	it('ranks the same after many incremental changes as a fresh build of the final notes', async () => {
		let seed = 7;
		const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
		const vocab = Array.from({ length: 300 }, (_, i) => `w${i.toString(36)}`);
		const text = () => Array.from({ length: 40 }, () => vocab[Math.floor(rnd() ** 2 * vocab.length)]).join(' ');
		const live = new Map<string, string>();
		const incremental = new Bm25Index();
		for (let i = 0; i < 500; i++) {
			const content = text();
			live.set(`N/${i}.md`, content);
			incremental.upsert(`N/${i}.md`, `${i}`, content);
		}
		await incremental.compact(noYield);
		// Enough edits and deletes to compact several times on the way.
		let compactions = 0;
		for (let step = 0; step < 6000; step++) {
			if (incremental.needsCompaction()) {
				await incremental.compact(noYield);
				compactions++;
			}
			const path = `N/${Math.floor(rnd() * 600)}.md`;
			if (rnd() < 0.2) {
				live.delete(path);
				incremental.remove(path);
			} else {
				const content = text();
				live.set(path, content);
				incremental.upsert(path, baseName(path), content);
			}
		}
		expect(compactions).toBeGreaterThan(1);
		const fresh = new Bm25Index();
		for (const [path, content] of live) fresh.upsert(path, baseName(path), content);
		expect(incremental.size).toBe(live.size);
		expect(incremental.stats().postings).toBe(fresh.stats().postings);
		for (const query of ['w0', 'w1 w2', 'w3 wa wb', 'w', 'w1']) {
			const a = await rankPaths(incremental, query);
			const b = await rankPaths(fresh, query);
			expect(a.map((h) => h.path), query).toEqual(b.map((h) => h.path));
			a.forEach((h, i) => expect(h.score).toBeCloseTo(b[i]!.score, 9));
		}
	});
});

describe('compaction', () => {
	it('pauses throughout, swaps in only at the end, and ranks as before', async () => {
		const index = new Bm25Index();
		for (let i = 0; i < 2000; i++) index.upsert(`N/${i}.md`, `${i}`, `alpha beta${i % 97} gamma${i} delta ${'filler '.repeat(i % 7)}`);
		const before = await rankPaths(index, 'beta5 gamma12 delta');
		let pauses = 0;
		let checkedMidway = false;
		await index.compact(async () => {
			pauses++;
			if (!checkedMidway) {
				checkedMidway = true;
				expect(() => index.upsert('X.md', 'X', 'alpha')).toThrow(/compacting/);
				await expect(rankPaths(index, 'alpha')).rejects.toThrow(/compacting/);
			}
		});
		expect(pauses).toBeGreaterThan(5);
		expect(checkedMidway).toBe(true);
		expect(index.needsCompaction()).toBe(false);
		const after = await rankPaths(index, 'beta5 gamma12 delta');
		expect(after.map((h) => h.path)).toEqual(before.map((h) => h.path));
		after.forEach((h, i) => expect(h.score).toBeCloseTo(before[i]!.score, 9));
	});
});

describe('VaultSearchIndex', () => {
	const paths = async (index: VaultSearchIndex, query: string) =>
		(await index.search(query, { folder: '', limit: 50, mode: 'any' })).map((h) => h.path).sort();

	it('builds from the vault and follows creates, edits, deletes and renames', async () => {
		const vault = new MemoryVaultPort({ 'Projects/Apollo.md': 'Moon landing.', 'Notes/Mars.md': 'Red planet.' });
		const index = new VaultSearchIndex(vault, noYield);
		await index.start();
		expect(await paths(index, 'moon')).toEqual(['Projects/Apollo.md']);
		await vault.createNote('Notes/Luna.md', 'Moon base.');
		await vault.processNote('Projects/Apollo.md', () => 'Saturn rocket.');
		expect(await paths(index, 'moon')).toEqual(['Notes/Luna.md']);
		expect(await paths(index, 'saturn')).toEqual(['Projects/Apollo.md']);
		vault.rename('Notes/Luna.md', 'Archive/Base.md');
		expect(await paths(index, 'moon')).toEqual(['Archive/Base.md']);
		expect(await paths(index, 'luna base')).toEqual(['Archive/Base.md']);
		vault.rename('Notes', 'Planets');
		expect(await paths(index, 'red')).toEqual(['Planets/Mars.md']);
		vault.delete('Planets');
		expect(await paths(index, 'red')).toEqual([]);
		vault.delete('Archive/Base.md');
		expect(await paths(index, 'moon')).toEqual([]);
		vault.seed('Image.png', 'moon');
		expect(await paths(index, 'moon')).toEqual([]);
		expect((await index.stats()).notes).toBe(1);
	});

	it('yields to the UI during a long build and catches up on changes made meanwhile', async () => {
		const notes: Record<string, string> = {};
		for (let i = 0; i < 3000; i++) notes[`N/${i}.md`] = `note ${i} ${'filler words '.repeat(50)}`;
		const vault = new MemoryVaultPort(notes);
		let yields = 0;
		const index = new VaultSearchIndex(vault, async () => {
			yields++;
			if (yields === 1) await vault.createNote('Late.md', 'arrived during the build');
		});
		const hits = await index.search('arrived', { folder: '', limit: 5, mode: 'any' });
		expect(yields).toBeGreaterThan(0);
		expect(hits.map((h) => h.path)).toEqual(['Late.md']);
		expect((await index.stats()).notes).toBe(3001);
	});

	it('yields while catching up on a large folder rename', async () => {
		const notes: Record<string, string> = {};
		for (let i = 0; i < 3000; i++) notes[`Big/${i}.md`] = `note ${i} ${'filler words '.repeat(50)}`;
		const vault = new MemoryVaultPort(notes);
		let yields = 0;
		const index = new VaultSearchIndex(vault, () => {
			yields++;
			return Promise.resolve();
		});
		await index.start();
		yields = 0;
		vault.rename('Big', 'Moved');
		expect((await index.search('note', { folder: 'Moved', limit: 5000, mode: 'any' })).length).toBe(3000);
		expect(yields).toBeGreaterThan(0);
		expect(await index.search('note', { folder: 'Big', limit: 5, mode: 'any' })).toEqual([]);
	});

	it('re-indexes each note of a renamed folder once, however Obsidian reports the rename', async () => {
		const notes: Record<string, string> = { 'Other/Keep.md': 'kept note' };
		for (let i = 0; i < 2000; i++) notes[`Inbox/Sub${i % 10}/${i}.md`] = `inbox note ${i}`;
		const vault = new MemoryVaultPort(notes);
		const index = new VaultSearchIndex(vault, () => Promise.resolve());
		await index.start();
		const reads: string[] = [];
		const readNote = vault.readNote.bind(vault);
		vault.readNote = (path) => {
			reads.push(path);
			return readNote(path);
		};
		// A folder rename reports the folder and then each file; the old paths are gone by the time each file's event is handled.
		vault.rename('Inbox', 'Archive/Inbox');
		const moved = await index.search('inbox', { folder: '', limit: 5000, mode: 'any' });
		expect(moved).toHaveLength(2000);
		expect(moved.every((h) => h.path.startsWith('Archive/Inbox/Sub'))).toBe(true);
		expect(reads.filter((p) => p.startsWith('Archive/Inbox/')).sort()).toEqual(moved.map((h) => h.path).sort());
		expect((await index.search('kept', { folder: '', limit: 5, mode: 'any' })).map((h) => h.path)).toEqual(['Other/Keep.md']);
		expect((await index.stats()).notes).toBe(2001);
	});

	it('keeps a note searchable when reading it fails, and retries at the next search', async () => {
		const vault = new MemoryVaultPort({ 'A.md': 'alpha', 'B.md': 'beta' });
		const index = new VaultSearchIndex(vault, noYield);
		await index.start();
		const readNote = vault.readNote.bind(vault);
		let failures = 2;
		vault.readNote = (path) => (path === 'A.md' && failures-- > 0 ? Promise.reject(new Error('busy')) : readNote(path));
		await vault.processNote('A.md', () => 'gamma');
		// The failed read leaves the indexed note in place instead of dropping it, and does not spin.
		expect(await paths(index, 'alpha')).toEqual(['A.md']);
		expect(await paths(index, 'gamma')).toEqual([]);
		// Retried at each later search until the read works.
		expect(await paths(index, 'gamma')).toEqual(['A.md']);
		expect(await paths(index, 'alpha')).toEqual([]);
		expect(failures).toBe(-1);
	});

	it('stops following the vault once disposed', async () => {
		const vault = new MemoryVaultPort({ 'A.md': 'alpha' });
		const index = new VaultSearchIndex(vault, noYield);
		await index.start();
		index.dispose();
		vault.seed('B.md', 'alpha');
		expect(await paths(index, 'alpha')).toEqual(['A.md']);
	});
});
