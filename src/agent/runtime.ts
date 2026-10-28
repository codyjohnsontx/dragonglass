import { ChatMessage, Provider, ProviderError, StreamEvent, ToolCall, Usage, toProviderError } from '../providers/types';
import { AgentTool, parseToolArguments, ToolRegistry, ToolResult, ToolValidationError } from './tools';

/**
 * The agent loop: send messages, stream the reply, run any tool calls through
 * the validated tool layer, feed results back, repeat until the model stops
 * or the iteration cap is hit. Emits events the chat view renders live.
 */

export type RunEvent =
	| { type: 'assistant_start' }
	| { type: 'text_delta'; delta: string }
	| { type: 'tool_call'; call: ToolCall; tool: AgentTool | undefined }
	| { type: 'tool_result'; call: ToolCall; result: ToolResult }
	| { type: 'assistant_end'; content: string; toolCalls: ToolCall[]; usage?: Usage }
	| { type: 'tools_disabled'; reason: string }
	| { type: 'error'; error: ProviderError };

export interface RunOptions {
	provider: Provider;
	model: string;
	messages: ChatMessage[];
	tools: ToolRegistry;
	toolsEnabled: boolean;
	conversationId: string;
	signal: AbortSignal;
	maxIterations: number;
	/** Called after each assistant turn; the runtime appends the messages it created. */
	onMessages?: (added: ChatMessage[]) => void;
}

export async function* runAgent(opts: RunOptions): AsyncIterable<RunEvent> {
	const messages = [...opts.messages];
	let toolsEnabled = opts.toolsEnabled && opts.provider.capabilities.toolCalling !== false;
	let iterations = 0;

	while (iterations < opts.maxIterations) {
		iterations++;
		if (opts.signal.aborted) {
			yield { type: 'error', error: new ProviderError('cancelled', 'Generation stopped.') };
			return;
		}
		yield { type: 'assistant_start' };

		let content = '';
		const toolCalls: ToolCall[] = [];
		let usage: Usage | undefined;
		let turnError: ProviderError | null = null;

		try {
			const stream = opts.provider.chat({
				model: opts.model,
				messages: [...messages],
				tools: toolsEnabled ? opts.tools.definitions() : undefined,
				signal: opts.signal,
			});
			for await (const ev of stream) {
				const e: StreamEvent = ev;
				if (e.type === 'text') {
					content += e.delta;
					yield { type: 'text_delta', delta: e.delta };
				} else if (e.type === 'tool_call') {
					toolCalls.push(e.call);
				} else if (e.type === 'usage') {
					usage = e.usage;
				}
			}
		} catch (err) {
			turnError = toProviderError(err);
		}

		if (turnError) {
			// Retry once without tools when the model rejects them, so the user
			// still gets an answer and a clear note about the limitation.
			if (turnError.kind === 'unsupported_tools' && toolsEnabled && content === '') {
				toolsEnabled = false;
				yield { type: 'tools_disabled', reason: turnError.message };
				iterations--;
				continue;
			}
			if (content.length > 0 && turnError.kind === 'cancelled') {
				const partial: ChatMessage = { role: 'assistant', content };
				messages.push(partial);
				opts.onMessages?.([partial]);
				yield { type: 'assistant_end', content, toolCalls: [], usage };
			}
			yield { type: 'error', error: turnError };
			return;
		}

		const assistant: ChatMessage = { role: 'assistant', content, toolCalls: toolCalls.length ? toolCalls : undefined };
		messages.push(assistant);
		const added: ChatMessage[] = [assistant];
		yield { type: 'assistant_end', content, toolCalls, usage };

		if (toolCalls.length === 0) {
			opts.onMessages?.(added);
			return;
		}

		for (const call of toolCalls) {
			const tool = opts.tools.get(call.name);
			yield { type: 'tool_call', call, tool };
			const result = await executeTool(tool, call, opts);
			const toolMsg: ChatMessage = { role: 'tool', content: result.content, toolCallId: call.id, toolName: call.name };
			messages.push(toolMsg);
			added.push(toolMsg);
			yield { type: 'tool_result', call, result };
			if (opts.signal.aborted) break;
		}
		opts.onMessages?.(added);
		if (opts.signal.aborted) {
			yield { type: 'error', error: new ProviderError('cancelled', 'Generation stopped.') };
			return;
		}
	}
	yield {
		type: 'error',
		error: new ProviderError('unknown', `Stopped after ${opts.maxIterations} tool rounds. Ask again to continue.`),
	};
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
