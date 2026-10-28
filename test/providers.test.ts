import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FetchHttpClient, HttpClient, RequestUrlHttpClient } from '../src/providers/http';
import { OllamaProvider } from '../src/providers/ollama';
import { OpenAIProvider } from '../src/providers/openai';
import { AnthropicProvider, toAnthropicMessages } from '../src/providers/anthropic';
import { GeminiProvider, toGeminiContents } from '../src/providers/gemini';
import { createProviders } from '../src/providers/registry';
import { mergeSettings } from '../src/settings';
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

describe.each([
	['streaming', () => new FetchHttpClient()],
	['non-streaming', wholeBodyClient],
])('AnthropicProvider (%s)', (_label, makeClient) => {
	const provider = (key: string | null = 'sk-ant-fake') =>
		new AnthropicProvider(makeClient(), () => ({ baseUrl: `${fake.baseUrl}/anthropic/v1`, apiKey: () => key, maxTokens: 1024 }));

	it('lists models with the x-api-key and version headers', async () => {
		expect(await provider().listModels()).toEqual([
			{ id: 'fake-claude', label: 'Fake Claude', contextWindow: 200000 },
			{ id: 'fake-claude-small', label: 'Fake Claude Small' },
		]);
		const headers = fake.requests.at(-1)!.headers;
		expect(headers['x-api-key']).toBe('sk-ant-fake');
		expect(headers['anthropic-version']).toBe('2023-06-01');
		expect(headers['authorization']).toBeUndefined();
		expect(await provider().checkConnection()).toEqual({ ok: true, detail: 'Anthropic reachable (2 models)' });
	});

	it('fails fast without a key and maps 401', async () => {
		await expect(provider(null).listModels()).rejects.toMatchObject({ kind: 'auth' });
		const bad = await provider('sk-ant-wrong').checkConnection();
		expect(bad).toMatchObject({ ok: false, error: { kind: 'auth', status: 401, message: 'invalid x-api-key' } });
	});

	it('streams text, lifts the system prompt, and reports usage including cache tokens', async () => {
		const events = await collect(
			provider().chat({ model: 'fake-claude', messages: [{ role: 'system', content: 'Be brief.' }, { role: 'user', content: 'hello' }] }),
		);
		expect(text(events)).toBe('Hello from the fake model. I can read and edit your notes.');
		expect(events.find((e) => e.type === 'usage')).toEqual({ type: 'usage', usage: { inputTokens: 12, outputTokens: 7 } });
		expect(events.at(-1)).toEqual({ type: 'done', finishReason: 'stop' });
		const sent = fake.requests.at(-1)!.body!;
		expect(sent['system']).toBe('Be brief.');
		expect(sent['max_tokens']).toBe(1024);
		expect(sent['messages']).toEqual([{ role: 'user', content: [{ type: 'text', text: 'hello' }] }]);
	});

	it('reassembles tool_use input deltas and round-trips tool results', async () => {
		const events = await collect(provider().chat({ model: 'fake-claude', messages: [{ role: 'user', content: 'read A.md' }], tools }));
		expect(text(events)).toBe('Let me check. ');
		expect(events.filter((e) => e.type === 'tool_call')).toEqual([
			{ type: 'tool_call', call: { id: 'toolu_fake_1', name: 'read_note', argumentsJson: '{"path":"A.md"}' } },
		]);
		expect(events.at(-1)).toEqual({ type: 'done', finishReason: 'tool_calls' });
		expect((fake.requests.at(-1)!.body!['tools'] as unknown[])[0]).toEqual({
			name: 'read_note',
			description: 'read',
			input_schema: tools[0]!.parameters,
		});

		const history: ChatMessage[] = [
			{ role: 'user', content: 'read A.md' },
			{ role: 'assistant', content: 'Let me check. ', toolCalls: [{ id: 'toolu_fake_1', name: 'read_note', argumentsJson: '{"path":"A.md"}' }] },
			{ role: 'tool', content: '<<<note path="A.md">>>\n# Title line\n<<<end note>>>', toolCallId: 'toolu_fake_1', toolName: 'read_note' },
		];
		const second = await collect(provider().chat({ model: 'fake-claude', messages: history, tools }));
		expect(text(second)).toBe('The note A.md begins with: # Title line');
		const wire = fake.requests.at(-1)!.body!['messages'] as Array<Record<string, unknown>>;
		expect(wire[1]).toEqual({
			role: 'assistant',
			content: [
				{ type: 'text', text: 'Let me check. ' },
				{ type: 'tool_use', id: 'toolu_fake_1', name: 'read_note', input: { path: 'A.md' } },
			],
		});
		expect(wire[2]).toEqual({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_fake_1', content: history[2]!.content }] });
	});

	it('maps rate limits and overload', async () => {
		await expect(collect(provider().chat({ model: 'fake-429', messages: [{ role: 'user', content: 'hi' }] }))).rejects.toMatchObject({ kind: 'rate_limit', status: 429 });
		await expect(collect(provider().chat({ model: 'fake-500', messages: [{ role: 'user', content: 'hi' }] }))).rejects.toMatchObject({ kind: 'server', status: 529, message: 'Overloaded' });
	});

	it('never leaks the key into errors', async () => {
		const err = await provider('sk-ant-wrong').listModels().catch((e: unknown) => e as ProviderError);
		expect(JSON.stringify(err)).not.toContain('sk-ant-wrong');
		expect(err.message).not.toContain('sk-ant-wrong');
	});
});

describe('AnthropicProvider streaming specifics', () => {
	const provider = () =>
		new AnthropicProvider(new FetchHttpClient(), () => ({ baseUrl: `${fake.baseUrl}/anthropic/v1`, apiKey: () => 'sk-ant-fake', maxTokens: 1024 }));

	it('surfaces an error event sent mid-stream', async () => {
		const seen: StreamEvent[] = [];
		await expect(
			(async () => {
				for await (const e of provider().chat({ model: 'fake-overloaded', messages: [{ role: 'user', content: 'hello' }] })) seen.push(e);
			})(),
		).rejects.toMatchObject({ kind: 'server', message: 'Overloaded' });
		expect(text(seen)).toBe('Hello from ');
	});

	it('stops a streaming reply when aborted', async () => {
		const ac = new AbortController();
		const seen: StreamEvent[] = [];
		await expect(
			(async () => {
				for await (const e of provider().chat({ model: 'fake-slow', messages: [{ role: 'user', content: 'hello' }], signal: ac.signal })) {
					seen.push(e);
					if (seen.length === 2) ac.abort();
				}
			})(),
		).rejects.toMatchObject({ kind: 'cancelled' });
		expect(seen.length).toBeLessThan(6);
	});
});

describe('toAnthropicMessages', () => {
	it('merges tool results into one user turn, drops blank text, and sanitizes foreign ids', () => {
		const { system, messages } = toAnthropicMessages([
			{ role: 'system', content: 'sys' },
			{ role: 'user', content: 'do two things' },
			{ role: 'assistant', content: '' }, // a stopped turn with nothing to replay
			{ role: 'assistant', content: '\n\n', toolCalls: [
				{ id: 'call.1', name: 'list_files', argumentsJson: '{}' },
				{ id: 'call.2', name: 'read_note', argumentsJson: 'not json' },
			] },
			{ role: 'tool', content: 'a', toolCallId: 'call.1', toolName: 'list_files' },
			{ role: 'tool', content: 'b', toolCallId: 'call.2', toolName: 'read_note' },
			{ role: 'user', content: 'thanks' },
		], true);
		expect(system).toBe('sys');
		expect(messages).toEqual([
			{ role: 'user', content: [{ type: 'text', text: 'do two things' }] },
			{ role: 'assistant', content: [
				{ type: 'tool_use', id: 'call_1', name: 'list_files', input: {} },
				{ type: 'tool_use', id: 'call_2', name: 'read_note', input: {} },
			] },
			{ role: 'user', content: [
				{ type: 'tool_result', tool_use_id: 'call_1', content: 'a' },
				{ type: 'tool_result', tool_use_id: 'call_2', content: 'b' },
				{ type: 'text', text: 'thanks' },
			] },
		]);
	});
});

describe.each([
	['streaming', () => new FetchHttpClient()],
	['non-streaming', wholeBodyClient],
])('GeminiProvider (%s)', (_label, makeClient) => {
	const provider = (key: string | null = 'gemini-fake') =>
		new GeminiProvider(makeClient(), () => ({ baseUrl: `${fake.baseUrl}/gemini/v1beta`, apiKey: () => key }));

	it('lists only generateContent models, with the key in a header', async () => {
		expect(await provider().listModels()).toEqual([{ id: 'fake-gemini', label: 'Fake Gemini', contextWindow: 1048576 }]);
		const req = fake.requests.at(-1)!;
		expect(req.headers['x-goog-api-key']).toBe('gemini-fake');
		expect(req.url).not.toContain('gemini-fake');
		expect(await provider().checkConnection()).toEqual({ ok: true, detail: 'Gemini reachable (1 model)' });
	});

	it('fails fast without a key and maps the 400 invalid-key response to auth', async () => {
		await expect(provider(null).listModels()).rejects.toMatchObject({ kind: 'auth' });
		const bad = await provider('wrong').checkConnection();
		expect(bad).toMatchObject({ ok: false, error: { kind: 'auth', status: 400, message: 'API key not valid. Please pass a valid API key.' } });
	});

	it('streams text with systemInstruction and usage including thinking tokens', async () => {
		const events = await collect(
			provider().chat({ model: 'fake-gemini', messages: [{ role: 'system', content: 'Be brief.' }, { role: 'user', content: 'hello' }] }),
		);
		expect(text(events)).toBe('Hello from the fake model. I can read and edit your notes.');
		expect(events.filter((e) => e.type === 'usage')).toEqual([{ type: 'usage', usage: { inputTokens: 12, outputTokens: 7 } }]);
		expect(events.at(-1)).toEqual({ type: 'done', finishReason: 'stop' });
		const req = fake.requests.at(-1)!;
		expect(req.url).toBe(
			makeClient().supportsStreaming
				? '/gemini/v1beta/models/fake-gemini:streamGenerateContent?alt=sse'
				: '/gemini/v1beta/models/fake-gemini:generateContent',
		);
		expect(req.body!['systemInstruction']).toEqual({ parts: [{ text: 'Be brief.' }] });
		expect(req.body!['contents']).toEqual([{ role: 'user', parts: [{ text: 'hello' }] }]);
	});

	it('emits function calls with their thought signature and replays both', async () => {
		const strictTools: ToolDefinition[] = [{ ...tools[0]!, parameters: { ...tools[0]!.parameters, additionalProperties: false } }];
		const events = await collect(provider().chat({ model: 'fake-gemini', messages: [{ role: 'user', content: 'read A.md' }], tools: strictTools }));
		const call = events.find((e) => e.type === 'tool_call');
		expect(call).toMatchObject({ type: 'tool_call', call: { name: 'read_note', argumentsJson: '{"path":"A.md"}', signature: 'sig-fake-1' } });
		expect(events.at(-1)).toEqual({ type: 'done', finishReason: 'tool_calls' });
		const decl = ((fake.requests.at(-1)!.body!['tools'] as Array<{ functionDeclarations: unknown[] }>)[0]!.functionDeclarations[0]) as Record<string, unknown>;
		expect(decl['parameters']).toEqual({ type: 'object', properties: { path: { type: 'string' } }, required: ['path'] });

		const toolCall = (call as Extract<StreamEvent, { type: 'tool_call' }>).call;
		const history: ChatMessage[] = [
			{ role: 'user', content: 'read A.md' },
			{ role: 'assistant', content: '', toolCalls: [toolCall] },
			{ role: 'tool', content: '<<<note path="A.md">>>\n# Title line\n<<<end note>>>', toolCallId: toolCall.id, toolName: 'read_note' },
		];
		const second = await collect(provider().chat({ model: 'fake-gemini', messages: history, tools: strictTools }));
		expect(text(second)).toBe('The note A.md begins with: # Title line');
		const wire = fake.requests.at(-1)!.body!['contents'] as Array<Record<string, unknown>>;
		expect(wire[1]).toEqual({ role: 'model', parts: [{ functionCall: { name: 'read_note', args: { path: 'A.md' } }, thoughtSignature: 'sig-fake-1' }] });
		expect(wire[2]).toEqual({ role: 'user', parts: [{ functionResponse: { name: 'read_note', response: { result: history[2]!.content } } }] });
	});

	it('maps rate limits, server errors, missing models and safety stops', async () => {
		const msgs: ChatMessage[] = [{ role: 'user', content: 'hi' }];
		await expect(collect(provider().chat({ model: 'fake-429', messages: msgs }))).rejects.toMatchObject({ kind: 'rate_limit', status: 429 });
		await expect(collect(provider().chat({ model: 'fake-500', messages: msgs }))).rejects.toMatchObject({ kind: 'server', status: 500 });
		await expect(collect(provider().chat({ model: 'fake-missing', messages: msgs }))).rejects.toMatchObject({ kind: 'model_not_found', status: 404 });
		await expect(collect(provider().chat({ model: 'fake-safety', messages: msgs }))).rejects.toMatchObject({ kind: 'invalid_request', message: expect.stringContaining('SAFETY') as unknown });
	});

	it('never leaks the key into errors', async () => {
		const err = await provider('gemini-wrong').listModels().catch((e: unknown) => e as ProviderError);
		expect(JSON.stringify(err)).not.toContain('gemini-wrong');
		expect(err.message).not.toContain('gemini-wrong');
	});
});

describe('GeminiProvider cancellation', () => {
	it('stops a streaming reply when aborted', async () => {
		const provider = new GeminiProvider(new FetchHttpClient(), () => ({ baseUrl: `${fake.baseUrl}/gemini/v1beta`, apiKey: () => 'gemini-fake' }));
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

describe('switching providers mid-conversation', () => {
	// A conversation whose tool calls were made by OpenAI, continued on another provider.
	const history: ChatMessage[] = [
		{ role: 'system', content: 'sys' },
		{ role: 'user', content: 'read A.md' },
		{ role: 'assistant', content: '', toolCalls: [{ id: 'call_fake_1', name: 'read_note', argumentsJson: '{"path":"A.md"}' }] },
		{ role: 'tool', content: '<<<note path="A.md">>>\n# Title line\n<<<end note>>>', toolCallId: 'call_fake_1', toolName: 'read_note' },
		{ role: 'assistant', content: 'The note A.md begins with: # Title line' },
		{ role: 'user', content: 'hello' },
	];

	it('replays OpenAI tool history to Anthropic', async () => {
		const p = new AnthropicProvider(new FetchHttpClient(), () => ({ baseUrl: `${fake.baseUrl}/anthropic/v1`, apiKey: () => 'sk-ant-fake', maxTokens: 1024 }));
		expect(text(await collect(p.chat({ model: 'fake-claude', messages: history, tools })))).toMatch(/^Hello/);
	});

	it('replays tool history to Anthropic as text once vault tools are off', async () => {
		const p = new AnthropicProvider(new FetchHttpClient(), () => ({ baseUrl: `${fake.baseUrl}/anthropic/v1`, apiKey: () => 'sk-ant-fake', maxTokens: 1024 }));
		expect(text(await collect(p.chat({ model: 'fake-claude', messages: history })))).toMatch(/^Hello/);
		const sent = fake.requests.at(-1)!.body as { messages: Array<{ role: string; content: Array<{ type: string; text?: string }> }> };
		expect(sent.messages.flatMap((m) => m.content.map((b) => b.type))).not.toContain('tool_use');
		expect(sent.messages[1]).toEqual({ role: 'assistant', content: [{ type: 'text', text: '[Called tool read_note with {"path":"A.md"}]' }] });
		expect(sent.messages[2]!.content[0]!.text).toContain('[Result of tool read_note]\n<<<note path="A.md">>>');
	});

	it('replays OpenAI tool history to Gemini with the placeholder signature', async () => {
		const p = new GeminiProvider(new FetchHttpClient(), () => ({ baseUrl: `${fake.baseUrl}/gemini/v1beta`, apiKey: () => 'gemini-fake' }));
		expect(text(await collect(p.chat({ model: 'fake-gemini', messages: history, tools })))).toMatch(/^Hello/);
		const { contents } = toGeminiContents(history, true);
		expect(contents[1]!.parts[0]).toMatchObject({ thoughtSignature: 'skip_thought_signature_validator' });
	});

	it('replays tool history to Gemini as text once vault tools are off', async () => {
		const p = new GeminiProvider(new FetchHttpClient(), () => ({ baseUrl: `${fake.baseUrl}/gemini/v1beta`, apiKey: () => 'gemini-fake' }));
		expect(text(await collect(p.chat({ model: 'fake-gemini', messages: history })))).toMatch(/^Hello/);
		const { contents } = toGeminiContents(history, false);
		expect(contents.flatMap((c) => c.parts).every((part) => typeof part['text'] === 'string')).toBe(true);
	});
});

describe('createProviders', () => {
	it('gives every cloud provider only its own key', async () => {
		const settings = mergeSettings({
			openai: { apiKeySecretId: 'oa', baseUrl: `${fake.baseUrl}/v1` },
			anthropic: { apiKeySecretId: 'ant', baseUrl: `${fake.baseUrl}/anthropic/v1` },
			gemini: { apiKeySecretId: 'gem', baseUrl: `${fake.baseUrl}/gemini/v1beta` },
		});
		const secrets: Record<string, string> = { oa: 'sk-fake', ant: 'sk-ant-fake', gem: 'gemini-fake' };
		const providers = createProviders(() => new FetchHttpClient(), () => settings, { getSecret: (id) => secrets[id] ?? null });
		expect(Object.keys(providers).sort()).toEqual(['anthropic', 'gemini', 'ollama', 'openai']);
		for (const id of ['openai', 'anthropic', 'gemini'] as const) {
			expect(await providers[id].checkConnection()).toMatchObject({ ok: true });
			const headers = JSON.stringify(fake.requests.at(-1)!.headers);
			for (const [secretId, key] of Object.entries(secrets)) {
				if (secretId !== settings[id].apiKeySecretId) expect(headers).not.toContain(key);
			}
		}
		settings.anthropic.apiKeySecretId = '';
		await expect(providers.anthropic.listModels()).rejects.toMatchObject({ kind: 'auth' });
	});
});

describe('ProviderError.userMessage', () => {
	it('does not double the period of provider messages', () => {
		expect(new ProviderError('auth', 'API key not valid. Please pass a valid API key.').userMessage()).toBe(
			'Authentication failed: API key not valid. Please pass a valid API key. Check the API key in settings.',
		);
	});
});
