import { Notice } from 'obsidian';
import { StoredMessage } from '../persistence/conversation';

/** The part of the clipboard API the copy button needs, so tests can pass a fake. */
export type ClipboardWriter = Pick<Clipboard, 'writeText'>;

/**
 * What the copy button puts on the clipboard for a message: its Markdown text
 * as the model wrote it. Thinking, tool calls, warnings and usage are shown
 * around the reply but are not part of it, so they are left out.
 */
export function messageClipboardText(m: StoredMessage): string {
	return m.content;
}

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
