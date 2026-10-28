/**
 * Transport abstraction for provider adapters.
 *
 * Two implementations ship:
 *  - FetchHttpClient: real streaming via `fetch` + ReadableStream. This is the
 *    default. Works for Ollama (which allows the `app://` origin by default)
 *    and for OpenAI (which sends permissive CORS headers).
 *  - RequestUrlHttpClient: Obsidian's `requestUrl`, which bypasses CORS but
 *    cannot stream. Used as a user-selectable fallback; the full body is
 *    delivered as a single chunk so adapters need no special casing.
 *
 * Tests inject their own HttpClient.
 */

export interface HttpRequest {
	url: string;
	method: 'GET' | 'POST';
	headers?: Record<string, string>;
	body?: string;
	signal?: AbortSignal;
}

export interface HttpResponse {
	status: number;
	headers: Record<string, string>;
	text: string;
}

export interface HttpStreamResponse {
	status: number;
	headers: Record<string, string>;
	/** Raw text chunks in arrival order. For non-streaming clients, one chunk. */
	chunks: AsyncIterable<string>;
	/** Resolves to the full body when the status is not 2xx (for error parsing). */
	errorText(): Promise<string>;
}

export interface HttpClient {
	readonly supportsStreaming: boolean;
	request(req: HttpRequest): Promise<HttpResponse>;
	stream(req: HttpRequest): Promise<HttpStreamResponse>;
}

export class FetchHttpClient implements HttpClient {
	readonly supportsStreaming = true;

	async request(req: HttpRequest): Promise<HttpResponse> {
		const res = await fetch(req.url, {
			method: req.method,
			headers: req.headers,
			body: req.body,
			signal: req.signal,
		});
		return { status: res.status, headers: headersToRecord(res.headers), text: await res.text() };
	}

	async stream(req: HttpRequest): Promise<HttpStreamResponse> {
		const res = await fetch(req.url, {
			method: req.method,
			headers: req.headers,
			body: req.body,
			signal: req.signal,
		});
		const headers = headersToRecord(res.headers);
		if (!res.ok || !res.body) {
			const text = await res.text();
			return {
				status: res.status,
				headers,
				chunks: (async function* () {
					yield text;
				})(),
				errorText: () => Promise.resolve(text),
			};
		}
		const body = res.body;
		return {
			status: res.status,
			headers,
			chunks: readBody(body, req.signal),
			errorText: () => Promise.resolve(''),
		};
	}
}

async function* readBody(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncIterable<string> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	const onAbort = () => {
		void reader.cancel().catch(() => undefined);
	};
	signal?.addEventListener('abort', onAbort, { once: true });
	try {
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			if (value) yield decoder.decode(value, { stream: true });
		}
		const tail = decoder.decode();
		if (tail) yield tail;
	} finally {
		signal?.removeEventListener('abort', onAbort);
		reader.releaseLock();
	}
}

function headersToRecord(headers: Headers): Record<string, string> {
	const out: Record<string, string> = {};
	headers.forEach((value, key) => {
		out[key.toLowerCase()] = value;
	});
	return out;
}

/**
 * Wraps a "whole body at once" requester (Obsidian's requestUrl) as an
 * HttpClient. Streams are emulated with a single chunk.
 */
export type WholeBodyRequester = (req: HttpRequest) => Promise<HttpResponse>;

export class RequestUrlHttpClient implements HttpClient {
	readonly supportsStreaming = false;

	constructor(private readonly requester: WholeBodyRequester) {}

	request(req: HttpRequest): Promise<HttpResponse> {
		return this.requester(req);
	}

	async stream(req: HttpRequest): Promise<HttpStreamResponse> {
		const res = await this.requester(req);
		return {
			status: res.status,
			headers: res.headers,
			chunks: (async function* () {
				yield res.text;
			})(),
			errorText: () => Promise.resolve(res.text),
		};
	}
}

/** Split an incoming chunk stream into complete lines (without line endings). */
export async function* splitLines(chunks: AsyncIterable<string>): AsyncIterable<string> {
	let buffer = '';
	for await (const chunk of chunks) {
		buffer += chunk;
		let idx: number;
		while ((idx = buffer.indexOf('\n')) >= 0) {
			let line = buffer.slice(0, idx);
			buffer = buffer.slice(idx + 1);
			if (line.endsWith('\r')) line = line.slice(0, -1);
			yield line;
		}
	}
	if (buffer.length > 0) yield buffer;
}

/** Parse newline-delimited JSON (Ollama). Blank lines are skipped. */
export async function* parseNdjson(chunks: AsyncIterable<string>): AsyncIterable<unknown> {
	for await (const line of splitLines(chunks)) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		yield JSON.parse(trimmed) as unknown;
	}
}

/**
 * Parse Server-Sent Events (OpenAI). Yields the `data:` payload of each event.
 * Multi-line data fields are joined with newlines per the SSE spec.
 */
export async function* parseSse(chunks: AsyncIterable<string>): AsyncIterable<string> {
	let data: string[] = [];
	for await (const line of splitLines(chunks)) {
		if (line === '') {
			if (data.length > 0) {
				yield data.join('\n');
				data = [];
			}
			continue;
		}
		if (line.startsWith(':')) continue; // comment / keepalive
		if (line.startsWith('data:')) {
			let payload = line.slice(5);
			if (payload.startsWith(' ')) payload = payload.slice(1);
			data.push(payload);
		}
		// `event:`, `id:`, `retry:` fields are ignored; chat APIs do not use them.
	}
	if (data.length > 0) yield data.join('\n');
}

/** Join a base URL and a path without doubling or dropping slashes. */
export function joinUrl(base: string, path: string): string {
	const b = base.replace(/\/+$/, '');
	const p = path.replace(/^\/+/, '');
	return `${b}/${p}`;
}

export async function drainText(chunks: AsyncIterable<string>): Promise<string> {
	let out = '';
	for await (const c of chunks) out += c;
	return out;
}
