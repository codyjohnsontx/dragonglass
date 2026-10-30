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

/** Text for the shared live region that announces a copy attempt to screen readers. */
export function copyStatusMessage(ok: boolean): string {
	return ok ? 'Copied to clipboard.' : 'Could not copy to clipboard.';
}
