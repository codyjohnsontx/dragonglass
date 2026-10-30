import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FetchHttpClient, HttpClient, RequestUrlHttpClient } from '../src/providers/http';
import { OllamaConfig, OllamaProvider, estimatePromptTokens, promptWasTruncated, splitReasoningTokens } from '../src/providers/ollama';
import { OpenAIProvider } from '../src/providers/openai';
import { AnthropicProvider, toAnthropicMessages } from '../src/providers/anthropic';
import { GeminiProvider } from '../src/providers/gemini';
import { createProviders, isLoopbackUrl } from '../src/providers/registry';
import { CustomSettings, mergeSettings } from '../src/settings';
import { RunEvent, runAgent } from '../src/agent/runtime';
import { ToolRegistry } from '../src/agent/tools';
import { ChatMessage, estimateTokens, estimateTokensCeiling, prefixWithinTokens, ProviderError, StreamEvent, ToolDefinition } from '../src/providers/types';
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

/** One start per call, each before its finished call, so the view can show the tool while its arguments stream. */
function expectStartBeforeCall(events: StreamEvent[], name: string): void {
	const starts = events.filter((e) => e.type === 'tool_call_start');
	expect(starts).toEqual([{ type: 'tool_call_start', name }]);
	expect(events.findIndex((e) => e.type === 'tool_call_start')).toBeLessThan(events.findIndex((e) => e.type === 'tool_call'));
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
	const provider = (overrides: Partial<OllamaConfig> = {}) =>
		new OllamaProvider(makeClient(), () => ({ baseUrl: fake.baseUrl, model: '', numCtx: 16384, think: true, ...overrides }));
	const lastChatBody = () => fake.requests.filter((r) => r.url === '/api/chat').at(-1)!.body!;

	it('checks connection and lists models', async () => {
		expect(await provider().checkConnection()).toEqual({ ok: true, detail: 'Ollama 0.0.0-fake', models: [{ id: 'fake-tools:latest' }, { id: 'fake-plain:latest' }] });
		expect((await provider().listModels()).map((m) => m.id)).toEqual(['fake-tools:latest', 'fake-plain:latest']);
	});

	it('confirms the configured model is installed as part of the connection check', async () => {
		expect(await provider({ model: 'fake-tools:latest' }).checkConnection()).toMatchObject({ ok: true, detail: 'Ollama 0.0.0-fake, model fake-tools:latest installed' });
		// A bare name means the :latest tag, as it does for Ollama itself.
		expect(await provider({ model: 'fake-tools' }).checkConnection()).toMatchObject({ ok: true });
		const missing = await provider({ model: 'nonexistent:latest' }).checkConnection();
		expect(missing).toMatchObject({ ok: false, error: { kind: 'model_not_found' }, models: [{ id: 'fake-tools:latest' }, { id: 'fake-plain:latest' }] });
		if (!missing.ok) {
			expect(missing.error.userMessage()).toBe(
				'Model not found: "nonexistent:latest" is not installed on this server (installed: fake-tools:latest, fake-plain:latest). Pick a different model in settings.',
			);
		}
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
		const down = new OllamaProvider(makeClient(), () => ({ baseUrl: 'http://127.0.0.1:1', model: '', numCtx: 16384, think: true }));
		const status = await down.checkConnection();
		expect(status.ok).toBe(false);
		if (!status.ok) expect(status.error.kind).toBe('network');
		await expect(collect(down.chat({ model: 'x', messages: [] }))).rejects.toMatchObject({ kind: 'network' });
	});

	it('sends the configured context window, capped at what /api/show says the model supports', async () => {
		await collect(provider().chat({ model: 'fake-tools', messages: [{ role: 'user', content: 'hello' }] }));
		expect(lastChatBody()['options']).toEqual({ num_ctx: 16384 });
		expect(await provider().contextWindow('fake-tools')).toBe(16384);

		await collect(provider().chat({ model: 'fake-small', messages: [{ role: 'user', content: 'hello' }] }));
		expect(lastChatBody()['options']).toEqual({ num_ctx: 8192 });
		expect(await provider().contextWindow('fake-small')).toBe(8192);

		await collect(provider({ numCtx: 4096 }).chat({ model: 'fake-small', messages: [{ role: 'user', content: 'hello' }], temperature: 0 }));
		expect(lastChatBody()['options']).toEqual({ num_ctx: 4096, temperature: 0 });
	});

	it('still chats with the configured window when /api/show fails', async () => {
		const p = provider();
		const shows = () => fake.requests.filter((r) => r.url === '/api/show').length;
		const before = shows();
		await collect(p.chat({ model: '', messages: [{ role: 'user', content: 'hello' }] }));
		expect(lastChatBody()['options']).toEqual({ num_ctx: 16384 });
		expect(shows()).toBe(before + 1);
		await collect(p.chat({ model: 'fake-tools', messages: [{ role: 'user', content: 'hello' }] }));
		await collect(p.chat({ model: 'fake-tools', messages: [{ role: 'user', content: 'hello' }] }));
		expect(shows()).toBe(before + 2); // one lookup per model, cached
	});

	it('streams thinking separately from the answer and estimates its share of the output tokens', async () => {
		const events = await collect(provider().chat({ model: 'fake-think', messages: [{ role: 'user', content: 'hello' }] }));
		const thinking = events.filter((e) => e.type === 'thinking').map((e) => (e.type === 'thinking' ? e.delta : '')).join('');
		expect(thinking).toBe('The user greets me. A short friendly reply is enough.');
		expect(text(events)).toBe('Hello from the fake model. I can read and edit your notes.');
		expect(events.findIndex((e) => e.type === 'thinking')).toBeLessThan(events.findIndex((e) => e.type === 'text'));
		const usage = events.find((e) => e.type === 'usage');
		expect(usage).toMatchObject({ type: 'usage', usage: { inputTokens: 12, outputTokens: 21 } });
		const reasoning = usage?.type === 'usage' ? usage.usage.reasoningTokens : undefined;
		expect(reasoning).toBeGreaterThan(0);
		expect(reasoning).toBeLessThan(21);
		expect(lastChatBody()).not.toHaveProperty('think');
	});

	it('turns thinking off only for models that have it', async () => {
		const events = await collect(provider({ think: false }).chat({ model: 'fake-think', messages: [{ role: 'user', content: 'hello' }] }));
		expect(events.some((e) => e.type === 'thinking')).toBe(false);
		expect(text(events)).toMatch(/Hello/);
		expect(lastChatBody()['think']).toBe(false);
		expect(events.find((e) => e.type === 'usage')).toEqual({ type: 'usage', usage: { inputTokens: 12, outputTokens: 7, reasoningTokens: undefined } });

		await collect(provider({ think: false }).chat({ model: 'fake-tools', messages: [{ role: 'user', content: 'hello' }] }));
		expect(lastChatBody()).not.toHaveProperty('think');
	});

	it('replays thinking on the assistant turns of the current user turn only', async () => {
		const call = { id: 'c1', name: 'read_note', argumentsJson: '{"path":"A.md"}' };
		await collect(
			provider().chat({
				model: 'fake-think',
				messages: [
					{ role: 'user', content: 'first' },
					{ role: 'assistant', content: 'old answer', thinking: 'old plan' },
					{ role: 'user', content: 'second' },
					{ role: 'assistant', content: '', thinking: 'read A, then answer', toolCalls: [call] },
					{ role: 'tool', content: 'A body', toolCallId: 'c1', toolName: 'read_note' },
				],
				tools,
			}),
		);
		const sent = lastChatBody()['messages'] as Array<Record<string, unknown>>;
		expect(sent[1]).toEqual({ role: 'assistant', content: 'old answer' });
		expect(sent[3]).toMatchObject({ role: 'assistant', thinking: 'read A, then answer' });
		expect(sent[3]?.['tool_calls']).toEqual([{ function: { name: 'read_note', arguments: { path: 'A.md' } } }]);
	});

	it('warns when the prompt count says Ollama cut the prompt', async () => {
		const long = 'word '.repeat(6000); // ~7,500 tokens by the estimate, well over a 4096 window
		const events = await collect(provider({ numCtx: 4096 }).chat({ model: 'fake-truncate', messages: [{ role: 'user', content: long }] }));
		const warning = events.find((e) => e.type === 'warning');
		expect(warning).toBeDefined();
		if (warning?.type === 'warning') {
			expect(warning.message).toMatch(/did not fit Ollama's 4,096-token context window/);
			expect(warning.message).toMatch(/2,048 reached the model/);
		}
		expect(events.at(-1)).toEqual({ type: 'done', finishReason: 'stop' });

		// A short prompt with the same reported count is not a truncation: the window was not full.
		const ok = await collect(provider({ numCtx: 4096 }).chat({ model: 'fake-truncate', messages: [{ role: 'user', content: 'hello' }] }));
		expect(ok.some((e) => e.type === 'warning')).toBe(false);
		// A prompt that fits the window with a count that is not near half of it: dense text, not a cut.
		const normal = await collect(provider({ numCtx: 16384 }).chat({ model: 'fake-tools', messages: [{ role: 'user', content: long }] }));
		expect(normal.some((e) => e.type === 'warning')).toBe(false);
	});
});

describe('Ollama context accounting', () => {
	it('estimates prompt tokens from characters and framing, counting whitespace runs once', () => {
		expect(estimatePromptTokens([{ role: 'user', content: 'x'.repeat(400) }], undefined)).toBe(104);
		expect(estimatePromptTokens([{ role: 'user', content: 'x'.repeat(400) + '\n\t   '.repeat(100) }], undefined)).toBe(105);
		expect(estimatePromptTokens([{ role: 'user', content: '' }], tools)).toBeGreaterThan(4);
		// Replayed thinking is part of the prompt.
		expect(estimatePromptTokens([{ role: 'assistant', content: '', thinking: 'x'.repeat(400) }], undefined)).toBe(104);
		// CJK counts about one token per character; other scripts about two characters per token.
		expect(estimatePromptTokens([{ role: 'user', content: '秘密'.repeat(200) }], undefined)).toBe(404);
		expect(estimatePromptTokens([{ role: 'user', content: 'слово'.repeat(80) }], undefined)).toBe(204);
	});

	it('flags both ways Ollama cuts a prompt, and nothing else', () => {
		// One oversized message: 4096 window, 5078-token prompt, 2050 arrived (the live test's case).
		expect(promptWasTruncated(2050, 5078, 4096)).toBe(true);
		// Older messages dropped: a 7,500-token history came back as 1,134 tokens.
		expect(promptWasTruncated(1134, 7500, 4096)).toBe(true);
		// Same count, small estimate: dense text, not truncation.
		expect(promptWasTruncated(2050, 2400, 4096)).toBe(false);
		expect(promptWasTruncated(1134, 1200, 4096)).toBe(false);
		// A count well above half the window with an estimate that fits means nothing was cut.
		expect(promptWasTruncated(2775, 3000, 4096)).toBe(false);
		// A 30,000-character Japanese note cut to half of a 16k window.
		const cjk = estimatePromptTokens([{ role: 'user', content: '秘密の言葉はペリカンです'.repeat(2500) }], undefined);
		expect(promptWasTruncated(8192, cjk, 16_384)).toBe(true);
		// Ollama 0.40 leaves exactly half the window plus two tokens after cutting one oversized message.
		// A Japanese note trimmed to the 8192-token budget by the estimate, beside 1,300 tokens of framing,
		// overflowed a 16k window on a tokenizer that spends more per character than the estimate
		// assumes: the count sits in the band, and the ceiling estimate says it could have overflowed.
		const trimmed: ChatMessage[] = [
			{ role: 'system', content: 'x'.repeat(5200) },
			{ role: 'user', content: '秘密の言葉はペリカンです'.repeat(683) },
		];
		const likely = estimatePromptTokens(trimmed, undefined);
		const ceiling = estimatePromptTokens(trimmed, undefined, estimateTokensCeiling);
		expect(likely).toBeLessThan(16_384);
		expect(ceiling).toBeGreaterThan(16_384);
		expect(promptWasTruncated(8194, likely, 16_384)).toBe(false); // the estimate alone misses it
		expect(promptWasTruncated(8194, likely, 16_384, ceiling)).toBe(true);
		expect(promptWasTruncated(8192, likely, 16_384, ceiling)).toBe(true);
		expect(promptWasTruncated(8208, likely, 16_384, ceiling)).toBe(true);
		// Outside the band the count is just what a dense tokenizer produced.
		expect(promptWasTruncated(8191, likely, 16_384, ceiling)).toBe(false);
		expect(promptWasTruncated(8300, likely, 16_384, ceiling)).toBe(false);
		// The same count on an ASCII prompt the estimate puts well under the window is a coincidence, not a cut.
		const ascii = estimatePromptTokens([{ role: 'user', content: 'word '.repeat(6400) }], undefined);
		expect(promptWasTruncated(8194, ascii, 16_384, estimatePromptTokens([{ role: 'user', content: 'word '.repeat(6400) }], undefined, estimateTokensCeiling))).toBe(false);
		// An 8,000-character Russian note beside 3,500 tokens of ASCII framing arrives whole (about 6,200 tokens).
		const russian = estimatePromptTokens(
			[
				{ role: 'system', content: 'x'.repeat(14_000) },
				{ role: 'user', content: 'Привет'.repeat(1333) },
			],
			undefined,
		);
		expect(promptWasTruncated(6200, russian, 16_384)).toBe(false);
		// Tiny prompts never count, however far off the estimate is.
		expect(promptWasTruncated(100, 500, 4096)).toBe(false);
	});

	it('bounds what any tokenizer could spend, one token per UTF-8 byte outside ASCII', () => {
		expect(estimateTokensCeiling('x'.repeat(400))).toBe(100);
		expect(estimateTokensCeiling('秘密'.repeat(200))).toBe(1200);
		expect(estimateTokensCeiling('слово'.repeat(80))).toBe(800);
		expect(estimateTokensCeiling('a  \n\n b')).toBe(estimateTokens('a  \n\n b'));
	});

	it('keeps a text within the token cap its own estimate gives it', () => {
		for (const text of ['word \n\t  '.repeat(500), '秘密の言葉　　はペリカン'.repeat(100), 'plain prose with  double  spaces']) {
			expect(prefixWithinTokens(text, estimateTokens(text))).toBe(text.length);
			expect(prefixWithinTokens(text, estimateTokens(text) - 2)).toBeLessThan(text.length);
		}
	});

	it('splits output tokens between thinking and answer by character share', () => {
		expect(splitReasoningTokens(181, 900, 100)).toBe(163);
		expect(splitReasoningTokens(181, 0, 100)).toBeUndefined();
		expect(splitReasoningTokens(undefined, 900, 100)).toBeUndefined();
		expect(splitReasoningTokens(10, 500, 0)).toBe(10);
	});
});

describe('OllamaProvider cancellation', () => {
	it('stops a streaming reply when aborted', async () => {
		const provider = new OllamaProvider(new FetchHttpClient(), () => ({ baseUrl: fake.baseUrl, model: '', numCtx: 16384, think: true }));
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

	it('lists every model with the bearer key', async () => {
		expect((await provider().listModels()).map((m) => m.id)).toEqual(['fake-gpt', 'fake-plain', 'gpt-image-1', 'gpt-realtime', 'omni-moderation-latest', 'text-embedding-3-small', 'tts-1', 'whisper-1']);
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
		if (_label === 'streaming') expectStartBeforeCall(events, 'read_note');
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

	it('sends reasoning_effort none with tools only for GPT-6 Luna and Sol', async () => {
		const sent = () => fake.requests.filter((r) => r.url === '/v1/chat/completions').at(-1)!.body!;
		await collect(provider().chat({ model: 'gpt-6-luna', messages: [{ role: 'user', content: 'hello' }], tools }));
		expect(sent()['reasoning_effort']).toBe('none');
		await collect(provider().chat({ model: 'gpt-6-luna', messages: [{ role: 'user', content: 'hello' }] }));
		expect(sent()).not.toHaveProperty('reasoning_effort');
		await collect(provider().chat({ model: 'gpt-6-sol', messages: [{ role: 'user', content: 'hello' }], tools }));
		expect(sent()['reasoning_effort']).toBe('none');
		await collect(provider().chat({ model: 'gpt-6-sol', messages: [{ role: 'user', content: 'hello' }] }));
		expect(sent()).not.toHaveProperty('reasoning_effort');
		await collect(provider().chat({ model: 'gpt-6-astra', messages: [{ role: 'user', content: 'hello' }], tools }));
		expect(sent()).not.toHaveProperty('reasoning_effort');
	});

	it('explains that a Responses-only model cannot take tools over Chat Completions', async () => {
		const err = await collect(provider().chat({ model: 'gpt-6.1-sol', messages: [{ role: 'user', content: 'read A.md' }], tools })).catch((e: unknown) => e as ProviderError);
		expect(err).toMatchObject({ kind: 'unsupported_tools', status: 400 });
		expect(err.userMessage()).toBe(
			"This model does not support tool calling: gpt-6.1-sol takes tools only through OpenAI's newer Responses API, which Dragonglass does not support yet. Choose a tool-capable model, or ask a question that needs no vault access.",
		);
		const events = await collect(provider().chat({ model: 'gpt-6.1-sol', messages: [{ role: 'user', content: 'hello' }] }));
		expect(text(events)).toMatch(/Hello/);
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
])('custom OpenAI-compatible endpoint (%s)', (_label, makeClient) => {
	const secrets: Record<string, string> = { cu: 'custom-fake', oa: 'sk-fake' };
	const setup = (custom: Partial<CustomSettings>) => {
		const settings = mergeSettings({ openai: { apiKeySecretId: 'oa' }, custom: { apiKeySecretId: 'cu', model: 'local-model', ...custom } });
		const providers = createProviders(() => makeClient(), () => settings, { getSecret: (id) => secrets[id] ?? null });
		return { settings, provider: providers.custom };
	};
	const lastHeaders = () => fake.requests.at(-1)!.headers;

	it('talks to a local server with no authentication and never sends the key', async () => {
		const { provider } = setup({ baseUrl: `${fake.baseUrl}/local/v1`, auth: 'none' });
		expect(provider.id).toBe('custom');
		expect(await provider.checkConnection()).toMatchObject({ ok: true, detail: 'Custom reachable (1 model)' });
		expect(lastHeaders()['authorization']).toBeUndefined();
		expect(JSON.stringify(lastHeaders())).not.toContain('custom-fake');
		expect(provider.capabilities).toMatchObject({ remote: false, billed: false });
		const events = await collect(provider.chat({ model: 'local-model', messages: [{ role: 'user', content: 'hello' }] }));
		expect(text(events)).toBe('Hello from the fake model. I can read and edit your notes.');
		expect(events.at(-1)).toEqual({ type: 'done', finishReason: 'stop' });
	});

	it('maps a server that rejects tools to unsupported_tools, and the agent retries without them', async () => {
		const { provider } = setup({ baseUrl: `${fake.baseUrl}/local/v1`, auth: 'none' });
		const err = await collect(provider.chat({ model: 'local-model', messages: [{ role: 'user', content: 'read A.md' }], tools })).catch((e: unknown) => e as ProviderError);
		expect(err).toMatchObject({ kind: 'unsupported_tools', message: 'tools param requires --jinja flag' });

		const registry = new ToolRegistry().register({ ...tools[0]!, readOnly: true, execute: () => Promise.resolve({ content: '' }) });
		const run: RunEvent[] = [];
		for await (const ev of runAgent({
			provider,
			model: 'local-model',
			system: () => 'sys',
			messages: [{ role: 'user', content: 'read A.md' }],
			tools: registry,
			toolsEnabled: true,
			conversationId: 'c',
			signal: new AbortController().signal,
			maxIterations: 3,
		})) {
			run.push(ev);
		}
		expect(run.some((e) => e.type === 'tools_disabled')).toBe(true);
		expect(run.find((e) => e.type === 'assistant_end')).toMatchObject({ content: 'I cannot read A.md without tools.' });
	});

	it('sends no tools when tool calling is turned off', async () => {
		const { provider } = setup({ baseUrl: `${fake.baseUrl}/local/v1`, auth: 'none', toolCalling: false });
		expect(provider.capabilities.toolCalling).toBe(false);
		const events = await collect(provider.chat({ model: 'local-model', messages: [{ role: 'user', content: 'read A.md' }], tools }));
		expect(text(events)).toBe('I cannot read A.md without tools.');
		expect(fake.requests.at(-1)!.body!['tools']).toBeUndefined();
	});

	it('asks for a whole reply when streaming is turned off', async () => {
		const { provider } = setup({ baseUrl: `${fake.baseUrl}/local/v1`, auth: 'none', streaming: false });
		expect(provider.capabilities.streaming).toBe(false);
		const events = await collect(provider.chat({ model: 'local-model', messages: [{ role: 'user', content: 'hello' }] }));
		expect(text(events)).toBe('Hello from the fake model. I can read and edit your notes.');
		expect(events.find((e) => e.type === 'usage')).toEqual({ type: 'usage', usage: { inputTokens: 12, outputTokens: 7 } });
		expect(fake.requests.at(-1)!.body!['stream']).toBe(false);
		expect(fake.requests.at(-1)!.body!['stream_options']).toBeUndefined();
	});

	it('sends the bare key in a custom header, and only its own key', async () => {
		const { provider, settings } = setup({ baseUrl: `${fake.baseUrl}/keyed/v1`, auth: 'header', authHeader: 'api-key' });
		expect(await provider.checkConnection()).toMatchObject({ ok: true });
		expect(lastHeaders()['api-key']).toBe('custom-fake');
		expect(lastHeaders()['authorization']).toBeUndefined();
		expect(JSON.stringify(lastHeaders())).not.toContain('sk-fake');
		expect(provider.capabilities).toMatchObject({ remote: false, billed: false });

		settings.custom.authHeader = 'x-api-key';
		expect(await provider.checkConnection()).toMatchObject({ ok: false, error: { kind: 'auth', status: 401 } });
		settings.custom.authHeader = ' ';
		await expect(provider.listModels()).rejects.toMatchObject({ kind: 'auth', message: 'No auth header name configured' });
		settings.custom.authHeader = 'api-key';
		settings.custom.apiKeySecretId = '';
		await expect(provider.listModels()).rejects.toMatchObject({ kind: 'auth', message: 'No API key configured' });
	});

	it('defaults to a bearer token', async () => {
		const { provider } = setup({ baseUrl: `${fake.baseUrl}/v1`, apiKeySecretId: 'oa' });
		expect(await provider.checkConnection()).toMatchObject({ ok: true });
		expect(lastHeaders()['authorization']).toBe('Bearer sk-fake');
	});

	it('reports a missing base URL instead of requesting a relative one', async () => {
		const { provider } = setup({ baseUrl: '  ' });
		expect(await provider.checkConnection()).toMatchObject({ ok: false, error: { kind: 'invalid_request', message: 'No server URL configured' } });
		await expect(collect(provider.chat({ model: 'm', messages: [] }))).rejects.toMatchObject({ kind: 'invalid_request' });
	});
});

describe('isLoopbackUrl', () => {
	it('treats only this machine as local', () => {
		for (const url of ['http://localhost:1234/v1', 'http://127.0.0.1:8080/v1', 'http://127.1.2.3/v1', 'http://[::1]:8000/v1']) {
			expect(isLoopbackUrl(url)).toBe(true);
		}
		for (const url of ['https://openrouter.ai/api/v1', 'http://192.168.1.5:8000/v1', 'http://localhost.example.com/v1', '', 'not a url']) {
			expect(isLoopbackUrl(url)).toBe(false);
		}
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
		expect(await provider().checkConnection()).toMatchObject({ ok: true, detail: 'Anthropic reachable (2 models)' });
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
		if (_label === 'streaming') expectStartBeforeCall(events, 'read_note');
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

	it('lists generateContent models, with the key in a header', async () => {
		expect(await provider().listModels()).toEqual([
			{ id: 'fake-gemini', label: 'Fake Gemini', contextWindow: 1048576 },
			{ id: 'fake-gemini-tts', label: 'Fake Gemini TTS' },
		]);
		const req = fake.requests.at(-1)!;
		expect(req.headers['x-goog-api-key']).toBe('gemini-fake');
		expect(req.url).not.toContain('gemini-fake');
		expect(await provider().checkConnection()).toMatchObject({ ok: true, detail: 'Gemini reachable (2 models)' });
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
		expectStartBeforeCall(events, 'read_note'); // Gemini sends calls whole, so both modes announce the start
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
		const sent = fake.requests.at(-1)!.body as { contents: Array<{ role: string; parts: Array<Record<string, unknown>> }> };
		expect(sent.contents[1]).toEqual({ role: 'model', parts: [
			{ functionCall: { name: 'read_note', args: { path: 'A.md' } }, thoughtSignature: 'skip_thought_signature_validator' },
		] });
		expect(sent.contents[2]!.parts[0]).toEqual({
			functionResponse: { name: 'read_note', response: { result: '<<<note path="A.md">>>\n# Title line\n<<<end note>>>' } },
		});
	});

	it('replays tool history to Gemini as text once vault tools are off', async () => {
		const p = new GeminiProvider(new FetchHttpClient(), () => ({ baseUrl: `${fake.baseUrl}/gemini/v1beta`, apiKey: () => 'gemini-fake' }));
		expect(text(await collect(p.chat({ model: 'fake-gemini', messages: history })))).toMatch(/^Hello/);
		const sent = fake.requests.at(-1)!.body as { contents: Array<{ role: string; parts: Array<Record<string, unknown>> }> };
		expect(sent.contents.flatMap((c) => c.parts).every((part) => typeof part['text'] === 'string')).toBe(true);
		expect(sent.contents[1]).toEqual({ role: 'model', parts: [{ text: '[Called tool read_note with {"path":"A.md"}]' }] });
		expect(sent.contents[2]!.parts[0]!['text']).toContain('[Result of tool read_note]\n<<<note path="A.md">>>');
	});
});

describe('createProviders', () => {
	it('gives every cloud provider only its own key', async () => {
		const settings = mergeSettings({
			openai: { apiKeySecretId: 'oa', baseUrl: `${fake.baseUrl}/v1` },
			anthropic: { apiKeySecretId: 'ant', baseUrl: `${fake.baseUrl}/anthropic/v1` },
			gemini: { apiKeySecretId: 'gem', baseUrl: `${fake.baseUrl}/gemini/v1beta` },
			custom: { apiKeySecretId: 'cu', baseUrl: `${fake.baseUrl}/keyed/v1`, auth: 'header', authHeader: 'api-key' },
		});
		const secrets: Record<string, string> = { oa: 'sk-fake', ant: 'sk-ant-fake', gem: 'gemini-fake', cu: 'custom-fake' };
		const providers = createProviders(() => new FetchHttpClient(), () => settings, { getSecret: (id) => secrets[id] ?? null });
		expect(Object.keys(providers).sort()).toEqual(['anthropic', 'custom', 'gemini', 'ollama', 'openai']);
		for (const id of ['openai', 'anthropic', 'gemini', 'custom'] as const) {
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
