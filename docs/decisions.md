# Decision record

Short entries, newest last. Each states the choice and why.

## 1. Plugin-local runtime, no backend

Everything runs in the Obsidian renderer. A hosted service would contradict
local-first and BYOM, add an account, and give us nothing the renderer cannot
do. Revisit only if a provider cannot be reached from the renderer at all.

## 2. Zero runtime dependencies

The bundle has no runtime npm dependencies. The line diff, SSE/NDJSON parsing,
JSON-schema argument validation and path checks are small, well-tested
in-house modules. Options considered: `diff` (jsdiff), `zod`, provider SDKs.
Rejected because each adds bundle weight and supply-chain surface for a plugin
that ships as one `main.js`, and the provider SDKs assume Node or bring their
own HTTP layer that fights Obsidian's CORS and `requestUrl` story. Vitest is
the only test dependency.

## 3. `fetch` for streaming, `requestUrl` as fallback

Obsidian's `requestUrl` bypasses CORS but returns whole bodies, so it cannot
stream. Streaming matters for a chat UI, so the default transport is `fetch`.
Ollama allows the `app://` origin by default and OpenAI and Gemini send
permissive CORS headers, so this works out of the box. Anthropic allows
browser-origin requests only with the `anthropic-dangerous-direct-browser-access`
header; the plugin sends it because the key is the user's own and never
leaves their machine except to Anthropic. Users behind a stricter Ollama config
can switch to the `requestUrl` transport in settings and lose streaming only.

## 4. Secrets in Obsidian SecretStorage

Obsidian 1.11.4 added `SecretStorage` (OS keychain backed) and 1.13.2 added
the declarative `secret` setting control. Settings store only the secret id.
This sets `minAppVersion` to 1.13.2, which is acceptable for a new plugin and
avoids ever writing a key into `data.json`.

## 5. Write tools only propose

The model cannot write. `propose_*` tools compute the full new content, hash
the current content, and hand a proposal to the UI. Apply happens only on user
approval and re-verifies the hash plus the content inside the atomic
`Vault.process` callback. This gives preview, approval, conflict detection and
rollback (snapshot) with one code path.

## 6. Tool calls validated against JSON schema in-house

Tool arguments from the model are validated against each tool's schema
(types, required, enums, integer bounds, nested arrays/objects) before
execution. Invalid calls are reported back to the model as tool errors rather
than aborting the turn, which lets capable models self-correct.

## 7. One JSON file per conversation

Conversations are stored as individual files under the plugin folder rather
than inside `data.json`. A corrupt or huge conversation cannot block settings
load, and writes are proportional to the active conversation. Files are
sanitized on load; malformed ones are skipped.

## 8. Declarative settings tab

The settings tab uses `getSettingDefinitions()` (1.13+) so settings are
searchable in Obsidian's settings search and validation is consistent. Nested
provider settings are addressed by dotted keys through
`getControlValue`/`setControlValue`.

## 9. Ollama tool support probed, not assumed

Ollama returns HTTP 400 for models without tool support. The adapter maps that
to `unsupported_tools`; the runtime retries once without tools and tells the
user. Capability is therefore `'unknown'` rather than a hardcoded model list
that would go stale.

## 10. Fake provider server for tests and in-app checks

Adapters are tested over real HTTP against a small Node server that speaks the
Ollama, OpenAI, Anthropic and Gemini wire formats with scripted behaviour, and
rejects the request shapes the real Anthropic, Gemini and OpenAI Responses APIs reject. The same server backs
the in-app end-to-end check, so the chat, tool loop, diff and apply path were
exercised in a real Obsidian instance without a live model.

## 11. Provider differences live in adapters, history stays neutral

Anthropic and Gemini were added without changing the runtime or the stored
conversation format. Each adapter converts the neutral `ChatMessage` history
to its wire format on every request (merging turns, moving the system prompt,
sanitizing foreign tool-call ids, stripping unsupported schema keys), so a
conversation can move between providers at any point. The only provider state
stored on a message is Gemini's thought signature on `ToolCall.signature`;
for tool calls another provider made, the Gemini adapter sends Google's
documented placeholder signature (`skip_thought_signature_validator`).

## 12. Anthropic output cap is a setting

The Messages API requires `max_tokens` on every request and the right value
depends on the model. It is a user setting (default 8192) rather than a
hardcoded per-model table that would go stale. Gemini and OpenAI need no cap.

## 13. OpenAI Responses API stateless, per model

GPT-6.1 Sol and Terra take tool calls only through the Responses API, so the
OpenAI adapter sends those models (and any model whose Chat Completions tool
error points at `/v1/responses`) there and keeps everything else, including
the custom endpoint, on Chat Completions. Requests are stateless
(`store: false`, full history as input items each turn) rather than chained
with `previous_response_id`, which would keep conversations on OpenAI's
servers and tie history to one provider. Reasoning items are not replayed:
keeping their encrypted content would mean storing provider state on messages
(decision 11), and without it the model reasons afresh at each tool step, as
it does over Chat Completions. Function tools are sent with `strict: false`
because strict mode, the Responses default, requires closed schemas with every
property required.

## 14. Search matches any word and ranks by coverage

`search_notes` used to require every query word, so a local model asking for
"project meeting" got one note of the many that mention either word, then
narrowed further into empty results. Small models phrase queries as several
loose words, so a note now matches if it contains any of them. Query words are
lowercased and stripped of surrounding punctuation (quotes, commas, question
marks) but keep inner characters, so `2024-10` and `c++` still work. Common
words such as "and" or "the" are dropped unless nothing else is left: under
any-word matching they would otherwise match almost every note. A word matches
only at the start of a word in the note, so "risk" finds "risks" but "ai" does
not find "email" or "said"; the same rule applies to names, headings, body
counts and excerpt placement. The word start is found by checking the
preceding character in code rather than with a regex lookbehind, which older
mobile WebViews cannot parse. Words in Chinese, Japanese, Korean, Thai and
similar scripts match anywhere, since words there are often written without
spaces or carry attached particles: "会议" must find "今天的会议记录". A
character of those scripts also ends the word before it, so "python" finds
"我在学习Python编程". Frontmatter key names such as
`date:` or `tags:` are not searched, so "date" does not match every note with a
date property; their values still are. Results rank by how many distinct words a note
contains, then by a score that weighs a word in the note's name over one in a
heading over occurrences in the body, which count at most three times so a
repeated word cannot bury a note that matches more of the query. Each
result shows `Name (path)` so the model sees the wikilink form, which words
matched, and an excerpt of the body (frontmatter skipped) around the passage
where the most matched words sit together. The old numeric score is not shown:
it meant nothing to the model. `mode: "all"` keeps strict AND for narrowing.
There is still no stemming or semantic search. Ranking is superseded by 15;
the matching rules stand.

## 15. Search index in memory, with note text in results

Every `search_notes` call used to lowercase and scan every note on the UI
thread: about 205 ms per call at 20,000 notes inside Obsidian, linear in vault
size, and its ranking counted "project" the same as "Nimbus", so at that size
the answer note came first for under half of the questions in a generated
benchmark (`scripts/retrieval-lab/`). Search now runs on a BM25 index
(`src/search/`) built from the vault's cached note text when the layout is
ready, in slices that yield to the UI (0.8 s in Node for 20,000 notes), and
kept current from vault create, modify, delete and rename events, which are
queued and applied before the next search so a burst of edits costs one
re-index per note (0.06 ms each). Postings are typed arrays in one block with
the dictionary sorted, plus a small delta compacted from time to time: about
10 MB at 20,000 notes. Searches take 2 to 7 ms there.

Compaction is sliced like the build: every pass over notes, terms and postings
pauses every few thousand items and yields when the 10 ms slice is used up,
new terms are merge-sorted with pauses and merged into the already sorted
dictionary instead of one `Array.sort`, and the rebuilt arrays replace the old
ones only at the end. Catching up on a renamed folder yields between notes.
Measured at 20,000 notes (`bench-search.ts` for Node; a disposable Obsidian
1.14.5 profile for in-app, with DevTools CPU throttling at 4x to approximate a
phone), longest synchronous stall:

| | build, including the final compaction | catch-up after renaming two folders (10,457 notes) |
|---|---|---|
| one-shot compaction, Node | 30.6 ms | 262 ms |
| sliced, Node | 10.2 ms | 12.7 ms |
| sliced, Obsidian | 10.1 ms | 13.6 ms |
| sliced, Obsidian at 4x throttling | 22 ms | 19.7 ms |

No task of 50 ms or more was observed in Obsidian in either sliced case.

The matching rules of 14 are kept exactly, so a note matches the same queries
as before: an index token is a run of letters and digits starting at a word
start, a query word matches every token it is a prefix of (one sorted range),
characters of unspaced scripts each start a token with the character after
them, and a query word with punctuation inside ("2024-10", "c++") or a longer
unspaced word needs all its tokens and is then checked against each candidate
note's text. A test compares the index with a word-start scan of every note on
generated notes. Only ranking changed: BM25 (k1 1.2, b 0.75) over weighted
counts (a word in the name counts three times, in a heading twice), so rare
words outweigh common ones and long notes do not win on volume; a word the
query word only starts ("video" for "vi") counts a quarter, which ranks the
exact word first without dropping the match. Ranking by the number of matched
words first scored worse on the benchmark and was dropped.

The index is not persisted. Building takes about as long as loading a saved
copy would, and a file would add stale-state handling and sync conflicts for
users who sync their config folder. No dependency: the index is a few hundred
lines.

A faster, better-ranked search alone did not change how a local model behaves:
in live runs qwen3:8b still answered from 160-character excerpts or guessed
paths instead of reading. So `search_notes` appends the full text of its best
results in rank order, in the `<<<note>>>` delimiters `read_note` uses, within
a token budget (the **Note text in search results** setting, 4,000 tokens,
never more than a quarter of the context window), then names the results not
shown in full. A result that does not fit is cut if at least half of it fits
and skipped otherwise. With a cloud provider this sends up to that much note
text per search, about one `read_note`.

Two smaller fixes came from the same runs. `list_files` caps a folder listing
at 500 entries like the recursive one: a folder of 1,910 notes cost one run
200 s of prompt processing. A note path with a folder no longer resolves to a
note of the same name in another folder: a guessed `Meetings/X.md` was
silently read as `Projects/X.md` and answered from; the error now names that
note and the model decides.
