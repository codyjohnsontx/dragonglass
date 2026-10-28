# Dragonglass AI

Bring your own LLM to Obsidian. Dragonglass AI is a free, open-source,
agentic assistant that lives in a sidebar, understands your vault as a linked
knowledge base, and proposes every change as a diff you approve before it is
written.

- **Bring your own model.** Local models through Ollama, or OpenAI with your
  own API key. Anthropic, Gemini and custom OpenAI-compatible endpoints are
  next on the [roadmap](docs/roadmap.md). No subscription, no account, no
  proxy; cloud usage is billed to you by the provider.
- **Local-first and private.** Nothing leaves your machine except the message
  you type, the context you choose to attach, and the results of the tools
  the model calls, and only to the provider you configured. No telemetry.
- **Agentic, with oversight.** The model can list, search and read notes,
  inspect properties, links and backlinks, and propose creating or editing
  notes. Edits are shown as a diff; you approve, reject, or revert. Nothing is
  written otherwise.

## Status

This is the 0.1 MVP. It is a working vertical slice, not the full product.
What works, what was verified, and what is missing are listed honestly in
[What works](#what-works) and [Known limitations](#known-limitations).

## Install

Dragonglass AI is not yet in the community plugin directory. Install
manually:

1. Build or download `main.js`, `manifest.json` and `styles.css` (see
   [Development](#development)).
2. Copy them into `<your vault>/.obsidian/plugins/dragonglass-ai/`.
3. In Obsidian, open **Settings → Community plugins**, turn off Restricted
   mode if needed, and enable **Dragonglass AI**.

Requires Obsidian 1.13.2 or newer (for keychain-backed secret storage).

## Configure

Open **Settings → Dragonglass AI**.

### Ollama (local)

1. Install [Ollama](https://ollama.com) and pull a model that supports tool
   calling, for example `ollama pull llama3.1` or `ollama pull qwen2.5`.
2. Leave **Server URL** at `http://127.0.0.1:11434` unless Ollama runs
   elsewhere.
3. Enter the model name and select **Test Ollama connection**.

Ollama allows requests from Obsidian's `app://` origin by default. If you run
an older Ollama or have set `OLLAMA_ORIGINS` yourself, either include
`app://obsidian.md` in it or switch **Advanced → Network transport** to the
Obsidian request API, which bypasses CORS but does not stream.

Models without tool support still work for plain chat; the plugin notices the
rejection, retries without tools, and tells you.

### OpenAI

1. In **API key**, create a new keychain secret and paste your key. The key is
   stored by Obsidian's secret storage (backed by the OS keychain on desktop),
   never in plugin files or notes.
2. Enter a model such as `gpt-4o-mini` and select **Test OpenAI connection**.

### Context

By default the active note and any selected text are attached to each message.
Toggle them per message in the sidebar, or attach other notes with
**Attach note…**. When a cloud provider is active the sidebar says so, and
highlighted chips are exactly what gets sent.

## Use

Open the sidebar with the gem icon in the ribbon or the command
**Dragonglass AI: Open chat**.

- Ask questions: "What does my Launch note say about the date?"
- Ask for edits: "Move the launch date in Projects/Launch.md to November 15."
  The model reads the note, proposes a change, and a card with the diff
  appears. Select **Approve** to apply or **Reject** to discard.
- If you edit the note yourself after a proposal was made, approval is blocked
  and the card says the proposal is out of date. Ask again.
- **Revert** on an applied edit restores the snapshot taken before it was
  applied. Snapshots are kept under the plugin folder (last 50).
- **Stop** cancels generation. Partial text is kept.
- Conversations persist in the vault's plugin folder and survive switching
  providers.

Token counts reported by the provider are shown under each reply and as a
conversation total. These are counts, not bills. The optional usage warning is
a reminder, not a spending limit.

## What works

Verified by automated tests against a fake Ollama/OpenAI server and by driving
a real Obsidian 1.14.5 instance with the plugin installed in a disposable
vault:

- Plugin loads, sidebar opens, settings tab renders.
- Streaming chat over the Ollama wire format and the OpenAI wire format,
  including tool calls, tool results, usage, cancellation, and error mapping
  (bad key, rate limit, server error, unreachable server, model without tools).
- Read tools: list, read, search, metadata with links and backlinks, active
  note and selection.
- Edit flow end to end: ask for a change, model reads the note, proposes a
  find/replace, diff is shown, approve applies it through the Vault API, the
  open editor shows the new content, a snapshot is written, revert restores it.
- Stale detection: a note edited after the proposal cannot be approved.
- Conversation history persists across plugin reload.

Not yet verified live: a real Ollama model and a real OpenAI key were not
available on the build machine. The wire formats are tested against recorded
shapes from the official API documentation. To verify live:

1. Run Ollama with a tool-capable model and set it in settings; or add an
   OpenAI key in the keychain.
2. Select **Test … connection**: it should report the Ollama version or the
   number of OpenAI models.
3. In a scratch vault, create `Projects/Launch.md` containing
   `Launch date: November 1.` and send
   "Change the launch date in Projects/Launch.md to November 15".
4. Approve the proposal and confirm the note changed.

## Known limitations

- Only Ollama and OpenAI are implemented. Anthropic, Gemini and custom
  endpoints are designed for but not built.
- One proposal per card; multi-file changes are reviewed one card at a time.
- No Canvas, Bases, folder/move/rename tools, or frontmatter-specific editing
  yet.
- No semantic search; search is name and content substring matching.
- Cost estimates are not shown, only token counts from the provider.
- Desktop verified only. The code avoids desktop-only APIs but mobile has not
  been exercised.
- Very long notes are truncated when attached or read (configurable limit).

## Development

```sh
npm install
npm run dev      # watch build to main.js
npm run build    # typecheck + production build
npm test         # vitest (unit tests + adapters against the fake server)
npm run lint     # eslint with eslint-plugin-obsidianmd
```

For a disposable in-app check without a real model:

```sh
npm run build
node test/fake-server/server.mjs 11435 &   # fake Ollama + OpenAI on :11435
node scripts/e2e-vault.mjs .e2e            # builds .e2e/vault and .e2e/userdata
/Applications/Obsidian.app/Contents/MacOS/Obsidian \
  --user-data-dir="$PWD/.e2e/userdata" --remote-debugging-port=9333
```

The isolated user-data directory means this Obsidian instance never sees your
real vaults or settings. The fake server answers scripted prompts such as
`hello`, `read Projects/Launch.md`, and
`edit Projects/Launch.md replace "November 1" with "November 15"`; the OpenAI
side accepts the key `sk-fake`.

Docs: [architecture](docs/architecture.md), [roadmap](docs/roadmap.md),
[decision record](docs/decisions.md).

## Privacy

- No telemetry. No account. No server of ours.
- The whole vault is never uploaded. Only chosen context and tool results go
  to the provider you picked.
- API keys live in Obsidian's secret storage and are never logged or written
  to notes.
- Note content is treated as data: the model is told not to follow
  instructions found inside notes.
- All writes require your approval and are snapshotted for rollback.

## License

MIT. See [LICENSE](LICENSE).
