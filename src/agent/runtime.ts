import { ChatMessage, Provider, ProviderError, StreamEvent, ToolCall, Usage, toProviderError } from '../providers/types';
import { AgentTool, parseToolArguments, ToolRegistry, ToolResult, ToolValidationError } from './tools';

/**
 * The agent loop: send messages, stream the reply, run any tool calls through
 * the validated tool layer, feed results back, repeat until the model stops
 * or the iteration cap is hit. Emits events the chat view renders live.
 *
 * Small local models tend to loop on the same call. A call repeated with the
 * same arguments in one turn is not run again; the model is told so. A third
 * identical call, or using up the allowed tool rounds, makes the next request
 * tool-free with an instruction to answer from what was gathered, so the turn
 * ends in an answer rather than a round-cap error.
 */

export type RunEvent =
	| { type: 'assistant_start' }
	| { type: 'text_delta'; delta: string }
	/** Reasoning streamed by a thinking model before its answer. */
	| { type: 'thinking_delta'; delta: string }
	/**
	 * The model has begun a call to `name` and is still producing its
	 * arguments. One per call, in call order, before the turn's `assistant_end`;
	 * synthesized for providers that only report finished calls.
	 */
	| { type: 'tool_call_start'; name: string }
	/** A finished call about to run; `tool` is undefined for a name the registry does not know. */
	| { type: 'tool_call'; call: ToolCall; tool: AgentTool | undefined }
	| { type: 'tool_result'; call: ToolCall; result: ToolResult }
	| { type: 'assistant_end'; content: string; thinking: string; toolCalls: ToolCall[]; usage?: Usage; warnings: string[] }
	| { type: 'tools_disabled'; reason: string }
	/** A provider warning about this turn, such as a prompt cut to fit the context window. */
	| { type: 'warning'; message: string }
	| { type: 'error'; error: ProviderError };

export interface RunOptions {
	provider: Provider;
	model: string;
	/** Builds the system prompt for whether tools are actually sent on a turn. */
	system: (toolsEnabled: boolean) => string;
	/** The conversation so far, without a system message. */
	messages: ChatMessage[];
	tools: ToolRegistry;
	toolsEnabled: boolean;
	conversationId: string;
	signal: AbortSignal;
	/** Tool rounds allowed per turn; one tool-free request for the answer follows them. */
	maxIterations: number;
	/** Called after each assistant turn; the runtime appends the messages it created. */
	onMessages?: (added: ChatMessage[]) => void;
}

export async function* runAgent(opts: RunOptions): AsyncIterable<RunEvent> {
	const messages = [...opts.messages];
	let toolsEnabled = opts.toolsEnabled && opts.provider.capabilities.toolCalling !== false;
	/** Tool rounds run so far this turn. */
	let rounds = 0;
	/** How often each call (name plus normalized arguments) was requested this turn. */
	const callCounts = new Map<string, number>();
	let forceFinal = false;
	const maxRounds = Number.isFinite(opts.maxIterations) ? Math.max(1, opts.maxIterations) : 1;

	for (;;) {
		const finalRound = toolsEnabled && (forceFinal || rounds >= maxRounds);
		const sendTools = toolsEnabled && !finalRound;
		if (opts.signal.aborted) {
			yield { type: 'error', error: new ProviderError('cancelled', 'Generation stopped.') };
			return;
		}
		yield { type: 'assistant_start' };

		let content = '';
		let thinking = '';
		const toolCalls: ToolCall[] = [];
		const warnings: string[] = [];
		let usage: Usage | undefined;
		let turnError: ProviderError | null = null;
		let callsStarted = 0;

		try {
			const stream = opts.provider.chat({
				model: opts.model,
				messages: [{ role: 'system', content: finalRound ? `${opts.system(false)}\n\n${FINAL_ANSWER_INSTRUCTION}` : opts.system(toolsEnabled) }, ...messages],
				tools: sendTools ? opts.tools.definitions() : undefined,
				signal: opts.signal,
			});
			for await (const ev of stream) {
				const e: StreamEvent = ev;
				if (e.type === 'text') {
					content += e.delta;
					yield { type: 'text_delta', delta: e.delta };
				} else if (e.type === 'thinking') {
					thinking += e.delta;
					yield { type: 'thinking_delta', delta: e.delta };
				} else if (e.type === 'tool_call_start') {
					callsStarted++;
					yield { type: 'tool_call_start', name: e.name };
				} else if (e.type === 'tool_call') {
					toolCalls.push(e.call);
					if (toolCalls.length > callsStarted) {
						// The provider reports only finished calls; give the view the same start signal.
						callsStarted++;
						yield { type: 'tool_call_start', name: e.call.name };
					}
				} else if (e.type === 'usage') {
					usage = e.usage;
				} else if (e.type === 'warning') {
					warnings.push(e.message);
					yield { type: 'warning', message: e.message };
				}
			}
		} catch (err) {
			turnError = toProviderError(err);
		}

		if (turnError) {
			// Retry once without tools when the model rejects them, so the user
			// still gets an answer and a clear note about the limitation.
			if (turnError.kind === 'unsupported_tools' && sendTools && content === '') {
				toolsEnabled = false;
				yield { type: 'tools_disabled', reason: turnError.message };
				continue;
			}
			if (content.length > 0 && turnError.kind === 'cancelled') {
				const partial: ChatMessage = { role: 'assistant', content };
				messages.push(partial);
				opts.onMessages?.([partial]);
				yield { type: 'assistant_end', content, thinking, toolCalls: [], usage, warnings };
			}
			yield { type: 'error', error: turnError };
			return;
		}

		// Calls from a request that offered no tools are dropped, never run.
		const calls = sendTools ? toolCalls : [];
		const assistant: ChatMessage = { role: 'assistant', content, toolCalls: calls.length ? calls : undefined };
		if (thinking) assistant.thinking = thinking;
		messages.push(assistant);
		const added: ChatMessage[] = [assistant];
		yield { type: 'assistant_end', content, thinking, toolCalls: calls, usage, warnings };

		if (calls.length === 0) {
			opts.onMessages?.(added);
			if (finalRound && content.trim() === '') {
				yield {
					type: 'error',
					error: new ProviderError('unknown', `Stopped after ${rounds} tool round${rounds === 1 ? '' : 's'} without a final answer. Ask again to continue.`),
				};
			}
			return;
		}

		rounds++;
		for (const call of calls) {
			let result: ToolResult;
			if (opts.signal.aborted) {
				result = { content: 'Not run: generation stopped.', isError: true };
			} else {
				const tool = opts.tools.get(call.name);
				yield { type: 'tool_call', call, tool };
				const key = callKey(call);
				const count = (callCounts.get(key) ?? 0) + 1;
				callCounts.set(key, count);
				if (count > 1) {
					if (count >= 3) forceFinal = true;
					result = {
						content: `Error: you already called ${call.name} with these arguments in this turn and its result is above; calling it again gives the same result. Use a different tool or different arguments, or answer with what you have.`,
						isError: true,
					};
				} else {
					result = await executeTool(tool, call, opts);
				}
			}
			const toolMsg: ChatMessage = { role: 'tool', content: result.content, toolCallId: call.id, toolName: call.name };
			messages.push(toolMsg);
			added.push(toolMsg);
			yield { type: 'tool_result', call, result };
		}
		opts.onMessages?.(added);
		if (opts.signal.aborted) {
			yield { type: 'error', error: new ProviderError('cancelled', 'Generation stopped.') };
			return;
		}
	}
}

/** Appended to the system prompt of the tool-free request that ends a looping or long turn. */
export const FINAL_ANSWER_INSTRUCTION =
	'You have used up your tool calls for this turn. Answer the user now from the tool results above. ' +
	'If something is still missing, say what you found and what is missing instead of guessing.';

/** A call's identity for repeat detection: its name and its arguments with object keys sorted. */
function callKey(call: ToolCall): string {
	let args: unknown;
	try {
		// Blank arguments mean no arguments, as the tool layer reads them.
		args = call.argumentsJson.trim() === '' ? {} : JSON.parse(call.argumentsJson);
	} catch {
		return `${call.name}\u0000${call.argumentsJson.trim()}`;
	}
	return `${call.name}\u0000${JSON.stringify(sortKeys(args))}`;
}

function sortKeys(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortKeys);
	if (value && typeof value === 'object') {
		const obj = value as Record<string, unknown>;
		return Object.fromEntries(Object.keys(obj).sort().map((k) => [k, sortKeys(obj[k])]));
	}
	return value;
}

async function executeTool(tool: AgentTool | undefined, call: ToolCall, opts: RunOptions): Promise<ToolResult> {
	if (!tool) return { content: `Error: unknown tool "${call.name}".`, isError: true };
	let args: Record<string, unknown>;
	try {
		args = parseToolArguments(tool, call.argumentsJson);
	} catch (e) {
		const msg = e instanceof ToolValidationError ? e.message : String(e);
		return { content: `Error: ${msg}`, isError: true };
	}
	try {
		return await tool.execute(args, { conversationId: opts.conversationId, signal: opts.signal });
	} catch (e) {
		return { content: `Error: ${e instanceof Error ? e.message : String(e)}`, isError: true };
	}
}
