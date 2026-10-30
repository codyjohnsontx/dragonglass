import { describe, expect, it } from 'vitest';
import { copyStatusMessage, copyToClipboard } from '../src/ui/copy';

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

describe('copyStatusMessage', () => {
	it('announces success and failure with distinct text, for the shared live region screen readers hear', () => {
		expect(copyStatusMessage(true)).toBe('Copied to clipboard.');
		expect(copyStatusMessage(false)).toBe('Could not copy to clipboard.');
		expect(copyStatusMessage(true)).not.toBe(copyStatusMessage(false));
	});
});
