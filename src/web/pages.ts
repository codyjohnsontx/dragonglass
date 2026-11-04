import { HttpClient } from '../providers/http';
import { extractPageText } from './extract';

/**
 * Fetch one web page and return its readable text. The request carries no
 * key, cookie or other credential: only a URL a search returned is ever
 * fetched, and nothing of the user's goes with it. HTML is reduced to text
 * in-house (`extractPageText`); plain text is used as it is; anything else
 * (PDFs, images, JSON) is refused with a reason the model can relay.
 */

export interface FetchedPage {
	title: string;
	text: string;
}

export class PageFetchError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'PageFetchError';
	}
}

export async function fetchPageText(http: HttpClient, url: string, signal?: AbortSignal): Promise<FetchedPage> {
	if (!/^https?:\/\//i.test(url)) throw new PageFetchError(`Only http and https pages can be read, not ${url}.`);
	let res;
	try {
		res = await http.request({
			url,
			method: 'GET',
			headers: { Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1' },
			signal,
		});
	} catch (e) {
		throw new PageFetchError(`Could not reach the page: ${e instanceof Error ? e.message : String(e)}`);
	}
	if (res.status < 200 || res.status >= 300) throw new PageFetchError(`The page answered HTTP ${res.status}.`);
	const type = contentType(res.headers);
	const html = type === 'text/html' || type === 'application/xhtml+xml' || (type === '' && /^\s*(?:<!doctype html|<html\b)/i.test(res.text));
	if (html) return extractPageText(res.text);
	if (type === 'text/plain' || type === 'text/markdown' || type === '') return { title: '', text: res.text.replace(/\r\n?/g, '\n').trim() };
	throw new PageFetchError(`The page is ${type}, not text Dragonglass can read.`);
}

function contentType(headers: Record<string, string>): string {
	for (const [k, v] of Object.entries(headers)) {
		if (k.toLowerCase() === 'content-type') return (v.split(';')[0] ?? '').trim().toLowerCase();
	}
	return '';
}
