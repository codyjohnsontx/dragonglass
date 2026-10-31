import { describe, expect, it } from 'vitest';
import { ComposerKeyEvent, isSendKey, sendShortcutLabel } from '../src/ui/composer-keys';

function key(overrides: Partial<ComposerKeyEvent> = {}): ComposerKeyEvent {
	return { key: 'Enter', metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, isComposing: false, ...overrides };
}

describe('isSendKey', () => {
	it('sends on Cmd+Enter on macOS and Ctrl+Enter elsewhere', () => {
		expect(isSendKey(key({ metaKey: true }), true)).toBe(true);
		expect(isSendKey(key({ ctrlKey: true }), false)).toBe(true);
	});

	it('leaves plain Enter and Shift+Enter to insert a new line', () => {
		for (const isMac of [true, false]) {
			expect(isSendKey(key(), isMac)).toBe(false);
			expect(isSendKey(key({ shiftKey: true }), isMac)).toBe(false);
		}
	});

	it('does not send with the other platform modifier or extra modifiers', () => {
		expect(isSendKey(key({ ctrlKey: true }), true)).toBe(false);
		expect(isSendKey(key({ metaKey: true }), false)).toBe(false);
		expect(isSendKey(key({ metaKey: true, shiftKey: true }), true)).toBe(false);
		expect(isSendKey(key({ metaKey: true, altKey: true }), true)).toBe(false);
		expect(isSendKey(key({ ctrlKey: true, altKey: true }), false)).toBe(false);
	});

	it('never sends while an IME composition is being confirmed', () => {
		expect(isSendKey(key({ metaKey: true, isComposing: true }), true)).toBe(false);
		expect(isSendKey(key({ ctrlKey: true, isComposing: true }), false)).toBe(false);
	});

	it('ignores other keys', () => {
		expect(isSendKey(key({ key: 'a', metaKey: true }), true)).toBe(false);
		expect(isSendKey(key({ key: 'NumpadEnter', ctrlKey: true }), false)).toBe(false);
	});
});

describe('sendShortcutLabel', () => {
	it('names the platform modifier', () => {
		expect(sendShortcutLabel(true)).toBe('Cmd+Enter');
		expect(sendShortcutLabel(false)).toBe('Ctrl+Enter');
	});
});
