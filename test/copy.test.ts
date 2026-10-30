import { describe, expect, it } from 'vitest';
import { copyToClipboard } from '../src/ui/copy';

describe('copyToClipboard', () => {
	it('writes the text and reports success', async () => {
		const written: string[] = [];
		const ok = await copyToClipboard('hello', { writeText: async (t) => void written.push(t) });
		expect(ok).toBe(true);
		expect(written).toEqual(['hello']);
	});

	it('reports failure without throwing when the clipboard rejects', async () => {
		const ok = await copyToClipboard('hello', {
			writeText: () => Promise.reject(new Error('Write permission denied.')),
		});
		expect(ok).toBe(false);
	});

	it('reports failure when there is no clipboard at all', async () => {
		expect(await copyToClipboard('hello', undefined)).toBe(false);
	});
});
