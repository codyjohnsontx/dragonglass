import { HttpClient } from '../providers/http';

/**
 * The web search service behind the web_search tool. Dragonglass runs the
 * search itself, the same way whichever chat provider is active, so a local
 * Ollama model searches exactly as a cloud model does. The interface is
 * small on purpose: switching to another service (Exa takes the same query,
 * domain list and result count) means one new file.
 */
export interface WebSearchService {
	search(req: WebSearchQuery, signal?: AbortSignal): Promise<WebSearchHit[]>;
}

export interface WebSearchQuery {
	query: string;
	/** Search only these sites (hostnames). Empty searches the whole web. */
	includeDomains: string[];
	maxResults: number;
}

export interface WebSearchHit {
	title: string;
	url: string;
	/** The service's relevance snippet: untrusted text from the page. */
	snippet: string;
}

export type WebSearchErrorKind = 'auth' | 'rate_limit' | 'quota' | 'bad_request' | 'server' | 'network';

export class WebSearchError extends Error {
	constructor(
		readonly kind: WebSearchErrorKind,
		message: string,
		readonly status?: number,
	) {
		super(message);
		this.name = 'WebSearchError';
	}
}

export const TAVILY_BASE_URL = 'https://api.tavily.com';

/** Snippets longer than this are cut; the page itself can be read with read_web_page. */
const MAX_SNIPPET_CHARS = 600;

export interface TavilyConfig {
	/** API root; `/search` hangs off it. */
	baseUrl: string;
	/** Read at request time from Obsidian's SecretStorage; never stored. */
	apiKey: () => string | null;
}

/**
 * Tavily's search API (https://docs.tavily.com/documentation/api-reference/endpoint/search):
 * a bearer key, one credit per basic search, `include_domains` restricting
 * results to the given sites (its default `restrict` mode).
 */
export class TavilySearch implements WebSearchService {
	constructor(
		private readonly http: HttpClient,
		private readonly config: () => TavilyConfig,
	) {}

	async search(req: WebSearchQuery, signal?: AbortSignal): Promise<WebSearchHit[]> {
		const { baseUrl, apiKey } = this.config();
		const key = apiKey()?.trim();
		if (!key) throw new WebSearchError('auth', 'No Tavily API key is set. Add one under Settings → Dragonglass AI → Web search.');
		const body: Record<string, unknown> = {
			query: req.query,
			search_depth: 'basic',
			max_results: req.maxResults,
			include_answer: false,
			include_raw_content: false,
			include_images: false,
		};
		if (req.includeDomains.length > 0) body['include_domains'] = req.includeDomains;
		let res;
		try {
			res = await this.http.request({
				url: `${baseUrl.replace(/\/+$/, '')}/search`,
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
				body: JSON.stringify(body),
				signal,
			});
		} catch (e) {
			throw new WebSearchError('network', `Could not reach Tavily: ${e instanceof Error ? e.message : String(e)}`);
		}
		if (res.status < 200 || res.status >= 300) throw tavilyError(res.status, res.text, res.headers);
		let parsed: unknown;
		try {
			parsed = JSON.parse(res.text);
		} catch {
			throw new WebSearchError('server', 'Tavily sent a reply that is not JSON.', res.status);
		}
		const results = (parsed as { results?: unknown } | null)?.results;
		if (!Array.isArray(results)) throw new WebSearchError('server', 'Tavily sent a reply without results.', res.status);
		const hits: WebSearchHit[] = [];
		for (const r of results) {
			if (!r || typeof r !== 'object') continue;
			const v = r as Record<string, unknown>;
			const url = typeof v['url'] === 'string' ? v['url'].trim() : '';
			if (!/^https?:\/\//i.test(url)) continue;
			const title = typeof v['title'] === 'string' ? v['title'].replace(/\s+/g, ' ').trim() : '';
			const content = typeof v['content'] === 'string' ? v['content'].replace(/\s+/g, ' ').trim() : '';
			hits.push({ url, title: title || url, snippet: content.length > MAX_SNIPPET_CHARS ? `${content.slice(0, MAX_SNIPPET_CHARS)}…` : content });
			if (hits.length >= req.maxResults) break;
		}
		return hits;
	}
}

function tavilyError(status: number, text: string, headers: Record<string, string>): WebSearchError {
	const detail = errorDetail(text);
	const suffix = detail ? ` (${detail})` : '';
	if (status === 401 || status === 403) {
		return new WebSearchError('auth', `Tavily rejected the API key${suffix}. Check the key under Settings → Dragonglass AI → Web search.`, status);
	}
	if (status === 429) {
		const retry = Number(headerValue(headers, 'retry-after'));
		const wait = Number.isFinite(retry) && retry > 0 ? ` Try again in ${Math.ceil(retry)} seconds.` : ' Try again in a minute.';
		return new WebSearchError('rate_limit', `Tavily is rate limiting searches.${wait}`, status);
	}
	if (status === 432 || status === 433) {
		return new WebSearchError('quota', `The Tavily plan's search credits are used up${suffix}. They renew monthly; see your Tavily dashboard.`, status);
	}
	if (status >= 500) return new WebSearchError('server', `Tavily had a server error (HTTP ${status}). Try again later.`, status);
	return new WebSearchError('bad_request', `Tavily refused the search (HTTP ${status})${suffix}.`, status);
}

/** Tavily puts the reason in `detail.error`; tolerate a plain `detail` or `error` string too. */
function errorDetail(text: string): string {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return '';
	}
	if (!parsed || typeof parsed !== 'object') return '';
	const p = parsed as Record<string, unknown>;
	const detail = p['detail'];
	const raw =
		detail && typeof detail === 'object' ? (detail as Record<string, unknown>)['error'] : typeof detail === 'string' ? detail : p['error'] ?? p['message'];
	return typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim().slice(0, 200) : '';
}

function headerValue(headers: Record<string, string>, name: string): string | undefined {
	for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === name) return v;
	return undefined;
}

/**
 * The preferred-sites setting as Tavily domains: one per line (commas and
 * spaces also separate), a pasted URL reduced to its host, duplicates and
 * anything that is not a host name dropped. Tavily takes at most 300.
 */
export function parsePreferredSites(raw: string): string[] {
	const out: string[] = [];
	for (const part of raw.split(/[\s,]+/)) {
		let host = part.trim().toLowerCase();
		if (!host || host.startsWith('#')) continue;
		host = host.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/[/?#].*$/, '').replace(/:\d+$/, '').replace(/\.$/, '');
		if (!/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/.test(host)) continue;
		if (!out.includes(host)) out.push(host);
		if (out.length >= 300) break;
	}
	return out;
}
