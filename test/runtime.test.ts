import { describe, expect, it } from 'vitest';
import { FINAL_ANSWER_INSTRUCTION, RunEvent, runAgent } from '../src/agent/runtime';
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
		// The finished turn keeps its thinking so the next round of the same turn can replay it.
		const added: unknown[] = [];
		await collect(run(scripted([[{ type: 'thinking', delta: 'x' }, { type: 'done', finishReason: 'stop' }]]), { onMessages: (m) => added.push(...m) }));
		expect(added).toEqual([{ role: 'assistant', content: '', toolCalls: undefined, thinking: 'x' }]);
	});

	it('carries thinking into the next tool round of the same turn', async () => {
		const p = scripted([
			[
				{ type: 'thinking', delta: 'read x, then answer' },
				{ type: 'tool_call', call: { id: 'c1', name: 'echo', argumentsJson: '{"text":"x"}' } },
				{ type: 'done', finishReason: 'tool_calls' },
			],
			[{ type: 'text', delta: 'done' }, { type: 'done', finishReason: 'stop' }],
		]);
		await collect(run(p));
		expect(p.requests[1]?.messages.at(-2)).toMatchObject({ role: 'assistant', thinking: 'read x, then answer' });
		expect(p.requests[0]?.messages.some((m) => 'thinking' in m)).toBe(false);
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

	it('follows the allowed tool rounds with one tool-free request that asks for an answer', async () => {
		const call = (text: string): StreamEvent[] => [
			{ type: 'tool_call', call: { id: text, name: 'echo', argumentsJson: JSON.stringify({ text }) } },
			{ type: 'done', finishReason: 'tool_calls' },
		];
		const p = scripted([call('a'), call('b'), [{ type: 'text', delta: 'answer' }, { type: 'done', finishReason: 'stop' }]]);
		const events = await collect(run(p, { maxIterations: 2 }));
		expect(events.some((e) => e.type === 'error')).toBe(false);
		expect((events.at(-1) as Extract<RunEvent, { type: 'assistant_end' }>).content).toBe('answer');
		expect(p.requests.map((r) => r.tools?.length)).toEqual([1, 1, undefined]);
		expect(p.requests[2]?.messages[0]).toEqual({ role: 'system', content: `sys:no-tools\n\n${FINAL_ANSWER_INSTRUCTION}` });
		// The tool history stays in the final request so the answer can use it.
		expect(p.requests[2]?.messages.filter((m) => m.role === 'tool').map((m) => m.content)).toEqual(['echo:a', 'echo:b']);
	});

	it('never runs tool calls the tool-free final request makes anyway', async () => {
		let runs = 0;
		const proposer: AgentTool = {
			name: 'propose',
			description: 'propose',
			readOnly: false,
			parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
			execute: (args) => {
				runs++;
				return Promise.resolve({ content: `proposed ${String(args['text'])}` });
			},
		};
		const call = (id: string): StreamEvent => ({ type: 'tool_call', call: { id, name: 'propose', argumentsJson: `{"text":"${id}"}` } });
		const tools = () => new ToolRegistry().register(proposer);
		const p = scripted([
			[call('a'), { type: 'done', finishReason: 'tool_calls' }],
			[call('c'), { type: 'done', finishReason: 'tool_calls' }],
			[{ type: 'text', delta: 'Here is what I found.' }, call('b'), { type: 'done', finishReason: 'tool_calls' }],
		]);
		const added: { role: string; toolCalls?: unknown }[] = [];
		const events = await collect(run(p, { maxIterations: 2, tools: tools(), onMessages: (m) => added.push(...m) }));
		expect(runs).toBe(2);
		expect(events.filter((e) => e.type === 'tool_result')).toHaveLength(2);
		expect(events.some((e) => e.type === 'error')).toBe(false);
		const end = events.at(-1) as Extract<RunEvent, { type: 'assistant_end' }>;
		expect(end).toMatchObject({ type: 'assistant_end', content: 'Here is what I found.', toolCalls: [] });
		expect(added.at(-1)).toMatchObject({ role: 'assistant', toolCalls: undefined });

		// With no text either, the turn ends with a clear message instead.
		const q = scripted([
			[call('a'), { type: 'done', finishReason: 'tool_calls' }],
			[call('b'), { type: 'done', finishReason: 'tool_calls' }],
		]);
		runs = 0;
		const silent = await collect(run(q, { maxIterations: 1, tools: tools() }));
		expect(runs).toBe(1);
		expect((silent.at(-1) as Extract<RunEvent, { type: 'error' }>).error.message).toMatch(/Stopped after 1 tool round without a final answer/);
	});

	it('allows one tool round and then a tool-free answer when one round is allowed', async () => {
		const p = scripted([
			[{ type: 'tool_call', call: { id: 'a', name: 'echo', argumentsJson: '{"text":"a"}' } }, { type: 'done', finishReason: 'tool_calls' }],
			[{ type: 'text', delta: 'answer' }, { type: 'done', finishReason: 'stop' }],
		]);
		const events = await collect(run(p, { maxIterations: 1 }));
		expect(p.requests.map((r) => r.tools?.length)).toEqual([1, undefined]);
		expect(p.requests[0]?.messages[0]).toEqual({ role: 'system', content: 'sys:tools' });
		expect(p.requests[1]?.messages[0]).toEqual({ role: 'system', content: `sys:no-tools\n\n${FINAL_ANSWER_INSTRUCTION}` });
		expect(events.filter((e) => e.type === 'tool_result')).toHaveLength(1);
		expect(events.some((e) => e.type === 'error')).toBe(false);
		expect((events.at(-1) as Extract<RunEvent, { type: 'assistant_end' }>).content).toBe('answer');
	});

	it('allows one tool round when the configured cap is not a usable number', async () => {
		for (const maxIterations of [Number.NaN, 0]) {
			const call: StreamEvent[] = [{ type: 'tool_call', call: { id: 'a', name: 'echo', argumentsJson: '{"text":"a"}' } }, { type: 'done', finishReason: 'tool_calls' }];
			const p = scripted([call, [{ type: 'text', delta: 'answer' }, { type: 'done', finishReason: 'stop' }]]);
			const events = await collect(run(p, { maxIterations }));
			expect(p.requests.map((r) => r.tools?.length)).toEqual([1, undefined]);
			expect((events.at(-1) as Extract<RunEvent, { type: 'assistant_end' }>).content).toBe('answer');
		}
	});

	it('answers without the final-answer instruction when no tool round ran', async () => {
		const p = scripted([[{ type: 'text', delta: 'answer' }, { type: 'done', finishReason: 'stop' }]]);
		await collect(run(p, { maxIterations: 1 }));
		expect(p.requests).toHaveLength(1);
		expect(p.requests[0]?.tools).toHaveLength(1);
		expect(p.requests[0]?.messages[0]).toEqual({ role: 'system', content: 'sys:tools' });
	});

	it('treats blank and empty-object arguments as the same call', async () => {
		let runs = 0;
		const noArgs: AgentTool = {
			name: 'list',
			description: 'list',
			readOnly: true,
			parameters: { type: 'object', properties: {} },
			execute: () => {
				runs++;
				return Promise.resolve({ content: 'a.md' });
			},
		};
		const call = (id: string, argumentsJson: string): StreamEvent[] => [{ type: 'tool_call', call: { id, name: 'list', argumentsJson } }, { type: 'done', finishReason: 'tool_calls' }];
		const p = scripted([call('a', ''), call('b', '{}'), [{ type: 'text', delta: 'done' }, { type: 'done', finishReason: 'stop' }]]);
		const events = await collect(run(p, { tools: new ToolRegistry().register(noArgs) }));
		const results = events.filter((e): e is Extract<RunEvent, { type: 'tool_result' }> => e.type === 'tool_result');
		expect(runs).toBe(1);
		expect(results[1]?.result.content).toMatch(/already called list with these arguments/);
	});

	it('does not rerun a repeated call and ends a loop of identical calls with a tool-free answer', async () => {
		let runs = 0;
		const counting: AgentTool = {
			...echoTool,
			execute: (args, c) => {
				runs++;
				return echoTool.execute(args, c);
			},
		};
		// Same call each round, with the argument keys in a different order the second time.
		const same = (json: string): StreamEvent[] => [{ type: 'tool_call', call: { id: 'x', name: 'echo', argumentsJson: json } }, { type: 'done', finishReason: 'tool_calls' }];
		const p = scripted([
			same('{"text":"x","n":1}'),
			same('{"n":1,"text":"x"}'),
			same('{"text":"x","n":1}'),
			[{ type: 'text', delta: 'best effort' }, { type: 'done', finishReason: 'stop' }],
		]);
		const events = await collect(run(p, { maxIterations: 8, tools: new ToolRegistry().register(counting) }));
		const results = events.filter((e): e is Extract<RunEvent, { type: 'tool_result' }> => e.type === 'tool_result');
		expect(runs).toBe(1);
		expect(results.map((r) => r.result.isError ?? false)).toEqual([false, true, true]);
		expect(results[1]?.result.content).toMatch(/already called echo with these arguments/);
		expect(p.requests).toHaveLength(4);
		expect(p.requests.map((r) => r.tools?.length)).toEqual([1, 1, 1, undefined]);
		expect(p.requests[3]?.messages[0]?.content).toContain(FINAL_ANSWER_INSTRUCTION);
		expect((events.at(-1) as Extract<RunEvent, { type: 'assistant_end' }>).content).toBe('best effort');
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
		const q = scripted([[{ type: 'tool_call', call: { id: 'a', name: 'echo', argumentsJson: '{"text":"a"}' } }, { type: 'done', finishReason: 'tool_calls' }]]);
		const disabled = await collect(run(q, { toolsEnabled: false }));
		expect(q.requests[0]?.tools).toBeUndefined();
		expect(q.requests[0]?.messages[0]).toEqual({ role: 'system', content: 'sys:no-tools' });
		expect(q.requests).toHaveLength(1);
		expect(disabled.some((e) => e.type === 'tool_result')).toBe(false);
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
