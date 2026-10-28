/**
 * Fake LLM server speaking the Ollama native API, the OpenAI Chat Completions
 * API (under /v1), the Anthropic Messages API (under /anthropic/v1) and the
 * Gemini API (under /gemini/v1beta), with scripted behaviour driven by the
 * user's message so tests and the in-app end-to-end check are deterministic.
 *
 *   node test/fake-server/server.mjs [port]       # CLI (default 11435)
 *   import { startFakeServer } from './server.mjs' # in-process for vitest
 *
 * Scripted user messages (case-insensitive prefix):
 *   hello                                  -> plain streamed text
 *   read <path>                            -> read_note, then a summary
 *   edit <path> replace <old> with <new>   -> read_note, propose_edit_note, then text
 *   create <path>                          -> propose_create_note, then text
 *   search <query>                         -> search_notes, then text
 *   bad tool                               -> calls a tool that does not exist
 *   bad args                               -> read_note with missing arguments
 *   loop                                   -> keeps calling list_files forever (iteration cap test)
 *   anything else                          -> echoes the message
 *
 * Models: `fake-plain` rejects tools (Ollama 400 / OpenAI works without tools),
 * `fake-429` -> 429, `fake-500` -> 500 (Anthropic: 529 overloaded),
 * `fake-slow` streams one word per 150 ms, `fake-overloaded` (Anthropic) sends
 * an error event mid-stream, `fake-safety` (Gemini) finishes with SAFETY and
 * no content, `fake-missing` (Gemini) -> 404, any other model behaves normally.
 *
 * Keys: OpenAI `Bearer sk-fake`, Anthropic `x-api-key: sk-ant-fake`, Gemini
 * `x-goog-api-key: gemini-fake`. The Anthropic and Gemini routes reject the
 * request shapes the real APIs reject (non-alternating roles, empty text
 * blocks, orphan tool results, `additionalProperties` in Gemini schemas, a
 * Gemini function call replayed without a thought signature) so adapter bugs
 * fail here rather than against a paid API.
 */
import http from 'node:http';

const API_KEY = 'sk-fake';
const ANTHROPIC_KEY = 'sk-ant-fake';
const GEMINI_KEY = 'gemini-fake';

export function startFakeServer(port = 0) {
	const requests = [];
	const server = http.createServer((req, res) => {
		// Real Ollama allows the app:// origin by default and OpenAI sends permissive
		// CORS headers; mirror that so the renderer-side fetch in Obsidian works.
		res.setHeader('Access-Control-Allow-Origin', req.headers.origin ?? '*');
		res.setHeader(
			'Access-Control-Allow-Headers',
			'Authorization, Content-Type, x-api-key, anthropic-version, anthropic-dangerous-direct-browser-access, x-goog-api-key',
		);
		res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
		if (req.method === 'OPTIONS') {
			res.writeHead(204);
			res.end();
			return;
		}
		let body = '';
		req.on('data', (c) => (body += c));
		req.on('end', () => {
			const parsed = body ? safeJson(body) : null;
			requests.push({ method: req.method, url: req.url, headers: req.headers, body: parsed });
			void route(req, res, parsed);
		});
	});
	return new Promise((resolve) => {
		server.listen(port, '127.0.0.1', () => {
			const actual = server.address().port;
			resolve({
				port: actual,
				baseUrl: `http://127.0.0.1:${actual}`,
				requests,
				close: () => new Promise((r) => server.close(() => r())),
			});
		});
	});
}

async function route(req, res, body) {
	const url = new URL(req.url, 'http://x');
	const path = url.pathname;
	if (req.method === 'GET' && path === '/api/version') return json(res, 200, { version: '0.0.0-fake' });
	if (req.method === 'GET' && path === '/api/tags') {
		return json(res, 200, { models: [{ name: 'fake-tools:latest', model: 'fake-tools:latest' }, { name: 'fake-plain:latest', model: 'fake-plain:latest' }] });
	}
	if (req.method === 'POST' && path === '/api/chat') return ollamaChat(res, body ?? {});
	if (path.startsWith('/v1/')) {
		const auth = req.headers['authorization'] ?? '';
		if (auth !== `Bearer ${API_KEY}`) {
			return json(res, 401, { error: { message: 'Incorrect API key provided', type: 'invalid_request_error', code: 'invalid_api_key' } });
		}
		if (req.method === 'GET' && path === '/v1/models') {
			return json(res, 200, { object: 'list', data: [{ id: 'fake-gpt', object: 'model' }, { id: 'fake-plain', object: 'model' }] });
		}
		if (req.method === 'POST' && path === '/v1/chat/completions') return openaiChat(res, body ?? {});
	}
	if (path.startsWith('/anthropic/v1/')) {
		if (req.headers['x-api-key'] !== ANTHROPIC_KEY) {
			return json(res, 401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } });
		}
		if (!req.headers['anthropic-version']) {
			return json(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: 'anthropic-version: header is required' } });
		}
		if (req.method === 'GET' && path === '/anthropic/v1/models') {
			return json(res, 200, {
				data: [
					{ type: 'model', id: 'fake-claude', display_name: 'Fake Claude', created_at: '2026-01-01T00:00:00Z', max_input_tokens: 200000 },
					{ type: 'model', id: 'fake-claude-small', display_name: 'Fake Claude Small', created_at: '2025-01-01T00:00:00Z' },
				],
				has_more: false,
				first_id: 'fake-claude',
				last_id: 'fake-claude-small',
			});
		}
		if (req.method === 'POST' && path === '/anthropic/v1/messages') return anthropicChat(res, body ?? {});
	}
	if (path.startsWith('/gemini/v1beta/')) {
		if (req.headers['x-goog-api-key'] !== GEMINI_KEY) {
			return json(res, 400, {
				error: {
					code: 400,
					message: 'API key not valid. Please pass a valid API key.',
					status: 'INVALID_ARGUMENT',
					details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID', domain: 'googleapis.com' }],
				},
			});
		}
		if (req.method === 'GET' && path === '/gemini/v1beta/models') {
			return json(res, 200, {
				models: [
					{ name: 'models/fake-gemini', displayName: 'Fake Gemini', inputTokenLimit: 1048576, outputTokenLimit: 65536, supportedGenerationMethods: ['generateContent', 'countTokens'] },
					{ name: 'models/fake-embedding', displayName: 'Fake Embedding', supportedGenerationMethods: ['embedContent'] },
				],
			});
		}
		const m = /^\/gemini\/v1beta\/models\/([^:]+):(generateContent|streamGenerateContent)$/.exec(path);
		if (req.method === 'POST' && m) {
			const stream = m[2] === 'streamGenerateContent';
			if (stream && url.searchParams.get('alt') !== 'sse') return json(res, 400, { error: { code: 400, message: 'fake server only streams SSE', status: 'INVALID_ARGUMENT' } });
			return geminiChat(res, decodeURIComponent(m[1]), body ?? {}, stream);
		}
	}
	json(res, 404, { error: 'not found' });
}

// ------------------------------------------------------------------ scripting

function plan(messages, toolsAvailable) {
	const lastUserIdx = findLastIndex(messages, (m) => m.role === 'user');
	const user = lastUserIdx >= 0 ? String(messages[lastUserIdx].content ?? '') : '';
	const after = messages.slice(lastUserIdx + 1);
	const toolResults = after.filter((m) => m.role === 'tool');
	const stage = toolResults.length;
	const lastResult = toolResults[stage - 1];
	const lastResultText = lastResult ? String(lastResult.content ?? '') : '';
	// Strip the context block the plugin prepends to the user turn.
	const text = user.split('\n').filter((l) => !l.startsWith('<<<') && l.trim() !== '').pop()?.trim() ?? user.trim();
	const lower = text.toLowerCase();
	const noTools = !toolsAvailable;

	let m;
	if (lower.startsWith('hello')) return { text: 'Hello from the fake model. I can read and edit your notes.' };
	if ((m = /^edit\s+(\S+)\s+replace\s+"([^"]+)"\s+with\s+"([^"]+)"/i.exec(text))) {
		const [, path, oldText, newText] = m;
		if (noTools) return { text: `I cannot edit ${path} without tools.` };
		if (stage === 0) return { tool: { name: 'read_note', args: { path } } };
		if (stage === 1) {
			return { tool: { name: 'propose_edit_note', args: { path, summary: `Replace "${oldText}" with "${newText}"`, edits: [{ type: 'find_replace', find: oldText, replace: newText }] } } };
		}
		return { text: lastResultText.startsWith('Error') ? `The edit failed: ${lastResultText}` : `I proposed replacing "${oldText}" with "${newText}" in ${path}. Review it in the panel.` };
	}
	if ((m = /^read\s+(\S+)/i.exec(text))) {
		const path = m[1];
		if (noTools) return { text: `I cannot read ${path} without tools.` };
		if (stage === 0) return { tool: { name: 'read_note', args: { path } } };
		const firstLine = lastResultText.split('\n').find((l) => l && !l.startsWith('<<<')) ?? '';
		return { text: lastResultText.startsWith('Error') ? lastResultText : `The note ${path} begins with: ${firstLine}` };
	}
	if ((m = /^create\s+(\S+)/i.exec(text))) {
		const path = m[1];
		if (noTools) return { text: `I cannot create ${path} without tools.` };
		if (stage === 0) return { tool: { name: 'propose_create_note', args: { path, content: `# New note\n\nCreated by the fake model.\n`, summary: 'A new note' } } };
		return { text: `I proposed creating ${path}. Review it in the panel.` };
	}
	if ((m = /^search\s+(.+)/i.exec(text))) {
		const query = m[1];
		if (noTools) return { text: `I cannot search without tools.` };
		if (stage === 0) return { tool: { name: 'search_notes', args: { query } } };
		return { text: `Search results for "${query}":\n${lastResultText}` };
	}
	if (lower.startsWith('bad tool')) {
		if (stage === 0) return { tool: { name: 'nonexistent_tool', args: {} } };
		return { text: `Tool failed: ${lastResultText}` };
	}
	if (lower.startsWith('bad args')) {
		if (stage === 0) return { tool: { name: 'read_note', args: {} } };
		return { text: `Tool failed: ${lastResultText}` };
	}
	if (lower.startsWith('loop')) return { tool: { name: 'list_files', args: {} } };
	return { text: `You said: ${text}` };
}

function findLastIndex(arr, pred) {
	for (let i = arr.length - 1; i >= 0; i--) if (pred(arr[i])) return i;
	return -1;
}

function modelBehaviour(model) {
	const m = String(model ?? '').split(':')[0];
	return { plain: m === 'fake-plain', status: m === 'fake-429' ? 429 : m === 'fake-500' ? 500 : 0, slow: m === 'fake-slow' };
}

// --------------------------------------------------------------------- ollama

async function ollamaChat(res, body) {
	const b = modelBehaviour(body.model);
	if (b.status === 429) return json(res, 429, { error: 'rate limited by fake server' });
	if (b.status === 500) return json(res, 500, { error: 'fake internal error' });
	const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
	if (b.plain && hasTools) return json(res, 400, { error: `registry.ollama.ai/library/${body.model} does not support tools` });
	const p = plan(body.messages ?? [], hasTools);
	const base = { model: body.model, created_at: new Date().toISOString() };
	if (body.stream === false) {
		const message = p.tool
			? { role: 'assistant', content: '', tool_calls: [{ function: { name: p.tool.name, arguments: p.tool.args } }] }
			: { role: 'assistant', content: p.text };
		return json(res, 200, { ...base, message, done: true, done_reason: 'stop', prompt_eval_count: 12, eval_count: 7 });
	}
	res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
	if (p.tool) {
		res.write(JSON.stringify({ ...base, message: { role: 'assistant', content: '', tool_calls: [{ function: { name: p.tool.name, arguments: p.tool.args } }] }, done: false }) + '\n');
	} else {
		for (const word of splitWords(p.text)) {
			res.write(JSON.stringify({ ...base, message: { role: 'assistant', content: word }, done: false }) + '\n');
			if (b.slow) await sleep(150);
		}
	}
	res.end(JSON.stringify({ ...base, message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 12, eval_count: 7 }) + '\n');
}

// --------------------------------------------------------------------- openai

async function openaiChat(res, body) {
	const b = modelBehaviour(body.model);
	if (b.status === 429) return json(res, 429, { error: { message: 'Rate limit reached for fake-429', type: 'requests' } });
	if (b.status === 500) return json(res, 500, { error: { message: 'The server had an error', type: 'server_error' } });
	const hasTools = Array.isArray(body.tools) && body.tools.length > 0 && !b.plain;
	const p = plan(body.messages ?? [], hasTools);
	const id = `chatcmpl-fake-${Date.now()}`;
	const base = { id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: body.model };
	const usage = { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 };
	if (!body.stream) {
		const message = p.tool
			? { role: 'assistant', content: null, tool_calls: [{ id: 'call_fake_1', type: 'function', function: { name: p.tool.name, arguments: JSON.stringify(p.tool.args) } }] }
			: { role: 'assistant', content: p.text };
		return json(res, 200, { id, object: 'chat.completion', model: body.model, choices: [{ index: 0, message, finish_reason: p.tool ? 'tool_calls' : 'stop' }], usage });
	}
	res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
	const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
	send({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] });
	if (p.tool) {
		const args = JSON.stringify(p.tool.args);
		const half = Math.ceil(args.length / 2);
		send({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_fake_1', type: 'function', function: { name: p.tool.name, arguments: args.slice(0, half) } }] }, finish_reason: null }] });
		send({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(half) } }] }, finish_reason: null }] });
		send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
	} else {
		for (const word of splitWords(p.text)) {
			send({ ...base, choices: [{ index: 0, delta: { content: word }, finish_reason: null }] });
			if (b.slow) await sleep(150);
		}
		send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
	}
	if (body.stream_options?.include_usage) send({ ...base, choices: [], usage });
	res.end('data: [DONE]\n\n');
}

// ------------------------------------------------------------------ anthropic

/** Validate like the Messages API does and flatten to plan()'s message shape. */
function anthropicToPlan(body) {
	if (typeof body.max_tokens !== 'number') return { error: 'max_tokens: Field required' };
	if (body.messages?.some((m) => m.role === 'system')) return { error: 'messages: Unexpected role "system". Use the top-level system parameter.' };
	const out = [];
	let prev = null;
	let prevToolUseIds = new Set();
	for (const [i, msg] of (body.messages ?? []).entries()) {
		if (msg.role !== 'user' && msg.role !== 'assistant') return { error: `messages.${i}.role: invalid role` };
		if (i === 0 && msg.role !== 'user') return { error: 'messages: first message must use the "user" role' };
		if (prev === msg.role) return { error: 'messages: roles must alternate between "user" and "assistant"' };
		prev = msg.role;
		const blocks = typeof msg.content === 'string' ? [{ type: 'text', text: msg.content }] : msg.content ?? [];
		if (blocks.length === 0) return { error: `messages.${i}: content must be non-empty` };
		const toolUseIds = new Set();
		let sawNonResult = false;
		const text = [];
		const toolCalls = [];
		for (const b of blocks) {
			if (b.type === 'text') {
				if (!b.text) return { error: `messages.${i}: text content blocks must be non-empty` };
				sawNonResult = true;
				text.push(b.text);
			} else if (b.type === 'tool_use') {
				if (!/^[a-zA-Z0-9_-]+$/.test(b.id ?? '')) return { error: `messages.${i}: tool_use.id: String should match pattern` };
				toolUseIds.add(b.id);
				toolCalls.push({ id: b.id, name: b.name, args: b.input });
			} else if (b.type === 'tool_result') {
				if (msg.role !== 'user') return { error: `messages.${i}: tool_result only allowed in user messages` };
				if (sawNonResult) return { error: `messages.${i}: tool_result blocks must come first` };
				if (!prevToolUseIds.has(b.tool_use_id)) return { error: `messages.${i}: unexpected tool_use_id found in tool_result blocks: ${b.tool_use_id}` };
				out.push({ role: 'tool', content: typeof b.content === 'string' ? b.content : JSON.stringify(b.content) });
			} else {
				return { error: `messages.${i}: unsupported block type ${b.type}` };
			}
		}
		if (msg.role === 'user') {
			if (text.length) out.push({ role: 'user', content: text.join('\n') });
		} else {
			out.push({ role: 'assistant', content: text.join(''), tool_calls: toolCalls });
		}
		prevToolUseIds = toolUseIds;
	}
	return { messages: out };
}

async function anthropicChat(res, body) {
	const b = modelBehaviour(body.model);
	if (b.status === 429) return json(res, 429, { type: 'error', error: { type: 'rate_limit_error', message: 'Number of request tokens has exceeded your rate limit' } });
	if (b.status === 500) return json(res, 529, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } });
	const flat = anthropicToPlan(body);
	if (flat.error) return json(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: flat.error } });
	const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
	if (hasTools && body.tools.some((t) => !t.input_schema)) return json(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: 'tools.0.input_schema: Field required' } });
	const p = plan(flat.messages, hasTools);
	const id = `msg_fake_${Date.now()}`;
	const usageIn = { input_tokens: 10, cache_read_input_tokens: 2, cache_creation_input_tokens: 0 };
	const preamble = 'Let me check. ';
	if (!body.stream) {
		const content = p.tool
			? [{ type: 'text', text: preamble }, { type: 'tool_use', id: 'toolu_fake_1', name: p.tool.name, input: p.tool.args }]
			: [{ type: 'text', text: p.text }];
		return json(res, 200, { id, type: 'message', role: 'assistant', model: body.model, content, stop_reason: p.tool ? 'tool_use' : 'end_turn', stop_sequence: null, usage: { ...usageIn, output_tokens: 7 } });
	}
	res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
	const send = (obj) => res.write(`event: ${obj.type}\ndata: ${JSON.stringify(obj)}\n\n`);
	send({ type: 'message_start', message: { id, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { ...usageIn, output_tokens: 1 } } });
	send({ type: 'ping' });
	send({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
	const words = splitWords(p.tool ? preamble : p.text);
	for (const [i, word] of words.entries()) {
		send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: word } });
		if (b.slow) await sleep(150);
		if (i === 1 && String(body.model).startsWith('fake-overloaded')) {
			send({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } });
			return res.end();
		}
	}
	send({ type: 'content_block_stop', index: 0 });
	if (p.tool) {
		const args = JSON.stringify(p.tool.args);
		const half = Math.ceil(args.length / 2);
		send({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_fake_1', name: p.tool.name, input: {} } });
		send({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '' } });
		send({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: args.slice(0, half) } });
		send({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: args.slice(half) } });
		send({ type: 'content_block_stop', index: 1 });
	}
	send({ type: 'message_delta', delta: { stop_reason: p.tool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 7 } });
	send({ type: 'message_stop' });
	res.end();
}

// --------------------------------------------------------------------- gemini

function hasAdditionalProperties(schema) {
	if (!schema || typeof schema !== 'object') return false;
	if ('additionalProperties' in schema) return true;
	return Object.values(schema).some((v) => typeof v === 'object' && hasAdditionalProperties(v));
}

/** Validate like the Gemini API does and flatten to plan()'s message shape. */
function geminiToPlan(body) {
	const out = [];
	for (const [i, c] of (body.contents ?? []).entries()) {
		if (c.role !== 'user' && c.role !== 'model') return { error: `* GenerateContentRequest.contents[${i}].role: must be user or model` };
		if (!Array.isArray(c.parts) || c.parts.length === 0) return { error: `* GenerateContentRequest.contents[${i}].parts: contents.parts must not be empty.` };
		const text = [];
		const calls = [];
		for (const [j, part] of c.parts.entries()) {
			if (typeof part.text === 'string') {
				if (part.text === '') return { error: `* GenerateContentRequest.contents[${i}].parts[${j}].data: required oneof field 'data' must have one initialized field` };
				text.push(part.text);
			} else if (part.functionCall) {
				if (c.role !== 'model') return { error: `contents[${i}]: functionCall only allowed in model turns` };
				if (calls.length === 0 && !part.thoughtSignature) {
					return { error: `Function call is missing a thought_signature in functionCall parts. Position: contents[${i}].parts[${j}]` };
				}
				calls.push({ name: part.functionCall.name, args: part.functionCall.args });
			} else if (part.functionResponse) {
				if (c.role !== 'user') return { error: `contents[${i}]: functionResponse only allowed in user turns` };
				const prevModel = body.contents[i - 1];
				if (!prevModel || prevModel.role !== 'model' || !prevModel.parts.some((pp) => pp.functionCall?.name === part.functionResponse.name)) {
					return { error: `contents[${i}]: function response turn must follow a function call turn with the same name` };
				}
				out.push({ role: 'tool', content: String(part.functionResponse.response?.result ?? '') });
			} else {
				return { error: `contents[${i}].parts[${j}]: unsupported part` };
			}
		}
		if (c.role === 'user') {
			if (text.length) out.push({ role: 'user', content: text.join('\n') });
		} else {
			out.push({ role: 'assistant', content: text.join(''), tool_calls: calls });
		}
	}
	return { messages: out };
}

async function geminiChat(res, model, body, stream) {
	const b = modelBehaviour(model);
	if (model === 'fake-missing') return json(res, 404, { error: { code: 404, message: `models/${model} is not found for API version v1beta, or is not supported for generateContent.`, status: 'NOT_FOUND' } });
	if (b.status === 429) return json(res, 429, { error: { code: 429, message: 'Resource has been exhausted (e.g. check quota).', status: 'RESOURCE_EXHAUSTED' } });
	if (b.status === 500) return json(res, 500, { error: { code: 500, message: 'An internal error has occurred.', status: 'INTERNAL' } });
	const decls = body.tools?.flatMap((t) => t.functionDeclarations ?? []) ?? [];
	if (decls.some((d) => hasAdditionalProperties(d.parameters))) {
		return json(res, 400, { error: { code: 400, message: 'Invalid JSON payload received. Unknown name "additionalProperties" at \'tools[0].function_declarations[0].parameters\': Cannot find field.', status: 'INVALID_ARGUMENT' } });
	}
	const flat = geminiToPlan(body);
	if (flat.error) return json(res, 400, { error: { code: 400, message: flat.error, status: 'INVALID_ARGUMENT' } });
	const p = plan(flat.messages, decls.length > 0);
	const usageMetadata = { promptTokenCount: 12, candidatesTokenCount: 5, thoughtsTokenCount: 2, totalTokenCount: 19 };
	const safety = model === 'fake-safety';
	const final = (parts) => ({
		candidates: [{ content: { role: 'model', parts }, finishReason: safety ? 'SAFETY' : 'STOP', index: 0 }],
		usageMetadata,
		modelVersion: model,
	});
	const callPart = p.tool ? { functionCall: { name: p.tool.name, args: p.tool.args }, thoughtSignature: 'sig-fake-1' } : null;
	if (!stream) {
		return json(res, 200, final(safety ? [] : callPart ? [callPart] : [{ text: p.text }]));
	}
	res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
	const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\r\n\r\n`);
	if (safety) {
		send(final([]));
	} else if (callPart) {
		send(final([callPart]));
	} else {
		const words = splitWords(p.text);
		for (const [i, word] of words.entries()) {
			if (i === words.length - 1) {
				send(final([{ text: word }]));
			} else {
				send({ candidates: [{ content: { role: 'model', parts: [{ text: word }] }, index: 0 }], usageMetadata: { promptTokenCount: 12 }, modelVersion: model });
			}
			if (b.slow) await sleep(150);
		}
	}
	res.end();
}

// ---------------------------------------------------------------------- utils

function splitWords(text) {
	return text.split(/(?<=\s)/);
}

function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

function json(res, status, obj) {
	res.writeHead(status, { 'Content-Type': 'application/json' });
	res.end(JSON.stringify(obj));
}

function safeJson(text) {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
	const port = Number(process.argv[2] ?? process.env.FAKE_LLM_PORT ?? 11435);
	startFakeServer(port).then((s) => {
		console.log(`fake LLM server listening on ${s.baseUrl} (keys: OpenAI ${API_KEY}, Anthropic ${ANTHROPIC_KEY}, Gemini ${GEMINI_KEY})`);
	});
}
