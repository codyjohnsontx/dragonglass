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
    openai.ts             OpenAI Chat Completions (SSE). Base for the planned
                          custom OpenAI-compatible adapter.
    registry.ts           Builds providers from settings; reads keys lazily.
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
    settings-tab.ts       Declarative settings tab (Obsidian 1.13+ API).
```

## Data flow for one message

1. `ChatView` collects context the user chose (active note, selection,
   attachments) and calls `DragonglassCore.send`.
2. `core` appends the user message, builds the system prompt plus provider
   messages (`agent/context.ts`), and starts `runAgent`.
3. `runAgent` streams from the active `Provider`. Text deltas go straight to the
   view. Tool calls are collected until the turn ends.
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
  secret id. The OpenAI adapter reads the key through a closure at request
  time and never stores it.

## Provider abstraction

`Provider` exposes `capabilities` (streaming, tool calling, usage reporting,
model discovery, billed, remote), `listModels`, `checkConnection`, and
`chat` returning an async iterable of `StreamEvent`. Capability differences are
handled explicitly: Ollama's tool support is per model, so it is `'unknown'`
and the runtime retries once without tools when the server rejects them.

Adapters depend on an `HttpClient` rather than `fetch` directly. The streaming
client uses `fetch`; the fallback wraps Obsidian's `requestUrl` (no CORS
issues, no streaming). Tests inject real HTTP against a fake server or a
scripted client.

Adding Anthropic, Gemini, or a custom OpenAI-compatible endpoint means adding
one adapter file plus a settings block; the runtime and UI do not change.

## Persistence

Settings go to `data.json` through `loadData`/`saveData`. Conversations are one
file each under `<plugin dir>/conversations/`. Snapshots taken on apply live
under `<plugin dir>/snapshots/` (last 50 kept). Nothing is written into notes
except approved proposals.
