import { Notice } from 'obsidian';

/** The part of the clipboard API the copy button needs, so tests can pass a fake. */
export type ClipboardWriter = Pick<Clipboard, 'writeText'>;

/**
 * Write `text` to `clipboard` (the caller passes the active window's, which
 * is undefined where the page is not allowed to use it). Returns true on
 * success; a failure such as a denied clipboard permission is reported as a
 * Notice and returns false so the caller leaves its button unchanged.
 */
export async function copyToClipboard(text: string, clipboard: ClipboardWriter | undefined): Promise<boolean> {
	if (!clipboard) {
		new Notice('Clipboard is not available here.');
		return false;
	}
	try {
		await clipboard.writeText(text);
		return true;
	} catch (e) {
		new Notice(`Could not copy: ${e instanceof Error ? e.message : String(e)}`);
		return false;
	}
}

/** The timer functions `CopyAnnouncer` needs, so callers can pass `window.setTimeout`/`window.clearTimeout` and tests can pass fakes. */
export interface Timers {
	setTimeout(fn: () => void, delayMs: number): number;
	clearTimeout(id: number): void;
}

/** The part of a screen-reader status element `CopyAnnouncer` writes to, so tests can pass a fake. */
export interface StatusRegion {
	empty(): void;
	setText(text: string): void;
}

/**
 * Serializes announcements to a shared screen-reader status region across
 * concurrent copy clicks: `begin()` marks a new attempt as the latest and
 * cancels any announcement still pending from an earlier one, and
 * `announce()` from an attempt that is no longer the latest leaves the region
 * untouched. `dispose()` cancels any pending announcement and supersedes any
 * attempt still in flight, e.g. when the view closes.
 */
export class CopyAnnouncer {
	private seq = 0;
	private pending: number | null = null;

	constructor(private readonly timers: Timers) {}

	/** Marks a new copy attempt as the latest and cancels any pending announcement. Returns its id for `announce()`. */
	begin(): number {
		this.cancelPending();
		return ++this.seq;
	}

	/**
	 * Clears `region` now and sets it to `message` after `delayMs`, so screen
	 * readers announce a repeated message, unless `attempt` has since been
	 * superseded by a later `begin()` or by `dispose()`.
	 */
	announce(attempt: number, region: StatusRegion, message: string, delayMs: number): void {
		if (attempt !== this.seq) return;
		region.empty();
		this.pending = this.timers.setTimeout(() => {
			this.pending = null;
			if (attempt === this.seq) region.setText(message);
		}, delayMs);
	}

	dispose(): void {
		this.cancelPending();
		this.seq++;
	}

	private cancelPending(): void {
		if (this.pending !== null) {
			this.timers.clearTimeout(this.pending);
			this.pending = null;
		}
	}
}
