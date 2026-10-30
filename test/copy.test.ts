import { describe, expect, it } from 'vitest';
import { copyToClipboard, CopyAnnouncer, type StatusRegion, type Timers } from '../src/ui/copy';

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

/** A status region that records every change made to it. */
function fakeRegion(): StatusRegion & { log: string[] } {
	const log: string[] = [];
	return {
		log,
		empty: () => void log.push('empty'),
		setText: (text) => void log.push(text),
	};
}

describe('CopyAnnouncer', () => {
	it('clears the region, then announces a single copy once its delay fires', () => {
		const timers = fakeTimers();
		const announcer = new CopyAnnouncer(timers);
		const region = fakeRegion();

		const attempt = announcer.begin();
		announcer.announce(attempt, region, 'Copied to clipboard.', 100);
		expect(region.log).toEqual(['empty']);
		timers.fire(1);
		expect(region.log).toEqual(['empty', 'Copied to clipboard.']);
	});

	it('only the latest of two quick copies announces, so the region never reports a stale result', () => {
		const timers = fakeTimers();
		const announcer = new CopyAnnouncer(timers);
		const region = fakeRegion();

		const first = announcer.begin();
		announcer.announce(first, region, 'first', 100);

		// A second click arrives before the first's delayed announcement fires, cancelling it.
		const second = announcer.begin();
		announcer.announce(second, region, 'second', 100);

		// The cancelled first timer firing late (e.g. a stray callback) must not announce either.
		timers.fire(1);
		timers.fire(2);
		expect(region.log).toEqual(['empty', 'empty', 'second']);
	});

	it('leaves the region alone when a superseded copy finishes after the latest one announced', () => {
		const timers = fakeTimers();
		const announcer = new CopyAnnouncer(timers);
		const region = fakeRegion();

		const first = announcer.begin();
		const second = announcer.begin();
		announcer.announce(second, region, 'second', 100);
		timers.fire(1);

		// The first click's clipboard write resolves late.
		announcer.announce(first, region, 'first', 100);
		timers.fire(2);
		expect(region.log).toEqual(['empty', 'second']);
	});

	it('cancels a pending announcement on dispose, e.g. when the view closes', () => {
		const timers = fakeTimers();
		const announcer = new CopyAnnouncer(timers);
		const region = fakeRegion();

		const attempt = announcer.begin();
		announcer.announce(attempt, region, 'Copied to clipboard.', 100);

		announcer.dispose();
		timers.fire(1);
		expect(region.log).toEqual(['empty']);
	});

	it('ignores a copy still in flight when the view closes', () => {
		const timers = fakeTimers();
		let scheduled = 0;
		const announcer = new CopyAnnouncer({ ...timers, setTimeout: (fn, ms) => (scheduled++, timers.setTimeout(fn, ms)) });
		const region = fakeRegion();

		const attempt = announcer.begin();
		announcer.dispose();
		// The clipboard write resolves after the view closed.
		announcer.announce(attempt, region, 'Copied to clipboard.', 100);
		expect(scheduled).toBe(0);
		expect(region.log).toEqual([]);
	});
});
