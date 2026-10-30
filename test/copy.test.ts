import { describe, expect, it } from 'vitest';
import { copyToClipboard, CopyAnnouncer, type Timers } from '../src/ui/copy';

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

/** A fake clock so tests can control exactly when a scheduled callback fires. */
function fakeTimers(): Timers & { fire(id: number): void } {
	const callbacks = new Map<number, () => void>();
	let nextId = 1;
	return {
		setTimeout: (fn) => {
			const id = nextId++;
			callbacks.set(id, fn);
			return id;
		},
		clearTimeout: (id) => void callbacks.delete(id),
		fire: (id) => {
			callbacks.get(id)?.();
			callbacks.delete(id);
		},
	};
}

describe('CopyAnnouncer', () => {
	it('announces a single copy once its delay fires', () => {
		const timers = fakeTimers();
		const announcer = new CopyAnnouncer(timers);
		const announced: string[] = [];

		const attempt = announcer.begin();
		announcer.announce(attempt, 100, () => announced.push('Copied to clipboard.'));
		expect(announced).toEqual([]);
		timers.fire(1);
		expect(announced).toEqual(['Copied to clipboard.']);
	});

	it('only the latest of two quick copies announces, so the region never reports a stale result', () => {
		const timers = fakeTimers();
		const announcer = new CopyAnnouncer(timers);
		const announced: string[] = [];

		const first = announcer.begin();
		announcer.announce(first, 100, () => announced.push('first'));

		// A second click arrives before the first's delayed announcement fires, cancelling it.
		const second = announcer.begin();
		announcer.announce(second, 100, () => announced.push('second'));

		// The cancelled first timer firing late (e.g. a stray callback) must not announce either.
		timers.fire(1);
		timers.fire(2);
		expect(announced).toEqual(['second']);
	});

	it('cancels a pending announcement on dispose, e.g. when the view closes', () => {
		const timers = fakeTimers();
		const announcer = new CopyAnnouncer(timers);
		const announced: string[] = [];

		const attempt = announcer.begin();
		announcer.announce(attempt, 100, () => announced.push('Copied to clipboard.'));

		announcer.dispose();
		timers.fire(1);
		expect(announced).toEqual([]);
	});
});
