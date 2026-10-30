import { describe, expect, it } from 'vitest';
import { StoredMessage } from '../src/persistence/conversation';
import { copyToClipboard, messageClipboardText } from '../src/ui/copy';

function assistant(overrides: Partial<StoredMessage>): StoredMessage {
	return { id: 'a1', role: 'assistant', content: '', createdAt: 0, ...overrides };
}

describe('messageClipboardText', () => {
	it('copies the reply Markdown as written', () => {
		const m = assistant({ content: '# Plan\n\n- one\n- two\n\n```js\nconsole.log(1)\n```' });
		expect(messageClipboardText(m)).toBe(m.content);
	});

	it('leaves out thinking, tool calls, warnings and errors', () => {
		const m = assistant({
			content: 'The answer.',
			thinking: 'Let me think about this at length…',
			toolCalls: [{ id: 't1', name: 'read_note', argumentsJson: '{"path":"Welcome.md"}' }],
			warnings: ['Prompt was cut to fit the context window.'],
			error: 'Stopped early.',
			model: 'qwen3:8b',
		});
		expect(messageClipboardText(m)).toBe('The answer.');
	});
});

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
