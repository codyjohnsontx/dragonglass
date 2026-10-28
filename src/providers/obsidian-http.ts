import { requestUrl } from 'obsidian';
import { HttpClient, HttpRequest, HttpResponse, RequestUrlHttpClient } from './http';

/** HttpClient built on Obsidian's requestUrl (no CORS, no streaming). */
export function createRequestUrlClient(): HttpClient {
	return new RequestUrlHttpClient(async (req: HttpRequest): Promise<HttpResponse> => {
		const res = await requestUrl({
			url: req.url,
			method: req.method,
			headers: req.headers,
			body: req.body,
			contentType: req.headers?.['Content-Type'],
			throw: false,
		});
		return { status: res.status, headers: res.headers, text: res.text };
	});
}
