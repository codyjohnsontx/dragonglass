import { HttpClient } from '../providers/http';
import { extractPageText } from './extract';

/**
 * Fetch one web page and return its readable text. The request carries no
 * key, cookie or other credential: only a URL a search returned is ever
 * fetched, and nothing of the user's goes with it. Addresses on this machine
 * or the local network (loopback, link-local, private ranges, localhost and
 * .local names) are refused, since results are untrusted. HTML is reduced to text
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
	let host;
	try {
		host = new URL(url).hostname;
	} catch {
		throw new PageFetchError(`${url} is not a valid web address.`);
	}
	if (isLocalHost(host)) throw new PageFetchError(`Pages on this computer or the local network cannot be read, not ${url}.`);
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

/** Loopback, unspecified, link-local, private (RFC 1918, IPv6 ULA) or a localhost/.local name. Takes a WHATWG URL hostname, so IPv4 is already in dotted form and IPv6 in brackets. */
export function isLocalHost(hostname: string): boolean {
	const host = hostname.toLowerCase().replace(/\.$/, '');
	if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
	const v4 = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(host);
	if (v4) return isLocalV4(Number(v4[1]), Number(v4[2]));
	if (!host.startsWith('[')) return false;
	const v6 = host.slice(1, -1);
	if (v6 === '::' || v6 === '::1') return true;
	const mapped = /^::ffff:([0-9a-f]{1,4}):[0-9a-f]{1,4}$/.exec(v6);
	if (mapped) {
		const high = parseInt(mapped[1] ?? '0', 16);
		return isLocalV4(high >> 8, high & 0xff);
	}
	return /^f[cd][0-9a-f]{2}:/.test(v6) || /^fe[89ab][0-9a-f]:/.test(v6);
}

function isLocalV4(a: number, b: number): boolean {
	return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function contentType(headers: Record<string, string>): string {
	for (const [k, v] of Object.entries(headers)) {
		if (k.toLowerCase() === 'content-type') return (v.split(';')[0] ?? '').trim().toLowerCase();
	}
	return '';
}
