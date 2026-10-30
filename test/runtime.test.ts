import { describe, expect, it } from 'vitest';
import { RunEvent, runAgent } from '../src/agent/runtime';
import { AgentTool, ToolRegistry } from '../src/agent/tools';
import { ChatRequest, Provider, ProviderError, StreamEvent } from '../src/providers/types';

/** Scripted provider: each call pops the next event list; records requests. */
function scripted(turns: StreamEvent[][], opts: Partial<Provider['capabilities']> = {}): Provider & { requests: ChatRequest[] } {
	const requests: ChatRequest[] = [];
	return {
		id: 'ollama',
		displayName: 'Scripted',
		capabilities: { streaming: true, toolCalling: true, usageReporting: true, modelDiscovery: false, billed: false, remote: false, ...opts },
		requests,
		listModels: () => Promise.resolve([]),
		checkConnection: () => Promise.resolve({ ok: true, detail: 'ok', models: [] }),
		async *chat(req) {
			requests.push(req);
			const turn = turns.shift();
			if (!turn) throw new ProviderError('server', 'no scripted turn');
			for (const ev of turn) {
				if (req.signal?.aborted) throw new ProviderError('cancelled', 'Generation stopped.');
				yield ev;
			}
		},
	};
}

const echoTool: AgentTool = {
	name: 'echo',
	description: 'echo',
	readOnly: true,
	parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
	execute: (args) => Promise.resolve({ content: `echo:${String(args['text'])}` }),
};

async function collect(events: AsyncIterable<RunEvent>): Promise<RunEvent[]> {
	const out: RunEvent[] = [];
	for await (const e of events) out.push(e);
	return out;
}

function run(provider: Provider, overrides: Partial<Parameters<typeof runAgent>[0]> = {}) {
	const tools = new ToolRegistry().register(echoTool);
	return runAgent({
		provider,
		model: 'm',
		system: (toolsEnabled) => (toolsEnabled ? 'sys:tools' : 'sys:no-tools'),
		messages: [{ role: 'user', content: 'hi' }],
		tools,
		toolsEnabled: true,
		conversationId: 'c',
		signal: new AbortController().signal,
		maxIterations: 3,
		...overrides,
	});
}

describe('runAgent', () => {
	it('streams a plain answer', async () => {
		const p = scripted([[{ type: 'text', delta: 'Hel' }, { type: 'text', delta: 'lo' }, { type: 'usage', usage: { inputTokens: 1, outputTokens: 2 } }, { type: 'done', finishReason: 'stop' }]]);
		const events = await collect(run(p));
		expect(events.map((e) => e.type)).toEqual(['assistant_start', 'text_delta', 'text_delta', 'assistant_end']);
		const end = events[3] as Extract<RunEvent, { type: 'assistant_end' }>;
		expect(end.content).toBe('Hello');
		expect(end.usage).toEqual({ inputTokens: 1, outputTokens: 2 });
		expect(p.requests[0]?.tools?.map((t) => t.name)).toEqual(['echo']);
	});

	it('passes thinking and warnings through and keeps both on the finished turn', async () => {
		const p = scripted([
			[
				{ type: 'thinking', delta: 'hmm ' },
				{ type: 'thinking', delta: 'ok' },
				{ type: 'text', delta: 'Hi' },
				{ type: 'warning', message: 'prompt was cut' },
				{ type: 'usage', usage: { inputTokens: 2050, outputTokens: 20, reasoningTokens: 15 } },
				{ type: 'done', finishReason: 'stop' },
			],
		]);
		const events = await collect(run(p));
		expect(events.map((e) => e.type)).toEqual(['assistant_start', 'thinking_delta', 'thinking_delta', 'text_delta', 'warning', 'assistant_end']);
		const end = events.at(-1) as Extract<RunEvent, { type: 'assistant_end' }>;
		expect(end).toMatchObject({ content: 'Hi', thinking: 'hmm ok', warnings: ['prompt was cut'], usage: { reasoningTokens: 15 } });
		// Thinking is shown to the user but never replayed to the model.
		const added: unknown[] = [];
		await collect(run(scripted([[{ type: 'thinking', delta: 'x' }, { type: 'done', finishReason: 'stop' }]]), { onMessages: (m) => added.push(...m) }));
		expect(added).toEqual([{ role: 'assistant', content: '', toolCalls: undefined }]);
	});

	it('executes tool calls and feeds results back', async () => {
		const p = scripted([
			[{ type: 'tool_call', call: { id: 'c1', name: 'echo', argumentsJson: '{"text":"x"}' } }, { type: 'done', finishReason: 'tool_calls' }],
			[{ type: 'text', delta: 'done' }, { type: 'done', finishReason: 'stop' }],
		]);
		const added: unknown[] = [];
		const events = await collect(run(p, { onMessages: (m) => added.push(...m) }));
		expect(events.map((e) => e.type)).toEqual(['assistant_start', 'tool_call_start', 'assistant_end', 'tool_call', 'tool_result', 'assistant_start', 'text_delta', 'assistant_end']);
		const result = events[4] as Extract<RunEvent, { type: 'tool_result' }>;
		expect(result.result.content).toBe('echo:x');
		const second = p.requests[1]!;
		expect(second.messages.at(-1)).toEqual({ role: 'tool', content: 'echo:x', toolCallId: 'c1', toolName: 'echo' });
		expect(second.messages.at(-2)?.toolCalls?.[0]?.name).toBe('echo');
		expect(added).toHaveLength(3);
	});

	it('announces each tool call as it starts, synthesizing the start for providers that report only finished calls', async () => {
		const call = { id: 'c1', name: 'echo', argumentsJson: '{"text":"a"}' };
		const streamed = scripted([
			[{ type: 'tool_call_start', name: 'echo' }, { type: 'tool_call', call }, { type: 'done', finishReason: 'tool_calls' }],
			[{ type: 'text', delta: 'done' }, { type: 'done', finishReason: 'stop' }],
		]);
		const events = (await collect(run(streamed))).map((e) => e.type);
		expect(events).toEqual(['assistant_start', 'tool_call_start', 'assistant_end', 'tool_call', 'tool_result', 'assistant_start', 'text_delta', 'assistant_end']);

		const whole = scripted([
			[{ type: 'tool_call', call }, { type: 'tool_call', call: { ...call, id: 'c2', argumentsJson: '{"text":"b"}' } }, { type: 'done', finishReason: 'tool_calls' }],
			[{ type: 'text', delta: 'done' }, { type: 'done', finishReason: 'stop' }],
		]);
		const synthesized = await collect(run(whole));
		expect(synthesized.filter((e) => e.type === 'tool_call_start')).toEqual([
			{ type: 'tool_call_start', name: 'echo' },
			{ type: 'tool_call_start', name: 'echo' },
		]);
		expect(synthesized.map((e) => e.type).slice(0, 4)).toEqual(['assistant_start', 'tool_call_start', 'tool_call_start', 'assistant_end']);
	});

	it('reports unknown tools and invalid arguments to the model instead of crashing', async () => {
		const p = scripted([
			[
				{ type: 'tool_call', call: { id: 'c1', name: 'nope', argumentsJson: '{}' } },
				{ type: 'tool_call', call: { id: 'c2', name: 'echo', argumentsJson: '{"wrong":1}' } },
				{ type: 'done', finishReason: 'tool_calls' },
			],
			[{ type: 'text', delta: 'ok' }, { type: 'done', finishReason: 'stop' }],
		]);
		const events = await collect(run(p));
		const results = events.filter((e): e is Extract<RunEvent, { type: 'tool_result' }> => e.type === 'tool_result');
		expect(results[0]?.result.content).toMatch(/unknown tool "nope"/);
		expect(results[1]?.result.content).toMatch(/missing required "text"/);
		expect(results.every((r) => r.result.isError)).toBe(true);
	});

	it('stops at the iteration cap', async () => {
		const loop: StreamEvent[] = [{ type: 'tool_call', call: { id: 'c', name: 'echo', argumentsJson: '{"text":"x"}' } }, { type: 'done', finishReason: 'tool_calls' }];
		const p = scripted([loop, loop, loop, loop]);
		const events = await collect(run(p, { maxIterations: 2 }));
		const last = events.at(-1) as Extract<RunEvent, { type: 'error' }>;
		expect(last.type).toBe('error');
		expect(last.error.message).toMatch(/Stopped after 2 tool rounds/);
		expect(p.requests).toHaveLength(2);
	});

	it('retries once without tools when the model rejects them', async () => {
		const p = scripted([[{ type: 'text', delta: 'plain' }, { type: 'done', finishReason: 'stop' }]]);
		const failing: Provider = {
			...p,
			async *chat(req) {
				if (req.tools) throw new ProviderError('unsupported_tools', 'model does not support tools');
				yield* p.chat(req);
			},
		};
		const events = await collect(run(failing));
		expect(events.map((e) => e.type)).toEqual(['assistant_start', 'tools_disabled', 'assistant_start', 'text_delta', 'assistant_end']);
		expect(p.requests[0]?.messages[0]).toEqual({ role: 'system', content: 'sys:no-tools' });
	});

	it('omits tools when disabled or unsupported by the provider', async () => {
		const p = scripted([[{ type: 'done', finishReason: 'stop' }]], { toolCalling: false });
		await collect(run(p));
		expect(p.requests[0]?.tools).toBeUndefined();
		expect(p.requests[0]?.messages[0]).toEqual({ role: 'system', content: 'sys:no-tools' });
		const q = scripted([[{ type: 'done', finishReason: 'stop' }]]);
		await collect(run(q, { toolsEnabled: false }));
		expect(q.requests[0]?.tools).toBeUndefined();
		expect(q.requests[0]?.messages[0]).toEqual({ role: 'system', content: 'sys:no-tools' });
		const r = scripted([[{ type: 'done', finishReason: 'stop' }]]);
		await collect(run(r));
		expect(r.requests[0]?.messages).toEqual([{ role: 'system', content: 'sys:tools' }, { role: 'user', content: 'hi' }]);
	});

	it('surfaces provider errors and cancellation', async () => {
		const p = scripted([]);
		const events = await collect(run(p));
		expect(events.at(-1)).toMatchObject({ type: 'error', error: { kind: 'server' } });

		const ac = new AbortController();
		const q = scripted([[{ type: 'text', delta: 'partial ' }, { type: 'text', delta: 'never' }]]);
		const out: RunEvent[] = [];
		for await (const e of run(q, { signal: ac.signal })) {
			out.push(e);
			if (e.type === 'text_delta') ac.abort();
		}
		expect(out.map((e) => e.type)).toEqual(['assistant_start', 'text_delta', 'assistant_end', 'error']);
		expect((out.at(-1) as Extract<RunEvent, { type: 'error' }>).error.kind).toBe('cancelled');
		expect((out[2] as Extract<RunEvent, { type: 'assistant_end' }>).content).toBe('partial ');
	});

	it('answers every requested tool call when stopped mid-round', async () => {
		const ac = new AbortController();
		const p = scripted([
			[
				{ type: 'tool_call', call: { id: 'a', name: 'echo', argumentsJson: '{"text":"1"}' } },
				{ type: 'tool_call', call: { id: 'b', name: 'echo', argumentsJson: '{"text":"2"}' } },
				{ type: 'done', finishReason: 'tool_calls' },
			],
		]);
		const added: { role: string; toolCallId?: string; content: string }[] = [];
		const out: RunEvent[] = [];
		for await (const e of run(p, { signal: ac.signal, onMessages: (m) => added.push(...m) })) {
			out.push(e);
			if (e.type === 'tool_result') ac.abort();
		}
		expect(out.map((e) => e.type)).toEqual(['assistant_start', 'tool_call_start', 'tool_call_start', 'assistant_end', 'tool_call', 'tool_result', 'tool_result', 'error']);
		const tools = added.filter((m) => m.role === 'tool');
		expect(tools.map((m) => m.toolCallId)).toEqual(['a', 'b']);
		expect(tools[1]?.content).toMatch(/Not run: generation stopped/);
	});
});
