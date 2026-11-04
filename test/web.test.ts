import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildSystemPrompt } from '../src/agent/context';
import { runAgent, RunEvent } from '../src/agent/runtime';
import { answerSources, WebSource } from '../src/agent/sources';
import { ToolRegistry } from '../src/agent/tools';
import { StoredMessage } from '../src/persistence/conversation';
import { FetchHttpClient, HttpClient, HttpRequest } from '../src/providers/http';
import { OllamaProvider } from '../src/providers/ollama';
import { mergeSettings } from '../src/settings';
import { createWebTools, nextWebNumber, PAGES_PER_SEARCH, WebSearchApprover, WebSearchRequest, WebToolOptions } from '../src/tools/web-tools';
import { extractPageText } from '../src/web/extract';
import { fetchPageText, isLocalHost, PageFetchError } from '../src/web/pages';
import { buildResearchNote, noteTitle, researchNoteFor } from '../src/web/research-note';
import { parsePreferredSites, TavilySearch, WebSearchError } from '../src/web/search';
// @ts-expect-error plain JS module
import { PAGES_ORIGIN, startFakeServer } from './fake-server/server.mjs';

interface Fake {
	baseUrl: string;
	requests: Array<{ method: string; url: string; headers: Record<string, string>; body: Record<string, unknown> | null }>;
	close: () => Promise<void>;
}

let fake: Fake;
beforeAll(async () => {
	fake = (await startFakeServer()) as Fake;
});
afterAll(() => fake.close());
beforeEach(() => {
	fake.requests.length = 0;
});

const http = new FetchHttpClient();
const PAGES = PAGES_ORIGIN as string;
/** Page reads go to the fake server's /pages, standing in for the public site its Tavily results name. */
const toFake = (req: HttpRequest): HttpRequest => ({ ...req, url: req.url.replace(PAGES, fake.baseUrl) });
const web: HttpClient = { supportsStreaming: true, request: (req) => http.request(toFake(req)), stream: (req) => http.stream(toFake(req)) };
const tavily = (key: string | null = 'tvly-fake') => new TavilySearch(http, () => ({ baseUrl: `${fake.baseUrl}/tavily`, apiKey: () => key }));
const searches = () => fake.requests.filter((r) => r.url === '/tavily/search');
const pageRequests = () => fake.requests.filter((r) => r.url.startsWith('/pages/'));
const ctx = () => ({ conversationId: 'c', signal: new AbortController().signal });

/** An approver that records what it was asked and answers as told. */
function approver(answer: (req: WebSearchRequest) => string | null = (req) => req.query) {
	const asked: WebSearchRequest[] = [];
	const approve: WebSearchApprover = (req) => {
		asked.push(req);
		const query = answer(req);
		return Promise.resolve(query === null ? { approved: false } : { approved: true, query });
	};
	return { asked, approve };
}

function tools(overrides: Partial<WebToolOptions> = {}) {
	const registry = new ToolRegistry();
	for (const t of createWebTools({
		search: tavily(),
		http: web,
		approve: approver().approve,
		preferredSites: () => [],
		maxPageChars: 6000,
		firstNumber: 1,
		...overrides,
	})) {
		registry.register(t);
	}
	return { search: registry.get('web_search')!, read: registry.get('read_web_page')! };
}

describe('extractPageText', () => {
	it('keeps the article text and drops scripts, styles, navigation and footers', () => {
		const html = `<html><head><title>Kael &amp; co</title><style>p{}</style></head><body>
			<nav><a href="/">Home</a> <a href="/x">Random page</a></nav>
			<main><h1>Kael</h1><p>He distrusts the Council&nbsp;and speaks rarely&mdash;in orders.</p>
			<script>var hidden = "tracking";</script>
			<ul><li>Loyal</li><li>Quick to anger</li></ul><p>Called &quot;the Last Ember&quot; &#8212; &#x263A;</p>
			${'<p>More lore about Kael and the Ember Guard.</p>'.repeat(5)}</main>
			<footer>Terms</footer></body></html>`;
		const page = extractPageText(html);
		expect(page.title).toBe('Kael & co');
		expect(page.text).toContain('# Kael');
		expect(page.text).toContain('He distrusts the Council and speaks rarely—in orders.');
		expect(page.text).toContain('- Loyal\n- Quick to anger');
		expect(page.text).toContain('Called "the Last Ember" — ☺');
		expect(page.text).not.toMatch(/tracking|Random page|Terms|p\{\}/);
	});

	it('uses the whole body when there is no main element, dropping link-heavy navigation but not prose that has a link', () => {
		const html = `<body><nav><a href="/a">A</a><a href="/b">B</a></nav><header><p>The saga of <a href="/k">Kael</a> begins in the north, long before the war.</p></header><p>Body text.</p></body>`;
		const { text } = extractPageText(html);
		expect(text).toBe('The saga of Kael begins in the north, long before the war.\n\nBody text.');
	});

	it('keeps the text of a page wrapped in one form, dropping only its controls', () => {
		const html = `<body><form id="aspnetForm" action="/x"><main><p>${'Kael led the Ember Guard north. '.repeat(10)}</p>
			<label>Search <input name="q"></label><textarea>draft comment</textarea><select><option>Sort</option></select><button>Go</button></main></form></body>`;
		const { text } = extractPageText(html);
		expect(text).toContain('Kael led the Ember Guard north.');
		expect(text).not.toMatch(/draft comment|Sort|Go/);
	});

	it('survives unclosed tags and comments without hanging', () => {
		expect(extractPageText('<p>One<!-- hidden --> two<script>never closed').text).toBe('One two');
		expect(extractPageText('<div>broken <b>bold').text).toBe('broken bold');
	});
});

describe('fetchPageText', () => {
	it('reads HTML and plain text and refuses other content types', async () => {
		const lore = await fetchPageText(web, `${PAGES}/pages/lore.html`);
		expect(lore.title).toBe('Kael & the Ember Guard - Lore Wiki');
		expect(lore.text).toContain('Kael is the exiled captain of the Ember Guard.');
		expect(lore.text).not.toContain('window.track');
		expect((await fetchPageText(web, `${PAGES}/pages/plain.txt`)).text).toBe('Year 1: Ashfall founded.\nYear 90: Ashfall falls.');
		await expect(fetchPageText(web, `${PAGES}/pages/doc.pdf`)).rejects.toThrow(/application\/pdf/);
		await expect(fetchPageText(web, `${PAGES}/pages/missing.html`)).rejects.toThrow(/HTTP 404/);
		expect((await fetchPageText(web, `${PAGES}/pages/script.html`)).text).toBe('');
		await expect(fetchPageText(web, 'file:///etc/passwd')).rejects.toBeInstanceOf(PageFetchError);
	});

	it('refuses addresses on this computer or the local network without requesting them', async () => {
		for (const url of [
			`${fake.baseUrl}/pages/lore.html`,
			'http://localhost:11434/api/tags',
			'http://router.local/',
			'http://LOCALHOST./',
			'http://10.0.0.1/',
			'http://172.20.1.1/',
			'http://192.168.1.1/admin',
			'http://169.254.169.254/latest/meta-data',
			'http://0.0.0.0:8080/',
			'http://2130706433/',
			'http://[::1]/',
			'http://[::ffff:127.0.0.1]/',
			'http://[fd12:3456::1]/',
			'http://[fe80::1]/',
		]) {
			await expect(fetchPageText(http, url), url).rejects.toThrow(/local network cannot be read/);
		}
		expect(pageRequests()).toHaveLength(0);
		for (const host of ['lore.example', '172.32.0.1', '192.169.0.1', '8.8.8.8', '[2001:db8::1]', '[fc::1]', 'localhost.example']) expect(isLocalHost(host), host).toBe(false);
	});
});

describe('TavilySearch', () => {
	it('sends the key as a bearer token and the preferred sites only when there are some', async () => {
		const hits = await tavily().search({ query: 'kael', includeDomains: [], maxResults: 5 });
		expect(hits).toHaveLength(5);
		expect(hits[0]).toEqual({ title: 'Kael - Lore Wiki', url: `${PAGES}/pages/lore.html`, snippet: expect.stringContaining('exiled captain') });
		await tavily().search({ query: 'kael', includeDomains: ['lore.example'], maxResults: 3 });
		const [plain, restricted] = searches();
		expect(plain?.headers['authorization']).toBe('Bearer tvly-fake');
		expect(plain?.body).toMatchObject({ query: 'kael', max_results: 5, search_depth: 'basic', include_raw_content: false });
		expect(plain?.body).not.toHaveProperty('include_domains');
		expect(restricted?.body).toMatchObject({ include_domains: ['lore.example'], max_results: 3 });
	});

	it('reports a missing key without calling Tavily, and a bad key, rate limit and used-up credits clearly', async () => {
		await expect(tavily(null).search({ query: 'kael', includeDomains: [], maxResults: 5 })).rejects.toMatchObject({ kind: 'auth', message: expect.stringContaining('Settings') });
		expect(searches()).toHaveLength(0);
		const failure = (key: string, query: string) => tavily(key).search({ query, includeDomains: [], maxResults: 5 }).catch((e: unknown) => e as WebSearchError);
		expect(await failure('tvly-wrong', 'kael')).toMatchObject({ kind: 'auth', status: 401, message: expect.stringContaining('invalid API key') });
		expect(await failure('tvly-fake', 'ratelimit')).toMatchObject({ kind: 'rate_limit', status: 429, message: expect.stringContaining('30 seconds') });
		expect(await failure('tvly-fake', 'credits')).toMatchObject({ kind: 'quota', status: 432 });
	});
});

describe('parsePreferredSites', () => {
	it('takes hosts from lines, commas and pasted URLs, and drops junk and duplicates', () => {
		expect(parsePreferredSites('https://Elden.Fandom.com/wiki/Melina\nfextralife.com, fextralife.com\n# comment\nnot a site\nlocalhost')).toEqual([
			'elden.fandom.com',
			'fextralife.com',
		]);
		expect(parsePreferredSites('')).toEqual([]);
	});
});

describe('web_search', () => {
	it('waits for approval and runs nothing when the user declines', async () => {
		const { asked, approve } = approver(() => null);
		const { search } = tools({ approve, preferredSites: () => ['lore.example'] });
		const result = await search.execute({ query: 'kael personality' }, ctx());
		expect(asked).toEqual([{ query: 'kael personality', sites: ['lore.example'] }]);
		expect(result.content).toMatch(/declined/);
		expect(result.sources).toBeUndefined();
		expect(searches()).toHaveLength(0);
	});

	it('runs the words the user edited and tells the model they changed', async () => {
		const { approve } = approver(() => 'Kael Ember Guard captain');
		const { search } = tools({ approve });
		const result = await search.execute({ query: 'kael' }, ctx());
		expect(searches()[0]?.body).toMatchObject({ query: 'Kael Ember Guard captain' });
		expect(result.content).toContain('Web search for "Kael Ember Guard captain" (the user changed it from "kael")');
	});

	it('numbers results from firstNumber, wraps them as untrusted, and reports them as web sources', async () => {
		const { search } = tools({ firstNumber: 4 });
		const result = await search.execute({ query: 'kael' }, ctx());
		expect(result.content).toContain('untrusted');
		expect(result.content).toContain(`<<<web result n="4" url="${PAGES}/pages/lore.html" title="Kael - Lore Wiki">>>`);
		expect(result.sources?.map((s) => (s.kind === 'web' ? s.n : 0))).toEqual([4, 5, 6, 7, 8]);
	});

	it('searches the preferred sites first and widens to the whole web only when they have nothing', async () => {
		const { search } = tools({ preferredSites: () => ['lore.example'] });
		const found = await search.execute({ query: 'kael' }, ctx());
		expect(searches().map((r) => r.body?.['include_domains'])).toEqual([['lore.example']]);
		expect(found.content).toContain("Searched the user's preferred sites (lore.example).");

		fake.requests.length = 0;
		const widened = await search.execute({ query: 'widen kael' }, ctx());
		expect(searches().map((r) => r.body?.['include_domains'])).toEqual([['lore.example'], undefined]);
		expect(widened.content).toContain('Nothing turned up on the user\'s preferred sites (lore.example), so these results are from the whole web.');
		expect(widened.sources).toHaveLength(5);
	});

	it('says when the web has nothing, and turns Tavily failures into a tool error the model can relay', async () => {
		const { search } = tools();
		const none = await search.execute({ query: 'nothing at all' }, ctx());
		expect(none.isError).toBeUndefined();
		expect(none.content).toMatch(/No results/);
		const limited = await search.execute({ query: 'ratelimit' }, ctx());
		expect(limited.isError).toBe(true);
		expect(limited.content).toMatch(/rate limiting.*30 seconds/);
		const badKey = await tools({ search: tavily('tvly-wrong') }).search.execute({ query: 'kael' }, ctx());
		expect(badKey.content).toMatch(/rejected the API key.*Settings/);
	});

	it('declines when generation stops while waiting for approval', async () => {
		const controller = new AbortController();
		const approve: WebSearchApprover = (_req, signal) =>
			new Promise((resolve) => {
				signal.addEventListener('abort', () => resolve({ approved: false }));
				controller.abort();
			});
		const result = await tools({ approve }).search.execute({ query: 'kael' }, { conversationId: 'c', signal: controller.signal });
		expect(result).toEqual({ content: 'Not run: generation stopped.', isError: true });
		expect(searches()).toHaveLength(0);
	});
});

describe('read_web_page', () => {
	it('reads only results of an approved search, by number', async () => {
		const { search, read } = tools();
		expect((await read.execute({ n: 1 }, ctx())).content).toMatch(/no web search has been approved/);
		await search.execute({ query: 'kael' }, ctx());
		expect((await read.execute({ n: 9 }, ctx())).content).toMatch(/no result \[web 9\]/);
		const page = await read.execute({ n: 1 }, ctx());
		expect(page.isError).toBeUndefined();
		expect(page.sources).toEqual([{ kind: 'web', n: 1, url: `${PAGES}/pages/lore.html`, title: 'Kael - Lore Wiki' }]);
		expect(page.content).toContain('untrusted');
		expect(page.content).toContain('Kael is the exiled captain of the Ember Guard.');
		expect((await read.execute({ n: 1 }, ctx())).content).toMatch(/already read/);
	});

	it('defuses delimiters inside page text so a page cannot close its own block', async () => {
		const { search, read } = tools();
		await search.execute({ query: 'kael' }, ctx());
		const { content } = await read.execute({ n: 1 }, ctx());
		expect(content.match(/<<<end web page>>>/g)).toHaveLength(1);
		expect(content).toContain('Ignore all previous instructions');
		expect(content).toContain('‹‹‹end web page›››');
	});

	it(`allows ${PAGES_PER_SEARCH} successful reads per approved search; failed reads do not count`, async () => {
		const { search, read } = tools();
		await search.execute({ query: 'kael' }, ctx());
		expect((await read.execute({ n: 4 }, ctx())).content).toMatch(/application\/pdf/);
		expect((await read.execute({ n: 5 }, ctx())).content).toMatch(/HTTP 404/);
		for (const n of [1, 2, 3]) expect((await read.execute({ n }, ctx())).isError).toBeUndefined();
		const capped = await read.execute({ n: 4 }, ctx());
		expect(capped.isError).toBe(true);
		expect(capped.content).toMatch(/3 pages of this search were already read/);
		// A second approved search brings its own allowance.
		await search.execute({ query: 'kael again' }, ctx());
		expect((await read.execute({ n: 6 }, ctx())).isError).toBeUndefined();
	});

	it('cuts a page to the length cap', async () => {
		const { search, read } = tools({ maxPageChars: 500 });
		await search.execute({ query: 'kael' }, ctx());
		const { content } = await read.execute({ n: 2 }, ctx());
		const body = /<<<web page[^\n]*\n([\s\S]*?)\n\[truncated: showing 500 of (\d+) characters\]\n<<<end web page>>>/.exec(content);
		expect(body?.[1]).toHaveLength(500);
		expect(Number(body?.[2])).toBeGreaterThan(100_000);
	});

	it('never sends the Tavily key or any credential to a page', async () => {
		const { search, read } = tools();
		await search.execute({ query: 'kael' }, ctx());
		await read.execute({ n: 1 }, ctx());
		expect(pageRequests()).toHaveLength(1);
		expect(pageRequests()[0]?.headers['authorization']).toBeUndefined();
		expect(pageRequests()[0]?.headers['cookie']).toBeUndefined();
	});
});

describe('web search in a turn', () => {
	it('runs search, page read and a cited answer through the agent loop against Ollama', async () => {
		const { asked, approve } = approver();
		const registry = new ToolRegistry();
		for (const t of createWebTools({ search: tavily(), http: web, approve, preferredSites: () => [], maxPageChars: 6000, firstNumber: 1 })) registry.register(t);
		const provider = new OllamaProvider(http, () => ({ baseUrl: fake.baseUrl, model: 'fake-tools', numCtx: 16384, think: false }));
		const events: RunEvent[] = [];
		for await (const ev of runAgent({
			provider,
			model: 'fake-tools',
			system: (toolsEnabled) => buildSystemPrompt({ toolsEnabled, maxCharsPerNote: 20000, webSearch: 'available' }),
			messages: [{ role: 'user', content: 'web kael personality' }],
			tools: registry,
			toolsEnabled: true,
			conversationId: 'c',
			signal: new AbortController().signal,
			maxIterations: 8,
		})) {
			events.push(ev);
		}
		expect(asked).toEqual([{ query: 'kael personality', sites: [] }]);
		const results = events.flatMap((e) => (e.type === 'tool_result' ? [e] : []));
		expect(results.map((r) => r.call.name)).toEqual(['web_search', 'read_web_page']);
		const answer = events.filter((e) => e.type === 'assistant_end').pop();
		expect(answer?.type === 'assistant_end' && answer.content).toContain('[web 1]');
		const chat = fake.requests.find((r) => r.url === '/api/chat');
		const toolNames = (chat?.body?.['tools'] as Array<{ function: { name: string } }>).map((t) => t.function.name);
		expect(toolNames).toEqual(['web_search', 'read_web_page']);
	});
});

describe('system prompt', () => {
	it('describes web search when it is available and how to set it up when no key is set', () => {
		const on = buildSystemPrompt({ toolsEnabled: true, maxCharsPerNote: 100, webSearch: 'available' });
		expect(on).toContain('[web 2]');
		expect(on).toContain('untrusted text from the internet');
		expect(on).toContain('web_search only when the vault does not have');
		const off = buildSystemPrompt({ toolsEnabled: true, maxCharsPerNote: 100, webSearch: 'needs-key' });
		expect(off).toContain('Web search is not set up');
		expect(off).toContain('Settings → Dragonglass AI → Web search');
		expect(off).not.toContain('web_search');
		expect(off).not.toContain('[web');
		// The tool-free request that ends a long turn still cites this turn's results.
		expect(buildSystemPrompt({ toolsEnabled: false, maxCharsPerNote: 100, webSearch: 'available' })).toContain('[web 2]');
	});
});

describe('web numbering across a conversation', () => {
	const w = (n: number): WebSource => ({ kind: 'web', n, url: `https://lore.example/${n}`, title: `Page ${n}` });
	let seq = 0;
	const msg = (role: StoredMessage['role'], content: string, extra: Partial<StoredMessage> = {}): StoredMessage => ({ id: `w${++seq}`, role, content, createdAt: 0, ...extra });

	it('starts a new search after the highest number already shown', () => {
		expect(nextWebNumber([undefined, [{ kind: 'vault', path: 'a.md', seen: 'full' }]])).toBe(1);
		expect(nextWebNumber([[w(1), w(2)], undefined, [w(7)]])).toBe(8);
	});

	it('lets a later turn cite a page an earlier turn found', () => {
		const messages = [
			msg('user', 'q1', { sources: [] }),
			msg('assistant', '', { toolCalls: [{ id: 't', name: 'web_search', argumentsJson: '{}' }] }),
			msg('tool', 'results', { toolCallId: 't', sources: [w(1), w(2)] }),
			msg('assistant', 'First [web 1].'),
			msg('user', 'q2', { sources: [] }),
			msg('assistant', 'As found before [web 2]; unknown [web 9].'),
		];
		const { lists } = answerSources(messages, {}, () => null);
		expect(lists.get(messages[5]!.id)?.web).toEqual([
			{ n: 2, source: w(2) },
			{ n: 9, source: null },
		]);
	});
});

describe('research note', () => {
	const cited = [
		{ kind: 'web' as const, n: 1, url: 'https://lore.example/kael', title: 'Kael [Wiki] <iframe src=x>' },
		{ kind: 'web' as const, n: 3, url: 'https://lore.example/a>b', title: '' },
	];

	it('builds a note with a from-the-web marker, the date, the sources and linked markers', () => {
		const note = buildResearchNote({
			question: 'What is Kael\'s personality? [spoilers]',
			answer: 'Kael distrusts the Council [web 1] and grew up in [[Ashfall]] [web 3].',
			cited,
			webSources: cited,
			date: new Date(2026, 10, 4),
			exists: (p) => p === 'Web research/What is Kael\'s personality spoilers.md',
		});
		expect(note.path).toBe('Web research/What is Kael\'s personality spoilers 2.md');
		expect(note.content).toContain('---\nfrom-web: true\nresearched: 2026-11-04\nquestion: "What is Kael\'s personality? [spoilers]"\nsources:\n  - "https://lore.example/kael"\n  - "https://lore.example/a>b"\n---\n');
		expect(note.content).toContain('# What is Kael\'s personality spoilers');
		expect(note.content).toContain('Kael distrusts the Council [web 1](<https://lore.example/kael>) and grew up in [[Ashfall]] [web 3](<https://lore.example/a%3Eb>).');
		expect(note.content).toContain('## Sources\n\n- [web 1] [Kael \\[Wiki\\] &lt;iframe src=x>](<https://lore.example/kael>)\n- [web 3] [https://lore.example/a>b](<https://lore.example/a%3Eb>)');
	});

	it('names the note from the question, safely and briefly', () => {
		expect(noteTitle('  \n')).toBe('Web research');
		expect(noteTitle('a/b:c*?d|e#f^g')).toBe('a b c d e f g');
		expect(noteTitle('Tell me everything about the long and storied history of the Ember Guard and its captains').length).toBeLessThanOrEqual(60);
	});

	it('is offered only for an answer that cites a web page a search returned', () => {
		let seq = 0;
		const msg = (role: StoredMessage['role'], content: string, extra: Partial<StoredMessage> = {}): StoredMessage => ({ id: `r${++seq}`, role, content, createdAt: 0, ...extra });
		const messages = [
			msg('user', 'Who is Kael?', { sources: [] }),
			msg('assistant', '', { toolCalls: [{ id: 't', name: 'web_search', argumentsJson: '{}' }] }),
			msg('tool', 'results', { toolCallId: 't', sources: [cited[0]!] }),
			msg('assistant', 'Kael is a captain [web 1].'),
			msg('user', 'And Mira?', { sources: [] }),
			msg('assistant', 'Unknown [web 4].'),
		];
		const note = researchNoteFor(messages, {}, messages[3]!.id, () => null, () => false, new Date(2026, 0, 2));
		expect(note?.path).toBe('Web research/Who is Kael.md');
		expect(note?.content).toContain('question: "Who is Kael?"');
		expect(researchNoteFor(messages, {}, messages[5]!.id, () => null, () => false, new Date())).toBeNull();
		expect(researchNoteFor(messages, {}, messages[0]!.id, () => null, () => false, new Date())).toBeNull();
	});
});

describe('web search settings', () => {
	it('defaults to no key, no preferred sites and the Tavily API, and keeps stored values', () => {
		expect(mergeSettings({}).webSearch).toEqual({ apiKeySecretId: '', preferredSites: '', baseUrl: 'https://api.tavily.com' });
		expect(mergeSettings({ webSearch: { apiKeySecretId: 'tavily', preferredSites: 'a.example', baseUrl: 7 } }).webSearch).toEqual({
			apiKeySecretId: 'tavily',
			preferredSites: 'a.example',
			baseUrl: 'https://api.tavily.com',
		});
	});
});
