# Architecture

Dragonglass AI is a plugin-local runtime: everything runs inside Obsidian's
renderer process. There is no hosted backend and no account. The only network
peers are the LLM providers the user configures.

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
    openai.ts             OpenAI Chat Completions (SSE). Also serves the custom
                          OpenAI-compatible provider (own id, URL, auth and
                          capability overrides).
    anthropic.ts          Anthropic Messages API (SSE, tool_use blocks).
    gemini.ts             Gemini API (streamGenerateContent SSE,
                          function declarations, thought signatures).
    registry.ts           Builds providers from settings; reads keys lazily;
                          maps custom endpoint settings onto the OpenAI adapter.
  agent/
    runtime.ts            The agent loop: stream, validate tool calls, execute,
                          feed results back, cap iterations, handle cancel.
    tools.ts              Tool registry and JSON-schema argument validation.
    context.ts            System prompt and provider message construction.
  tools/
    vault-tools.ts        The model-facing tools (list, read, search, metadata,
                          active note, propose create, propose edit).
  vault/
    port.ts               Narrow VaultPort interface over Obsidian's vault.
    obsidian-port.ts      VaultPort + StoreBackend implemented on App.
    paths.ts              Path validation at the trust boundary.
    proposals.ts          ChangeProposal model and ProposalEngine
                          (propose, diff, freshness check, apply, revert).
    diff.ts               Line diff (LCS) and hunk collapsing for review.
  persistence/
    conversation.ts       Stored conversation/message model and sanitizer.
    store.ts              One JSON file per conversation, debounced writes.
  ui/
    chat-view.ts          The sidebar ItemView.
    proposal-card.ts      Diff review card with approve/reject/revert.
    note-picker.ts        Fuzzy picker for attaching notes.
    confirm-modal.ts      Confirmation dialog for destructive actions.
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
   Write tools return a `ChangeProposal` and *do not write*.
5. Tool results are appended as `tool` messages and the loop continues until
   the model answers without tools or `maxToolIterations` is hit.
6. Every message and proposal is written to the conversation store as it is
   produced, so a crash mid-turn loses nothing already shown.

## Trust boundaries

- **Model output** is untrusted. Tool names and arguments are validated; paths
  are normalized and checked for traversal, absolute paths, URLs, control
  characters, and the config folder before any vault access.
- **Note content** is untrusted data for the model. It is wrapped in
  `<<<note path="…">>>` delimiters and the system prompt says not to follow
  instructions found inside.
- **Writes** go through `ProposalEngine.apply` only after the user approves in
  the UI. Apply re-reads the note, compares its SHA-256 with the hash taken at
  proposal time, writes a snapshot of the prior content under the plugin
  folder, then writes through `Vault.process` with a final content equality
  check inside the atomic callback. If anything changed, nothing is written and
  the proposal is marked out of date.
- **Secrets** live in Obsidian's `SecretStorage`; settings persist only the
  secret id. Each cloud adapter reads its own key through a closure at
  request time and never stores it; `registry.ts` wires each provider to its
  own secret id only, so a key cannot reach another provider.

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
thinking model's reasoning as `thinking` events, and emits a `warning` event
when `prompt_eval_count` says the prompt was cut anyway: a count well under
the estimate for a prompt that could not have fit, or a count of exactly half
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

## Persistence

Settings go to `data.json` through `loadData`/`saveData`. Conversations are one
file each under `<plugin dir>/conversations/`. Snapshots taken on apply live
under `<plugin dir>/snapshots/` (last 50 kept). Nothing is written into notes
except approved proposals.
