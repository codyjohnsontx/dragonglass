import { describe, expect, it } from 'vitest';
import { diffLines, diffStats, formatUnified, toHunks } from '../src/vault/diff';

describe('diffLines', () => {
	it('reports no changes for identical text', () => {
		const d = diffLines('a\nb\n', 'a\nb\n');
		expect(d.every((l) => l.op === 'same')).toBe(true);
		expect(diffStats(d)).toEqual({ added: 0, removed: 0 });
	});

	it('finds a single changed line in the middle', () => {
		const d = diffLines('one\ntwo\nthree\n', 'one\n2\nthree\n');
		expect(formatUnified(d)).toBe(' one\n-two\n+2\n three');
	});

	it('handles additions and deletions at the ends', () => {
		expect(formatUnified(diffLines('b\n', 'a\nb\nc\n'))).toBe('+a\n b\n+c');
		expect(formatUnified(diffLines('a\nb\nc\n', 'b\n'))).toBe('-a\n b\n-c');
	});

	it('handles empty inputs', () => {
		expect(diffLines('', '')).toEqual([]);
		expect(diffStats(diffLines('', 'x\ny'))).toEqual({ added: 2, removed: 0 });
	});

	it('collapses unchanged context into hunks', () => {
		const before = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n');
		const after = before.replace('line 15', 'LINE 15');
		const hunks = toHunks(diffLines(before, after), 2);
		expect(hunks).toHaveLength(1);
		expect(hunks[0]?.skippedBefore).toBe(13);
		expect(hunks[0]?.lines.map((l) => l.op)).toEqual(['same', 'same', 'del', 'add', 'same', 'same']);
	});
});
