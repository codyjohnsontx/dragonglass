# Architecture

Dragonglass AI is a plugin-local runtime: everything runs inside Obsidian's
renderer process. There is no hosted backend and no account. The only network
peers are the LLM providers the user configures and, for a web search the
user approves, Tavily and the result pages the model reads.

```
src/
  main.ts                 Plugin lifecycle: settings, view, command, ribbon.
  core.ts                 Wires providers, tools, persistence and the agent loop.
  settings.ts             Settings shape, defaults, and runtime merge/validation.
  providers/              Provider adapters behind one interface.
    types.ts              ChatMessage, StreamEvent, Provider, capabilities, errors.
    http.ts               Transport: streaming fetch client, requestUrl fallback,
                          SSE and NDJSON parsers.
    ollama.ts             Ollama native API (/api/chat NDJSON).
    openai.ts             OpenAI Chat Completions (SSE), and the Responses API
                          for models that take tools only there. Also serves
                          the custom OpenAI-compatible provider (own id, URL,
                          auth and capability overrides; Chat Completions only).
    openai-responses.ts   Responses API wire format: stateless input items,
                          function tools, SSE events.
    anthropic.ts          Anthropic Messages API (SSE, tool_use blocks).
    gemini.ts             Gemini API (streamGenerateContent SSE,
                          function declarations, thought signatures).
    registry.ts           Builds providers from settings; reads keys lazily;
                          maps custom endpoint settings onto the OpenAI adapter.
    model-choices.ts      Model menu data: live lists filtered to chat models,
                          built-in current models when listing fails, and the
                          per-provider list behind the sidebar menu.
  agent/
    runtime.ts            The agent loop: stream, validate tool calls, execute,
                          feed results back, cap iterations, handle cancel.
    tools.ts              Tool registry and JSON-schema argument validation.
    context.ts            System prompt and provider message construction.
    sources.ts            Source markers: citations in an answer checked
                          against what tool results and context showed.
  tools/
    vault-tools.ts        The model-facing tools (list, read, search, metadata,
                          active note, and the propose tools: create note,
                          edit note, update frontmatter, move note, create
                          folder).
    web-tools.ts          web_search (waits for the user's approval) and
                          read_web_page (up to 3 results per approved search).
  web/
    search.ts             WebSearchService interface, the Tavily client and the
                          preferred-sites parser.
    pages.ts              Fetches one result page (no credentials) as text.
    extract.ts            In-house HTML to plain text, no DOM.
    research-note.ts      The note Save to vault proposes for a web answer.
  search/
    tokenize.ts           Search matching rules: query words, word starts,
                          frontmatter keys, unspaced scripts, index tokens.
    bm25.ts               In-memory BM25 index in typed arrays.
    vault-index.ts        Builds the index from the vault in slices, follows
                          vault events, serializes builds and searches.
  vault/
    port.ts               Narrow VaultPort interface over Obsidian's vault,
                          including trashing a note (never `Vault.delete`),
                          moving one through `FileManager.renameFile` and
                          changing properties through `processFrontMatter`.
    obsidian-port.ts      VaultPort + StoreBackend implemented on App.
    paths.ts              Path validation at the trust boundary.
    proposals.ts          ChangeProposal model and ProposalEngine
                          (propose, diff, freshness check, apply, revert, and
                          the all-or-nothing batch apply and undo with rollback)
                          for note creates and edits, folders, moves and
                          property changes.
    sections.ts           Headings of a note and replacing one section by heading.
    diff.ts               Line diff (LCS) and hunk collapsing for review.
  persistence/
    conversation.ts       Stored conversation/message model and sanitizer;
                          groups usage and proposals by user turn.
    store.ts              One JSON file per conversation, debounced writes.
  ui/
    chat-view.ts          The sidebar ItemView.
    composer-keys.ts      Which composer keystroke sends (Mod+Enter) and its label.
    sources-list.ts       The sources list under an answer, and opening
                          [[links]] in replies.
    copy.ts               Clipboard write behind the per-reply Copy button,
                          and its screen-reader "Copied" announcement.
    web-approval.ts       The in-chat card that approves a web search, with the
                          search words editable.
    proposal-card.ts      Diff review card with approve/reject/revert, and the
                          grouped card for a turn with several proposals
                          (Approve all, Reject all, Undo all).
    note-picker.ts        Fuzzy picker for attaching notes.
    confirm-modal.ts      Confirmation dialog for destructive actions.
    model-suggest.ts      Model suggestions under a free-text model id field.
    settings-tab.ts       Declarative settings tab (Obsidian 1.13+ API).
```

## Data flow for one message

1. `ChatView` collects context the user chose (active note, selection,
   attachments) and calls `DragonglassCore.send`.
2. `core` appends the user message, builds the provider messages
   (`agent/context.ts`), and starts `runAgent`.
3. `runAgent` adds the system prompt for whether tools are actually sent (the
   setting, the provider's tool-calling capability, and the retry without tools
   when a model rejects them), then streams from the active `Provider`. Text
   deltas go straight to the view. Tool calls are collected until the turn
   ends, but the view hears about each one as soon as the model names it
   (`tool_call_start`), so the running-tool chip appears while the arguments
   are still streaming.
4. Each tool call is validated against the tool's JSON schema
   (`agent/tools.ts`). Only then does the tool run. Read tools return text.
   Write tools return a `ChangeProposal` and *do not write* (see "Write
   proposals" below for the kinds). A tool registry
   lives for one send, and a second proposal for a note whose first proposal
   of that turn is still awaiting review is refused with a tool error. It
   tells the model to put both changes in one call when the earlier proposal
   is the same kind (two text edits, or two property changes), and otherwise
   to ask the user to review the first card (decision 19).
5. Tool results are appended as `tool` messages and the loop continues until
   the model answers without tools. A call repeated with the same arguments in
   one turn is answered with an error instead of being run again. After a
   third identical call, or once the `maxToolIterations` tool rounds are used
   up, one more request goes without tools and with an instruction to answer
   from what was gathered; tool calls the model makes anyway are dropped, not
   run. Read tools accept a wikilink name and resolve it by basename, as
   Obsidian does, but never into a folder other than one the path names, and
   write tools refuse placeholder text such as `[Insert …]`. `search_notes`
   ranks on the in-memory index (decision 15) and appends the full text of its
   best results within the auto-read budget. A search restricted to a folder
   names better matches outside it, and searches the whole vault when the
   folder has none. It returns at least 10 results whatever `limit` or `mode`
   the model asks for, and when the query names a result of two or more words
   that lacks its other words (a person note, asked about their climbing
   project), it lists the notes that result links to, each with an excerpt,
   and auto-reads them right after it within half the auto-read budget.
6. Every message and proposal is written to the conversation store as it is
   produced, so a crash mid-turn loses nothing already shown. A tool message
   also stores the `sources` its result showed the model (see below).
7. The view reviews proposals per turn (`proposalTurns`): the proposals made
   between one user message and the next render on the row of the last one,
   as a plain card for a single proposal or a grouped card for several, with
   Approve all and Reject all, then Undo all once applied. Each note's section
   keeps its own approve, reject and revert, and approving or rejecting one
   removes it from what Approve all covers. The grouping is derived from the
   messages when rendering, so nothing new is stored and older conversations
   group the same way. While a note in the batch is known to be out of date
   (the same live tracking that marks a single card), Approve all is disabled
   and the header names the note with a link that scrolls to its section.
8. When the turn ends the view re-renders it with the answer's sources list.

## Write proposals

A `ChangeProposal` has a kind:

- `create` and `edit` carry the note's text before and after and are
  reviewed as a line diff. `propose_edit_note` takes find/replace, append,
  replace-all and `replace_section` operations; a section runs from its
  heading, named by its exact text, to the next heading of the same or a
  higher level, its content is the body only, and a missing or ambiguous
  heading is refused with the headings the model can use (`Act Two > Notes`).
- `frontmatter` carries the properties changed, each with its value before
  and after, and is reviewed as those values. It is written by
  `FileManager.processFrontMatter` after the hash check, with a guard inside
  the write that each property still holds the reviewed value; `after` is
  filled with the note as Obsidian wrote it.
- `move` carries `newPath` and `linkUpdates`, the notes whose link text
  changes, and is reviewed as from, to and that list. It is written by
  `FileManager.renameFile`, which updates links as the user's settings say
  (asking in Obsidian's dialog when "Automatically update internal links" is
  off). Freshness is the note still at its path and nothing at the new one.
- `folder` creates an empty folder and is never undone.

Revert undoes an edit or property change, or moves a note back; it does not
remove a created note or folder. Approve all writes folders, then note
contents, then moves; Undo all goes newest first, skips folders, and checks a
note whose links a move rewrote only after that move is undone (decision 19).

## Web search

With a Tavily key in SecretStorage and tools on, each send registers
`web_search` and `read_web_page` beside the vault tools, whichever provider is
active; Tavily and the pages are reached through `requestUrl`, never through
the chat transport. Without a key the tools are absent and the system prompt
says web search is not set up and where to add a key, so a turn never fails
on it.

`web_search` calls the approver the chat view passed to `core.send`, which
shows a card under the running turn with the model's words in an editable
field; the tool waits on it. Stop or switching conversations declines. A
declined search returns a plain result telling the model to answer from the
vault. With preferred sites the search is restricted to them
(`include_domains`) and runs again on the whole web only when that returns
nothing; one approval covers both calls. Results are numbered across the
conversation (one past the highest `[web N]` already shown) and wrapped in
`<<<web result …>>>` blocks under a line saying the text is untrusted.

`read_web_page` takes a result number, not a URL, so only pages an approved
search returned can be fetched. Each approved search allows 3 successful
reads; a failed read (an error status, a PDF, a page with no text) does not
count. The page is fetched with no key or cookie, and never from a host on
this computer or the local network (decision 18). It is reduced to text by
`web/extract.ts` (scripts, styles and page furniture dropped, the main or
article element preferred), cut to `min(6000, maxCharsPerNote)` characters
and a third of the note token budget, and wrapped in `<<<web page …>>>`.
Delimiters inside web text are defused so a page cannot close its own block.

Save to vault (`DragonglassCore.proposeResearchNote`) builds a note from an
answer that cites at least one page a search returned: frontmatter with
`from-web: true`, the date, the question and the cited URLs, then the answer
with linked markers and a Sources list. It is a `ProposalEngine.proposeCreate`
proposal stored on the assistant message (`researchProposalId`) and reviewed
with a plain proposal card under the answer; it is not a tool proposal, so it
never joins the turn's batch review.

## Source markers

The system prompt asks the model to put `[[Note name]]` after each claim
taken from a note and `[web N]` after each claim taken from a web search
result (the web rule is added only when web results can be in the
conversation), to word anything unsourced as its own suggestion, and not to
write its own sources list.

Read tools report what they showed as `Source`s on their result: `read_note`
and `get_active_note` the note they read, `search_notes` each listed note as an
excerpt or, when its text was auto-read, in full. A web tool reports each page
as `{ kind: 'web', n, url, title }`, numbered as the model saw it. The user
message records the notes sent as context the same way: attachments and the
active note in full, a selection as an excerpt of its note. They count for
their own turn only, since the context block is sent with the latest user
message and is not replayed later. Web pages are numbered across the
conversation, so a cited `[web N]` names one page wherever it was found.

`answerSources` (`agent/sources.ts`) walks the stored conversation per user
turn and checks the answer's citations against that record, not against the
model's word: a cited note is *read*, *excerpt* (only part of it was shown:
a search excerpt, its properties or a selection), *unread* (not in the
model's context for this answer: unverified) or *missing* (the link resolves
to no note), counting tool results from earlier turns, which are replayed,
and this turn's attached context. Only cited notes are listed, minus notes
the same turn proposed creating or editing: a link to one names the change,
not a source. A turn whose user message has no `sources` record was saved
before source markers and gets no list; later turns of that conversation mark
a cited note not shown as read since then *unchecked*, with no flag, as the
unrecorded turn may have shown it. `userMessage` (`agent/context.ts`) always
writes the record. Cited `[web N]` numbers map to the web sources shown so far in the
conversation (earlier results are replayed); a number no result gave is
unverified. `ui/sources-list.ts` renders the list
under the turn's last reply, "From your vault" then "From the web", and
`[web N]` markers become links to their pages. Links to missing notes do
nothing on click, so a reply cannot create an empty note.

## Trust boundaries

- **Model output** is untrusted. Tool names and arguments are validated; paths
  are normalized and checked for traversal, absolute paths, URLs, control
  characters, and the config folder before any vault access.
- **Note content** is untrusted data for the model. It is wrapped in
  `<<<note path="…">>>` delimiters and the system prompt says not to follow
  instructions found inside.
- **Web content** (search snippets, page text, titles) is untrusted data too.
  It is wrapped in `<<<web result …>>>` and `<<<web page …>>>` delimiters,
  under a line saying never to follow instructions in it, with any delimiter
  inside it defused, and the system prompt repeats the rule. The model
  cannot choose a URL to fetch: it names a result of a search the user
  approved, after seeing and possibly editing its words.
- **Writes** go through `ProposalEngine.apply` only after the user approves in
  the UI. Apply re-reads the note, compares its SHA-256 with the hash taken at
  proposal time, writes a snapshot of the prior content under the plugin
  folder, then writes through `Vault.process` with a final content equality
  check inside the atomic callback. If anything changed, nothing is written and
  the proposal is marked out of date. Approve all composes that per-note path
  and is all or nothing: every pending note is checked first, and one
  out-of-date note means nothing is written and the error names it. If a write
  fails partway, the notes already written are restored from their snapshots
  and a note the batch created is moved to Obsidian's trash through
  `VaultPort.trashNote` (`FileManager.trashFile`, which follows the user's
  "Deleted files" setting; never `Vault.delete` directly), each only while the
  note still holds exactly what the batch wrote. Undo all checks every applied
  note the same way before undoing any, newest change first so a note changed
  twice in one turn is checked against its latest change, and trashes created
  notes under the same rule; per-note revert never removes a note. Moves,
  property changes and new folders are proposals under the same rules (see
  "Write proposals").
- **Secrets** live in Obsidian's `SecretStorage`; settings persist only the
  secret id. Each cloud adapter reads its own key through a closure at
  request time and never stores it; `registry.ts` wires each provider to its
  own secret id only, so a key cannot reach another provider. The Tavily key
  goes only to the Tavily API root; page reads carry no credentials.

## Provider abstraction

`Provider` exposes `capabilities` (streaming, tool calling, usage reporting,
model discovery, billed, remote), `listModels`, `checkConnection`, and
`chat` returning an async iterable of `StreamEvent`. Capability differences are
handled explicitly: Ollama's tool support is per model, so it is `'unknown'`
and the runtime retries once without tools when the server rejects them.
Wire-format differences stay inside each adapter: Anthropic lifts the system
prompt out, requires strictly alternating roles and a `max_tokens` cap, and
reports input and output tokens in separate events; Gemini uses a `model` role,
matches tool results by name, rejects `additionalProperties` in schemas,
requires its thought signature to be replayed with function calls, reports an
invalid key as HTTP 400, and can stop with a safety reason and no text, which
is surfaced as an error. Ollama sends `options.num_ctx` on every request (its
server default of 4096 silently cuts prompts that do not fit), streams a
thinking model's reasoning as `thinking` events and replays it on the
assistant turns after the last user message so the plan survives tool rounds,
and emits a `warning` event when `prompt_eval_count` says the prompt was cut
anyway: a count well under the estimate for a prompt that could not have
fit, or a count of exactly half
the window plus two tokens, which is what Ollama's runner leaves after cutting
one oversized message (measured on 0.40) and is trusted whenever the prompt
could have overflowed under a byte-level tokenizer, so notes in Chinese,
Japanese or Korean are caught however their tokenizer counts. An adapter that
knows the model's context window exposes it through `contextWindow`, and
`core` caps note content at an estimated half of it (`noteTokenBudget`): the
attached context shares that budget (`allocateTokens`), and each send builds
its own tool registry so a read tool applies the budget of the send it
belongs to.

Conversations are provider-neutral (`ChatMessage`), so switching providers
replays the whole history, including tool calls another provider made. The one
piece of provider state kept on a message is `ToolCall.signature` (Gemini's
thought signature); other adapters ignore it. When a request declares no tools
(vault tools turned off), the Anthropic and Gemini adapters replay earlier tool
calls and results as plain text. Anthropic requires this: its API rejects tool
blocks in a request without tools. For Gemini it is a precaution that has not
been confirmed against the live API.

Adapters depend on an `HttpClient` rather than `fetch` directly. The streaming
client uses `fetch`; the fallback wraps Obsidian's `requestUrl` (no CORS
issues, no streaming). Tests inject real HTTP against a fake server or a
scripted client.

The custom OpenAI-compatible provider (`custom`) is a second `OpenAIProvider`
instance with its own identity and config: the key goes as a bearer token, in
a named header, or not at all; tool calling and streaming can be switched off,
and the adapter then omits `tools` or asks for a whole reply; a loopback base
URL marks it local (not remote, not billed). Its capabilities are read from
settings on each access, so changes apply without rebuilding providers.

Adding a provider means adding one adapter file (or reusing one, as `custom`
does), an id in `PROVIDER_IDS`, a settings block and a registry entry; the
runtime and chat view do not change.

## Search index

`DragonglassCore` owns one `VaultSearchIndex` for the plugin's lifetime. It
starts when the workspace layout is ready (before that, Obsidian reports every
file as created), reads notes through `VaultPort.readNote` (Obsidian's cached
text), and subscribes to `VaultPort.onChange`. Changes are only queued; the
next search applies them first. Builds, catch-ups and searches run one at a
time on a promise chain, so a search never sees the index mid-compaction.
Building, catching up and compacting all yield to the UI in slices of about
10 ms (`Bm25Index.compact` takes a pause callback for this). The index lives
only in memory and is rebuilt on every start.

## Persistence

Settings go to `data.json` through `loadData`/`saveData`. Conversations are one
file each under `<plugin dir>/conversations/`. Snapshots taken on apply live
under `<plugin dir>/snapshots/` (last 50 kept). Nothing is written into notes
except approved proposals.
