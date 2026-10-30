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
rejects the request shapes the real Anthropic and Gemini APIs reject. The same server backs
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

## 13. Search matches any word and ranks by coverage

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
There is still no stemming or semantic search; that would need an index.
