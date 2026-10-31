/**
 * Key handling for the chat composer. Return inserts a new line, as it does in
 * any textarea; only Return with the platform modifier (Cmd on macOS, Ctrl on
 * Windows and Linux) sends. Kept free of the Obsidian API so it is unit tested;
 * `ChatView` registers it on the view scope and passes `Platform.isMacOS`.
 */

/** The parts of a keydown event the send check reads, so tests can pass a plain object. */
export type ComposerKeyEvent = Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'isComposing'>;

/**
 * Whether `e` is the send shortcut: Return with the platform modifier held and
 * no other modifier. Shift+Return and plain Return insert a new line. A Return
 * that confirms an IME composition is never a send.
 */
export function isSendKey(e: ComposerKeyEvent, isMac: boolean): boolean {
	if (e.key !== 'Enter' || e.isComposing || e.shiftKey || e.altKey) return false;
	return isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
}

/** The send shortcut as shown to the user, with the platform's modifier name. */
export function sendShortcutLabel(isMac: boolean): string {
	return isMac ? 'Cmd+Enter' : 'Ctrl+Enter';
}
