import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FetchHttpClient, HttpClient, RequestUrlHttpClient } from '../src/providers/http';
import { OllamaProvider } from '../src/providers/ollama';
import { OpenAIProvider } from '../src/providers/openai';
import { ChatMessage, ProviderError, StreamEvent, ToolDefinition } from '../src/providers/types';
// @ts-expect-error plain JS module
import { startFakeServer } from './fake-server/server.mjs';

interface Fake {
	baseUrl: string;
	requests: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> | null }>;
	close: () => Promise<void>;
}

let fake: Fake;
beforeAll(async () => {
	fake = (await startFakeServer()) as Fake;
});
afterAll(() => fake.close());

const tools: ToolDefinition[] = [
	{ name: 'read_note', description: 'read', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
];

async function collect(it: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
	const out: StreamEvent[] = [];
	for await (const e of it) out.push(e);
	return out;
}

function text(events: StreamEvent[]): string {
	return events.map((e) => (e.type === 'text' ? e.delta : '')).join('');
}

/** Non-streaming client that goes over real HTTP, like Obsidian's requestUrl would. */
function wholeBodyClient(): HttpClient {
	return new RequestUrlHttpClient(async (req) => {
		const res = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body });
		return { status: res.status, headers: {}, text: await res.text() };
	});
}

describe.each([
	['streaming', () => new FetchHttpClient()],
	['non-streaming', wholeBodyClient],
])('OllamaProvider (%s)', (_label, makeClient) => {
	const provider = () => new OllamaProvider(makeClient(), () => ({ baseUrl: fake.baseUrl }));

	it('checks connection and lists models', async () => {
		expect(await provider().checkConnection()).toEqual({ ok: true, detail: 'Ollama 0.0.0-fake' });
		expect((await provider().listModels()).map((m) => m.id)).toEqual(['fake-tools:latest', 'fake-plain:latest']);
	});

	it('streams text and usage', async () => {
		const events = await collect(provider().chat({ model: 'fake-tools', messages: [{ role: 'user', content: 'hello' }] }));
		expect(text(events)).toBe('Hello from the fake model. I can read and edit your notes.');
		expect(events.find((e) => e.type === 'usage')).toEqual({ type: 'usage', usage: { inputTokens: 12, outputTokens: 7 } });
		expect(events.at(-1)).toEqual({ type: 'done', finishReason: 'stop' });
	});

	it('emits tool calls with JSON-encoded arguments and round-trips tool results', async () => {
		const events = await collect(provider().chat({ model: 'fake-tools', messages: [{ role: 'user', content: 'read A.md' }], tools }));
		const call = events.find((e) => e.type === 'tool_call');
		expect(call).toMatchObject({ type: 'tool_call', call: { name: 'read_note', argumentsJson: '{"path":"A.md"}' } });
		expect(events.at(-1)).toEqual({ type: 'done', finishReason: 'tool_calls' });
		const sent = fake.requests.at(-1)!.body!;
		expect((sent['tools'] as unknown[])[0]).toMatchObject({ type: 'function', function: { name: 'read_note' } });

		const history: ChatMessage[] = [
			{ role: 'user', content: 'read A.md' },
			{ role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'read_note', argumentsJson: '{"path":"A.md"}' }] },
			{ role: 'tool', content: '<<<note path="A.md">>>\n# Title line\n<<<end note>>>', toolCallId: 'c1', toolName: 'read_note' },
		];
		const second = await collect(provider().chat({ model: 'fake-tools', messages: history, tools }));
		expect(text(second)).toBe('The note A.md begins with: # Title line');
		const wire = (fake.requests.at(-1)!.body!['messages'] as Array<Record<string, unknown>>);
		expect(wire[1]).toEqual({ role: 'assistant', content: '', tool_calls: [{ function: { name: 'read_note', arguments: { path: 'A.md' } } }] });
		expect(wire[2]).toMatchObject({ role: 'tool', tool_name: 'read_note' });
	});

	it('maps a model without tool support to unsupported_tools', async () => {
		await expect(collect(provider().chat({ model: 'fake-plain', messages: [{ role: 'user', content: 'hello' }], tools }))).rejects.toMatchObject({ kind: 'unsupported_tools' });
		const events = await collect(provider().chat({ model: 'fake-plain', messages: [{ role: 'user', content: 'hello' }] }));
		expect(text(events)).toMatch(/Hello/);
	});

	it('maps rate limits and server errors', async () => {
		await expect(collect(provider().chat({ model: 'fake-429', messages: [] }))).rejects.toMatchObject({ kind: 'rate_limit', status: 429 });
		await expect(collect(provider().chat({ model: 'fake-500', messages: [] }))).rejects.toMatchObject({ kind: 'server', status: 500 });
	});

	it('reports a network error when the server is down', async () => {
		const down = new OllamaProvider(makeClient(), () => ({ baseUrl: 'http://127.0.0.1:1' }));
		const status = await down.checkConnection();
		expect(status.ok).toBe(false);
		if (!status.ok) expect(status.error.kind).toBe('network');
		await expect(collect(down.chat({ model: 'x', messages: [] }))).rejects.toMatchObject({ kind: 'network' });
	});
});

describe('OllamaProvider cancellation', () => {
	it('stops a streaming reply when aborted', async () => {
		const provider = new OllamaProvider(new FetchHttpClient(), () => ({ baseUrl: fake.baseUrl }));
		const ac = new AbortController();
		const seen: StreamEvent[] = [];
		await expect(
			(async () => {
				for await (const e of provider.chat({ model: 'fake-slow', messages: [{ role: 'user', content: 'hello' }], signal: ac.signal })) {
					seen.push(e);
					if (seen.length === 2) ac.abort();
				}
			})(),
		).rejects.toMatchObject({ kind: 'cancelled' });
		expect(seen.length).toBeLessThan(6);
	});
});

describe.each([
	['streaming', () => new FetchHttpClient()],
	['non-streaming', wholeBodyClient],
])('OpenAIProvider (%s)', (_label, makeClient) => {
	const provider = (key: string | null = 'sk-fake') =>
		new OpenAIProvider(makeClient(), () => ({ baseUrl: `${fake.baseUrl}/v1`, apiKey: () => key }));

	it('lists models with the bearer key', async () => {
		expect((await provider().listModels()).map((m) => m.id)).toEqual(['fake-gpt', 'fake-plain']);
		expect(fake.requests.at(-1)!.headers['authorization']).toBe('Bearer sk-fake');
	});

	it('fails fast without a key and maps 401', async () => {
		await expect(provider(null).listModels()).rejects.toMatchObject({ kind: 'auth' });
		const bad = await provider('sk-wrong').checkConnection();
		expect(bad).toMatchObject({ ok: false, error: { kind: 'auth', status: 401 } });
		expect(bad.ok === false && bad.error.message).toBe('Incorrect API key provided');
	});

	it('streams text with usage', async () => {
		const events = await collect(provider().chat({ model: 'fake-gpt', messages: [{ role: 'user', content: 'hello' }] }));
		expect(text(events)).toBe('Hello from the fake model. I can read and edit your notes.');
		expect(events.find((e) => e.type === 'usage')).toEqual({ type: 'usage', usage: { inputTokens: 12, outputTokens: 7 } });
		expect(events.at(-1)).toEqual({ type: 'done', finishReason: 'stop' });
		const sent = fake.requests.at(-1)!.body!;
		if (makeClient().supportsStreaming) expect(sent['stream_options']).toEqual({ include_usage: true });
	});

	it('reassembles tool call argument deltas and round-trips tool results', async () => {
		const events = await collect(provider().chat({ model: 'fake-gpt', messages: [{ role: 'user', content: 'read A.md' }], tools }));
		expect(events.find((e) => e.type === 'tool_call')).toEqual({
			type: 'tool_call',
			call: { id: 'call_fake_1', name: 'read_note', argumentsJson: '{"path":"A.md"}' },
		});
		expect(events.at(-1)).toEqual({ type: 'done', finishReason: 'tool_calls' });

		const history: ChatMessage[] = [
			{ role: 'user', content: 'read A.md' },
			{ role: 'assistant', content: '', toolCalls: [{ id: 'call_fake_1', name: 'read_note', argumentsJson: '{"path":"A.md"}' }] },
			{ role: 'tool', content: '<<<note path="A.md">>>\n# Title line\n<<<end note>>>', toolCallId: 'call_fake_1', toolName: 'read_note' },
		];
		const second = await collect(provider().chat({ model: 'fake-gpt', messages: history, tools }));
		expect(text(second)).toBe('The note A.md begins with: # Title line');
		const wire = fake.requests.at(-1)!.body!['messages'] as Array<Record<string, unknown>>;
		expect(wire[1]).toEqual({ role: 'assistant', content: null, tool_calls: [{ id: 'call_fake_1', type: 'function', function: { name: 'read_note', arguments: '{"path":"A.md"}' } }] });
		expect(wire[2]).toEqual({ role: 'tool', tool_call_id: 'call_fake_1', content: history[2]!.content });
	});

	it('maps rate limits and server errors', async () => {
		await expect(collect(provider().chat({ model: 'fake-429', messages: [] }))).rejects.toMatchObject({ kind: 'rate_limit' });
		const err = await collect(provider().chat({ model: 'fake-500', messages: [] })).catch((e: unknown) => e as ProviderError);
		expect(err).toMatchObject({ kind: 'server', message: 'The server had an error' });
	});

	it('never leaks the key into errors', async () => {
		const err = await provider('sk-wrong').listModels().catch((e: unknown) => e as ProviderError);
		expect(JSON.stringify(err)).not.toContain('sk-wrong');
		expect(err.message).not.toContain('sk-wrong');
	});
});
