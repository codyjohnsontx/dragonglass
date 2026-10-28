import { describe, expect, it } from 'vitest';
import { joinUrl, parseNdjson, parseSse, RequestUrlHttpClient, splitLines } from '../src/providers/http';
import { errorFromStatus, toProviderError } from '../src/providers/types';

async function* chunks(...parts: string[]): AsyncIterable<string> {
	for (const p of parts) yield p;
}

async function all<T>(it: AsyncIterable<T>): Promise<T[]> {
	const out: T[] = [];
	for await (const x of it) out.push(x);
	return out;
}

describe('stream parsing', () => {
	it('splits lines across chunk boundaries and strips CR', async () => {
		expect(await all(splitLines(chunks('a\nb', 'c\r\nd')))).toEqual(['a', 'bc', 'd']);
	});

	it('parses NDJSON and skips blank lines', async () => {
		expect(await all(parseNdjson(chunks('{"a":1}\n\n{"b":', '2}\n')))).toEqual([{ a: 1 }, { b: 2 }]);
	});

	it('parses SSE events, comments and multi-line data', async () => {
		const events = await all(parseSse(chunks(': keepalive\n', 'data: {"x":1}\n\n', 'data: a\ndata: b\n\n', 'data: [DONE]\n\n')));
		expect(events).toEqual(['{"x":1}', 'a\nb', '[DONE]']);
	});

	it('joins URLs without doubled slashes', () => {
		expect(joinUrl('http://h:1/', '/api/chat')).toBe('http://h:1/api/chat');
		expect(joinUrl('http://h:1/v1', 'models')).toBe('http://h:1/v1/models');
	});

	it('emulates a stream from a whole-body requester', async () => {
		const client = new RequestUrlHttpClient(() => Promise.resolve({ status: 200, headers: {}, text: 'body' }));
		const res = await client.stream({ url: 'u', method: 'GET' });
		expect(client.supportsStreaming).toBe(false);
		expect(await all(res.chunks)).toEqual(['body']);
	});
});

describe('error mapping', () => {
	it('maps statuses and bodies to kinds', () => {
		expect(errorFromStatus(401, '{"error":{"message":"bad key"}}')).toMatchObject({ kind: 'auth', message: 'bad key' });
		expect(errorFromStatus(429, '')).toMatchObject({ kind: 'rate_limit' });
		expect(errorFromStatus(400, '{"error":"llama2 does not support tools"}')).toMatchObject({ kind: 'unsupported_tools' });
		expect(errorFromStatus(404, '{"error":"model \\"x\\" not found"}')).toMatchObject({ kind: 'model_not_found' });
		expect(errorFromStatus(503, 'oops')).toMatchObject({ kind: 'server' });
		expect(errorFromStatus(418, 'teapot')).toMatchObject({ kind: 'invalid_request' });
	});

	it('maps thrown errors', () => {
		expect(toProviderError(new TypeError('Failed to fetch')).kind).toBe('network');
		const abort = new Error('x');
		abort.name = 'AbortError';
		expect(toProviderError(abort).kind).toBe('cancelled');
		expect(toProviderError('weird').kind).toBe('unknown');
	});

	it('gives users actionable messages', () => {
		expect(errorFromStatus(401, '').userMessage()).toMatch(/API key/);
		expect(errorFromStatus(429, '').userMessage()).toMatch(/try again/);
	});
});
