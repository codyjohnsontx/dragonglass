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
"我在学习Python编程". A letter shared between scripts, such as the prolonged
sound mark ー, belongs to them by its Unicode Script_Extensions, so "sql" finds
"サーバーsql". Frontmatter key names such as
`date:` or `tags:` are not searched, so "date" does not match every note with a
date property; their values still are. Results rank by how many distinct words a note
contains, then by a score that weighs a word in the note's name over one in a
heading over occurrences in the body, which count at most three times so a
repeated word cannot bury a note that matches more of the query. Each
result shows `Name (path)` so the model sees the wikilink form, which words
matched, and an excerpt of the body (frontmatter skipped) around the passage
where the most matched words sit together. The old numeric score is not shown:
it meant nothing to the model. `mode: "all"` ranks notes with every word first
(it was strict AND until decision 15 backfilled it).
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

Obsidian reports a folder rename as one event for the folder followed by one
per file inside it. Catch-up first handled each path on its own: the folder
re-indexed every note under it, each file event re-indexed it again, and each
old file path, already gone with the folder, scanned the whole index looking
for notes under it. Catch-up now sorts a batch into notes, folders and gone
paths, finds the notes under new folders in one pass over the vault, drops
gone paths in one pass over the index, and re-indexes each note once. For a
5,730-note folder renamed in a 20,000-note vault in Obsidian with 4x CPU
throttling, catch-up fell from 17.0 s (10.2 s of CPU in the plugin, mostly
that scan) to 0.56 s (0.2 s), with no long task either way. The rename itself
blocks Obsidian's UI thread for 426 to 470 s at 4x with the plugin loaded or
not; the CPU profile puts it in Obsidian's own
rename handling, not in this plugin, which only queues the events then.

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

A local model also passes `search_notes` a folder it picked from the vault map
before seeing anything: in live runs qwen3:8b restricted almost every first
search to `Projects` or `Meetings`, including for a warranty kept in a daily
note and for a project whose owner is only reachable through `People/`. Telling
it in the parameter description to leave the folder out did not change that,
so the result does the work: a restricted search with no match returns the
whole vault's results and says so, and one whose matches outside the folder
rank higher names up to three of them first. The folder still narrows a
search that is answered inside it.

One question still failed every run: the climbing project a person owns, whose
note never says "climbing" and is reachable only through the person's note.
The model asked for one result or for every word and cut the answer off, and
when it did find the person note it did not follow its links. So a search
returns at least 10 results whatever `limit` it asks for, `mode: "all"` fills
up to that with notes that have some of the words, and when the query names a
result of two or more words that lacks the other query words, the notes it
links to are listed with an excerpt and read in full right after it. They get
at most half the auto-read budget so the ranked results keep the rest; a
one-word name is a topic, not a person, and does not trigger this.

## 16. Batch apply is all or nothing

A turn that proposes several notes is reviewed as one card, derived from the
conversation at render time (every proposal between one user message and the
next) rather than stored, so conversations saved before batches existed group
the same way. The model gets one proposal per note per turn: a second
`propose_edit_note` or `propose_create_note` for a note whose first proposal
is still awaiting review is refused with a plain tool error telling it to put
every change to that note in one call, so each card is one note built against
what the user sees. Approve all and Undo all are all or nothing: every note in
the batch is checked first, and one out-of-date note means nothing is written
(or undone) and the error names it; the header also disables Approve all as
soon as the live freshness tracking knows a note changed, and the click-time
check stays as the backstop. Each write still goes through the per-note apply
path of decision 5 (hash re-check, snapshot, equality check inside
`Vault.process`); the batch composes those steps rather than bypassing them.
If a write fails partway, the notes already written are restored from their
snapshots and a note the batch created is moved to Obsidian's trash through
`FileManager.trashFile`, which follows the user's "Deleted files" setting
(the plugin never calls `Vault.delete` directly), and only while the note
still holds exactly what the batch wrote; a note the user has since changed
is left as it is. Undo all follows the same rule for created notes, while
per-note undo still never removes a created note. A partial apply was
rejected because the user approved the set as a whole, and a batch left half
applied is the state they can least reason about. Telling the model which
proposals were approved is a separate item.

## 17. Source markers checked against tool results

Answers about the vault are only useful if the user can see where each claim
came from and tell a read note from a guess. The model cites `[[Note name]]`
(a working link) or `[web N]` after each sourced claim and words anything
else as its own suggestion; Dragonglass renders the sources list itself,
grouped "From your vault" and "From the web".

The list is grounded in what the model was actually shown. Options
considered: trust the links the model typed; parse note paths back out of the
stored tool result text; or have each tool report what it showed as
structured `sources` on its result, stored on the tool message. Typed links
alone would present a note the model never opened as a source. Parsing result
text ties the list to output formats that change for the model's sake (search
results gained auto-read and linked notes within a few releases). Structured
sources cost one optional field on stored tool and user messages and let a
cited note whose text was not in the model's context be marked unverified,
and one only partly seen (a search excerpt, its properties or a selection) be
marked as such. A user message saved before this has no sources record, so
its turn gets no list and its links stay plain links rather than all showing
as unverified; in later turns of that conversation a cited note the record
does not show as read is left unflagged, since the old turn's replayed tool
results may have shown it. The list holds only cited notes: listing notes read
but not cited put a box under nearly every reply, since the active note is
sent by default.

The `[web N]` format, the "From the web" group and `WebSource` exist before any
web tool so the internet fallback only has to report its pages; the prompt's
web rule stays off until then so a local model is not told about results it
cannot get.

## 18. Web search runs in Dragonglass, after approval, through Tavily

The vault is the first source, but a lore question it cannot answer should
not end there. The owner chose the shape in an interview and Tavily from a
comparison of search services (free 1,000 searches a month with no card, a
domain filter, no terms against keeping results).

Options considered for who runs the search: each provider's own web search
(OpenAI, Anthropic and Gemini have one), or Dragonglass calling one service
itself. Provider search would give each provider different results, citations
and costs, and none for Ollama, which is the default. Calling Tavily from the
plugin gives every provider the same tool, results and `[web N]` markers. The
key lives in SecretStorage beside the provider keys; without it the tools are
absent rather than failing mid-answer, and the prompt says where to add one.

Every search waits for approval in the chat, showing the words editable,
because the query is the one thing that leaves the machine for a third party
and it can carry vault content. One approval covers the preferred-sites
search and its widening, and up to 3 page reads from its results, so a useful
answer needs one click rather than four. The model names a page by result
number, not URL, so it can never make Dragonglass fetch an address it made
up (a link that smuggles vault text out in its query string, say). A read
that fails does not use up the allowance; there are at most five results, and
repeating a read is refused.

Pages are read in-house rather than through Tavily's `raw_content` or
extract endpoint: the plugin has no runtime dependencies, a page read costs
no search credit, and the text the model gets is the same whatever service
found the page. The extractor is a small regex pass over HTML (no DOM, so it
runs in tests): it drops scripts, styles and page furniture and prefers the
main or article element. It cannot read pages that build their text with
JavaScript; the snippet remains. Text is cut to 6,000 characters, and to a
third of the note token budget when the context window is known.

A page read refuses result URLs whose host is on this computer or the
local network: loopback, unspecified, link-local, RFC 1918 and IPv6 ULA
addresses, and localhost and `.local` names. Results are untrusted, and a
local endpoint's reply would otherwise reach the model, which may be a cloud
provider. The check is on the URL alone. A public page that redirects to a
private address, or a public name that resolves to one, is a known residual:
`requestUrl` follows redirects without showing them, so catching that needs
a redirect-aware transport, which is left for the owner to decide on.

Web text is framed the way note text is, with stronger delimiters: every
result and page sits in a `<<<web …>>>` block under a line saying it is
untrusted, delimiters inside it are defused, and the system prompt says
never to follow instructions found in web content.

Results are numbered across the conversation rather than per turn, so a
`[web 3]` cited two turns after the search still names one page; the sources
list resolves numbers against every web result shown so far.

Save to vault proposes a new note rather than writing one, through the same
ProposalEngine path as the model's own proposals, with `from-web: true`, the
date, the question and the cited URLs in its properties so web research is
never mistaken for canon. It is stored on the answer, not on a tool message,
so it does not change what the model sees or join the turn's batch review.

The adapter sits behind a small `WebSearchService` interface (query,
domains, result count) so another service, Exa being the runner-up, is one
file. No live Tavily key was available when this was built; the client
follows Tavily's API reference and the fake server answers in that shape.

## 19. Drafts are a block in the reply; versions are the messages

The owner wants Dragonglass as a writing assistant for a screenplay whose
lore the vault holds: draft a scene in the chat, revise it there, then put
it in the note. An interview fixed the shape: drafts land in the chat first
and one click inserts them through the normal review; the format is read
from the script note, Fountain when there is nothing to match; the
characters and places are looked up first and cited like an answer's
sources; every revision is a full rewrite with the earlier versions a click
away; insert replaces the selection or goes at the cursor; the script is the
open note, with an optional script folder so script pages are not lore. It
ships in three builds: drafting, then a lore check with a sequel canon note,
then brainstorm cards. This is the first.

How the model hands over a draft: a `draft_scene` tool with the text as an
argument, or a marked block in the reply. The tool would put the scene in
tool-call arguments, which small local models produce unreliably for long
text and which do not stream, and the reply would then need separate text to
cite the lore. A fenced block opened with ```` ```draft ```` streams like any
reply, is written reliably by every model tried, and is a code fence, so the
citation extractor already ignores its inside and the model cites the lore
in the prose around it. The block is parsed when the turn ends; an
unterminated block (a stopped turn) is not a draft.

How versions are kept: a separate draft store with its own history, or the
messages themselves. Each revision is a whole message anyway, so a draft
message carries the text and a thread id, and the thread's versions are
listed from the conversation when rendering, the way proposal batches are.
Nothing new is persisted, nothing can drift from the chat, and older
conversations open unchanged. A revision joins the latest thread unless the
model opens the block with `draft new`: the cost of a forgotten `new` is one
extra version in a thread, while the opposite default would lose the
history of a revision the model forgot to mark.

How the format is matched: a Fountain parser, a model-side guess, or a few
line patterns. The owner asked for the note's own conventions, read from the
note, and the choice only decides which short instruction and sample the
model gets, so a parser is more than the decision needs. `inferFormat`
counts scene headings, forced headings, transitions and character cues with
dialogue under them against bold cues (two at least) and headings, with
Fountain as the default when the note is too short to tell, and the note's opening goes to
the model as a sample so it can match what the counts cannot describe. The
sample and the format go only when the open note is inside the script
folder or attached to the message: the open note is the script by the
owner's choice, but a public plugin should not send an unrelated private
note (a journal, say) with every message. Otherwise neither is sent, drafts
default to Fountain, and the rules tell the model that no script note is
shared, so it asks which note the scene is for when it should match one and
can read a note the user names with the read tools.

How Insert writes: a direct editor replace, or a proposal. Writes still never
write (decision 5). The insert reads the editor at the click (selection or
cursor), after saving the view's pending edits and waiting briefly for a
save already under way (the blur from the click starts one) to reach the
vault, builds the whole new note
text and goes through `ProposalEngine.proposeRewrite`, which refuses when
the vault still differs from the editor and otherwise hashes the note like
any edit; apply re-checks the hash inside `Vault.process`. The proposal
hangs off the draft version rather than a tool message, so it is not part
of the turn's batch review and is not replayed to the model, which was told
not to propose script edits itself. The draft goes in on lines of its own
with a blank line each side, since screenplay elements are blank-line
separated and a scene pasted mid-line is never what was meant.

The script folder is a setting rather than inferred: it only exists to keep
script pages out of the lore the model searches, the open note is the script
either way, and inserting outside the folder is allowed and said in the
review, since a scene may be drafted into an outline or a scratch note.
