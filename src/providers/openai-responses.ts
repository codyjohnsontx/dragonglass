import {
	ChatMessage,
	ChatRequest,
	FinishReason,
	ProviderError,
	StreamEvent,
	ToolCall,
	toProviderError,
	toolCallText,
	toolResultText,
	Usage,
} from './types';
import { parseSse } from './http';

/**
 * OpenAI's Responses API (POST /responses), for models that take tool calls
 * only there (https://developers.openai.com/api/docs/guides/function-calling).
 * Used statelessly, like Chat Completions: `store: false`, and the whole
 * history goes out as input items on every request. Reasoning items are not
 * replayed, so the model reasons afresh at each tool step, as it does over
 * Chat Completions.
 */
export function responsesBody(request: ChatRequest, streaming: boolean, withTools: boolean): Record<string, unknown> {
	const body: Record<string, unknown> = {
		model: request.model,
		input: toResponsesInput(request.messages, withTools),
		stream: streaming,
		store: false,
	};
	if (withTools) {
		body['tools'] = (request.tools ?? []).map((t) => ({
			type: 'function',
			name: t.name,
			description: t.description,
			parameters: t.parameters,
			// Strict is the Responses default and demands every property be
			// required and objects closed, which the vault tool schemas are not.
			strict: false,
		}));
	}
	if (request.temperature !== undefined) body['temperature'] = request.temperature;
	return body;
}

/**
 * History as Responses input items. Tool calls and results become
 * `function_call` and `function_call_output` items when tools are sent, and
 * plain text otherwise, as for Anthropic and Gemini.
 */
export function toResponsesInput(messages: ChatMessage[], withTools: boolean): Array<Record<string, unknown>> {
	const out: Array<Record<string, unknown>> = [];
	for (const m of messages) {
		switch (m.role) {
			case 'assistant': {
				const calls = m.toolCalls ?? [];
				const text = withTools ? m.content : [m.content, ...calls.map(toolCallText)].filter(Boolean).join('\n');
				if (text) out.push({ role: 'assistant', content: text });
				if (!withTools) break;
				for (const c of calls) {
					out.push({ type: 'function_call', call_id: c.id, name: c.name, arguments: c.argumentsJson || '{}' });
				}
				break;
			}
			case 'tool':
				out.push(
					withTools
						? { type: 'function_call_output', call_id: m.toolCallId ?? '', output: m.content }
						: { role: 'user', content: toolResultText(m) },
				);
				break;
			default:
				out.push({ role: m.role, content: m.content });
		}
	}
	return out;
}

interface ResponsesItem {
	type?: string;
	call_id?: string;
	name?: string;
	arguments?: string;
	content?: Array<{ type?: string; text?: string }>;
}

interface ResponsesUsage {
	input_tokens?: number;
	output_tokens?: number;
	output_tokens_details?: { reasoning_tokens?: number } | null;
}

interface ResponsesResponse {
	status?: string;
	output?: ResponsesItem[];
	usage?: ResponsesUsage | null;
	incomplete_details?: { reason?: string } | null;
	error?: { message?: string } | null;
}

interface ResponsesStreamEvent {
	type?: string;
	delta?: string;
	output_index?: number;
	item?: ResponsesItem;
	arguments?: string;
	response?: ResponsesResponse;
	message?: string;
}

/** Events from a Responses SSE stream. */
export async function* responsesStreamEvents(chunks: AsyncIterable<string>, signal?: AbortSignal): AsyncIterable<StreamEvent> {
	const pending = new Map<number, { id: string; name: string; args: string }>();
	let final: ResponsesResponse | null = null;
	try {
		for await (const data of parseSse(chunks)) {
			if (data.trim() === '[DONE]') break;
			const ev = safeJson(data) as ResponsesStreamEvent | null;
			if (!ev) continue;
			const idx = ev.output_index ?? 0;
			switch (ev.type) {
				case 'response.output_text.delta':
					if (ev.delta) yield { type: 'text', delta: ev.delta };
					break;
				case 'response.output_item.added':
					if (ev.item?.type === 'function_call') {
						pending.set(idx, { id: ev.item.call_id ?? '', name: ev.item.name ?? '', args: ev.item.arguments ?? '' });
						if (ev.item.name) yield { type: 'tool_call_start', name: ev.item.name };
					}
					break;
				case 'response.function_call_arguments.delta': {
					const entry = pending.get(idx);
					if (entry && ev.delta) entry.args += ev.delta;
					break;
				}
				case 'response.function_call_arguments.done': {
					const entry = pending.get(idx);
					if (entry && typeof ev.arguments === 'string') entry.args = ev.arguments;
					break;
				}
				case 'response.output_item.done':
					if (ev.item?.type === 'function_call') {
						const entry = pending.get(idx) ?? { id: '', name: '', args: '' };
						entry.id = ev.item.call_id ?? entry.id;
						entry.name = ev.item.name ?? entry.name;
						entry.args = ev.item.arguments ?? entry.args;
						pending.set(idx, entry);
					}
					break;
				case 'response.completed':
				case 'response.incomplete':
					final = ev.response ?? {};
					break;
				case 'response.failed':
					throw new ProviderError('server', ev.response?.error?.message ?? 'The response failed');
				case 'error':
					throw new ProviderError('server', ev.message ?? 'unknown error');
			}
		}
	} catch (e) {
		throw toProviderError(e);
	}
	if (signal?.aborted && final === null) {
		throw new ProviderError('cancelled', 'Generation stopped.');
	}
	const calls = [...pending.entries()].sort((a, b) => a[0] - b[0]);
	for (const [i, entry] of calls) {
		yield { type: 'tool_call', call: toolCall(entry.id, entry.name, entry.args, i) };
	}
	const usage = final?.usage ? toUsage(final.usage) : null;
	if (usage) yield { type: 'usage', usage };
	yield { type: 'done', finishReason: final ? finishReason(final, calls.length > 0) : calls.length > 0 ? 'tool_calls' : 'other' };
}

/** Events from a whole Responses reply, for transports that cannot stream. */
export async function* responsesWholeEvents(chunks: AsyncIterable<string>): AsyncIterable<StreamEvent> {
	let text = '';
	for await (const c of chunks) text += c;
	const parsed = safeJson(text) as ResponsesResponse | null;
	if (!parsed) throw new ProviderError('server', 'Unparseable response from provider');
	if (parsed.status === 'failed' || parsed.error) throw new ProviderError('server', parsed.error?.message ?? 'The response failed');
	let calls = 0;
	for (const item of parsed.output ?? []) {
		if (item.type === 'message') {
			const reply = (item.content ?? []).map((part) => (part.type === 'output_text' ? part.text ?? '' : '')).join('');
			if (reply) yield { type: 'text', delta: reply };
		} else if (item.type === 'function_call') {
			yield { type: 'tool_call', call: toolCall(item.call_id ?? '', item.name ?? '', item.arguments ?? '', calls++) };
		}
	}
	if (parsed.usage) yield { type: 'usage', usage: toUsage(parsed.usage) };
	yield { type: 'done', finishReason: finishReason(parsed, calls > 0) };
}

function toolCall(id: string, name: string, args: string, i: number): ToolCall {
	return { id: id || `call_${Date.now().toString(36)}_${i}`, name, argumentsJson: args || '{}' };
}

function toUsage(u: ResponsesUsage): Usage {
	const usage: Usage = { inputTokens: u.input_tokens, outputTokens: u.output_tokens };
	const reasoning = u.output_tokens_details?.reasoning_tokens;
	if (reasoning) usage.reasoningTokens = reasoning;
	return usage;
}

function finishReason(r: ResponsesResponse, calledTools: boolean): FinishReason {
	if (r.status === 'incomplete') return r.incomplete_details?.reason === 'max_output_tokens' ? 'length' : 'other';
	if (calledTools) return 'tool_calls';
	return r.status === 'completed' ? 'stop' : 'other';
}

function safeJson(text: string): unknown {
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return null;
	}
}
