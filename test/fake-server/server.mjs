/**
 * Fake LLM server speaking both the Ollama native API and the OpenAI Chat
 * Completions API, with scripted behaviour driven by the user's message so
 * tests and the in-app end-to-end check are deterministic.
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
 * `fake-429` -> 429, `fake-500` -> 500, `fake-slow` streams one word per 150 ms,
 * any other model behaves normally. OpenAI endpoints require `Bearer sk-fake`.
 */
import http from 'node:http';

const API_KEY = 'sk-fake';

export function startFakeServer(port = 0) {
	const requests = [];
	const server = http.createServer((req, res) => {
		// Real Ollama allows the app:// origin by default and OpenAI sends permissive
		// CORS headers; mirror that so the renderer-side fetch in Obsidian works.
		res.setHeader('Access-Control-Allow-Origin', req.headers.origin ?? '*');
		res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
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
		console.log(`fake LLM server listening on ${s.baseUrl} (OpenAI key: ${API_KEY})`);
	});
}
