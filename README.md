# Dragonglass AI

Bring your own LLM to Obsidian. Dragonglass AI is a free, open-source,
agentic assistant that lives in a sidebar, understands your vault as a linked
knowledge base, and proposes every change as a diff you approve before it is
written.

- **Bring your own model.** Local models through Ollama, OpenAI, Anthropic
  or Google Gemini with your own API key, or any OpenAI-compatible endpoint
  (Moonshot's Kimi, OpenRouter, Groq, LM Studio, vLLM, llama.cpp). No
  subscription, no account, no proxy; cloud usage is billed to you by the
  provider. See [Ways to run it](#ways-to-run-it).
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

## Ways to run it

Dragonglass talks to a model over an API. It never logs in to a chat app, so
a ChatGPT, Claude or Gemini chat subscription cannot be used; only API keys
(or a local server) work. Pick whichever suits you:

- **Local Ollama.** Models run on your own machine; nothing leaves it. See
  [Ollama](#ollama-local).
- **Ollama cloud models, through your local Ollama.** Sign in once with
  `ollama signin`, pull one of the cloud models from Ollama's library (for
  example a Kimi K2 cloud tag), and select it as an Ollama model. No code or
  extra settings are needed. These models run on Ollama's servers, so your
  messages and attached context leave your machine even though the plugin
  talks to `127.0.0.1`.
- **An OpenAI, Anthropic or Google Gemini API key.** Billed by that provider
  to your account. See [OpenAI](#openai), [Anthropic](#anthropic) and
  [Google Gemini](#google-gemini).
- **Any OpenAI-compatible endpoint.** Services such as Moonshot (Kimi models)
  and OpenRouter (many vendors' models behind one key), or a server you run
  yourself such as LM Studio, vLLM or llama.cpp. See
  [OpenAI-compatible endpoint](#openai-compatible-endpoint).

## Configure

Open **Settings → Dragonglass AI**.

### Ollama (local)

1. Install [Ollama](https://ollama.com) and pull a model that supports tool
   calling, for example `ollama pull llama3.1` or `ollama pull qwen2.5`.
   Thinking models such as `qwen3` work too, but pause for a long time
   before answering (see "Let thinking models think" below).
2. Leave **Server URL** at `http://127.0.0.1:11434` unless Ollama runs
   elsewhere.
3. Enter the model name and select **Test Ollama connection**. It reports
   the server version and whether that model is installed.

Ollama allows requests from Obsidian's `app://` origin by default. If you run
an older Ollama or have set `OLLAMA_ORIGINS` yourself, either include
`app://obsidian.md` in it or switch **Advanced → Network transport** to the
Obsidian request API, which bypasses CORS but does not stream.

Models without tool support still work for plain chat; the plugin notices the
rejection, retries without tools, and tells you.

Two settings matter for local models:

- **Context window** is sent as Ollama's `num_ctx` on every request (default
  16,384 tokens). Until the plugin sets it, Ollama runs at its own default of
  4,096 tokens, which one long note overflows;
  when that happens Ollama silently keeps about half the prompt and drops the
  system prompt and your question. The value is capped at what the model
  supports. If a prompt is still cut, the reply carries a warning saying so.
  Note content sent to the model is also trimmed to half the window when
  **Max characters per note** would exceed that.
- **Let thinking models think** controls models such as qwen3 or deepseek-r1
  that reason before answering. While they think the sidebar shows
  "Thinking…" with the elapsed time, and the reasoning is kept in a collapsed
  block above the reply; the usage line says how many output tokens went to
  thinking. Turn the setting off to send `think: false` for faster, direct
  answers. Expect 15 to 110 seconds of thinking per turn on an 8B model on a
  laptop.

### OpenAI

For the three cloud providers, the **Model** field and the sidebar's model menu
list the chat models your key can use. Until the key works they offer a short
list of each provider's current models instead.

1. In **API key**, create a new keychain secret and paste your key. The key is
   stored by Obsidian's secret storage (backed by the OS keychain on desktop),
   never in plugin files or notes.
2. Pick a model from the **Model** field's list (or type any model id) and
   select **Test OpenAI connection**.

### Anthropic

1. In the **Anthropic** group, create a keychain secret holding your Anthropic
   API key (from the Anthropic Console). It is sent only to Anthropic.
2. Pick a model from the **Model** field's list (or type any model id) and
   select **Test Anthropic connection**.
3. **Max output tokens** caps each reply (Anthropic requires a cap). Raise it
   if long answers or drafted notes are cut off.

Anthropic only accepts requests from a browser context such as Obsidian's when
the client opts in, so the plugin sends the
`anthropic-dangerous-direct-browser-access` header. Your key still goes only
from your machine to Anthropic.

### Google Gemini

1. In the **Google Gemini** group, create a keychain secret holding a Gemini
   API key from Google AI Studio. It is sent only to Google, in a request
   header rather than the URL.
2. Pick a model from the **Model** field's list (or type any model id) and
   select **Test Gemini connection**.

### OpenAI-compatible endpoint

For any server that speaks the OpenAI Chat Completions API. It shows up as
**Custom** in the sidebar's provider menu.

1. **Base URL** is the API root that `/chat/completions` and `/models` sit
   under, usually ending in `/v1`. For example:
   - Moonshot: `https://api.moonshot.ai/v1`
   - OpenRouter: `https://openrouter.ai/api/v1`
   - Groq: `https://api.groq.com/openai/v1`
   - LM Studio: `http://127.0.0.1:1234/v1`
   - llama.cpp `llama-server`: `http://127.0.0.1:8080/v1`
   - vLLM: `http://127.0.0.1:8000/v1`
2. **Authentication**: most services take `Authorization: Bearer <key>`.
   Choose **Key in a custom header** for services that want the key in a
   named header (for example `api-key`), or **No authentication** for local
   servers; then no key is ever sent.
3. **API key**: a keychain secret, like the other providers. It is sent only
   to the base URL above.
4. **Model**: the model id exactly as the service names it, or pick one from
   the sidebar model menu once the connection works.
5. Select **Test endpoint connection**. It lists the server's models with the
   authentication you chose.

Two switches cover servers that do not support everything:

- **Tool calling** off stops sending tool definitions, for servers or models
  that reject them or answer with broken tool calls. With it on, a server
  that refuses tools (for example vLLM without `--enable-auto-tool-choice`, or
  llama.cpp without `--jinja`) still gets an answer: the plugin retries once
  without tools and says so.
- **Streaming** off asks for whole replies, for servers that cannot stream.

An endpoint on `localhost`, `127.x.x.x` or `[::1]` is treated as local: the sidebar
does not show the cloud privacy note and token counts are not described as
billed. Any other host is treated as a remote service. If the connection test
cannot reach a server that answers from the command line, the server probably
refuses requests from Obsidian's `app://` origin (CORS); switch
**Advanced → Network transport** to the Obsidian request API.

### Switching providers

Switch providers from the sidebar at any time. The conversation stays as it
is, including earlier tool calls, and the next message goes to the new
provider with the whole history. Each reply is labelled with the model that
wrote it.

### Context

By default the active note and any selected text are attached to each message.
A selection is attached once: if it is still selected at the next message its
chip is no longer highlighted, and clicking it sends it again. The active
note is the Markdown note you last focused in any window, so it stays attached
while you type in the sidebar or have a Canvas or PDF open.
Toggle them per message in the sidebar, or attach other notes with
**Attach note…**. When a cloud provider is active the sidebar says so, and
highlighted chips are exactly what gets sent.

## Use

Open the sidebar with the gem icon in the ribbon or the command
**Dragonglass AI: Open chat**.

- Ask questions: "What does my Launch note say about the date?"
- Copy a reply: select text in the sidebar and copy it as usual, or select
  **Copy** under a reply to put its Markdown on the clipboard.
- Ask for edits: "Move the launch date in Projects/Launch.md to November 15."
  The model reads the note, proposes a change, and a card with the diff
  appears. Select **Approve** to apply or **Reject** to discard.
- If you edit the note yourself after a proposal was made, the card switches
  to out of date and approval is blocked; undoing your edit makes it
  approvable again. Otherwise ask again.
- **Revert** on an applied edit restores the snapshot taken before it was
  applied. It is refused if the note changed after the edit was applied, so
  later edits are never overwritten. Snapshots are kept under the plugin
  folder (last 50).
- **Stop** cancels generation. Partial text is kept.
- Conversations persist in the vault's plugin folder and survive switching
  providers. Deleting one asks for confirmation first; there is no undo.
- The light next to the model menu shows the last connection check. It turns
  red when a request fails because the provider is unreachable or refuses the
  request, and is re-checked every time you send.

Token counts reported by the provider are shown under each reply, summed over
every tool round of that turn, and as a conversation total. These are counts,
not bills. The optional usage warning is a reminder, not a spending limit.

## What works

Verified by automated tests against a fake provider server and by driving
a real Obsidian 1.14.5 instance with the plugin installed in a disposable
vault:

- Plugin loads, sidebar opens, settings tab renders.
- Streaming chat over the Ollama, OpenAI, Anthropic and Gemini wire formats,
  including tool calls, tool results, usage, cancellation, and error mapping
  (bad key, rate limit, server error, unreachable server, model without tools).
- Custom OpenAI-compatible endpoints with bearer, custom-header and no
  authentication, a server that rejects tools, and streaming turned off.
- Switching providers mid-conversation, including replaying tool calls made
  by one provider to another.
- Read tools: list, read, search, metadata with links and backlinks, active
  note and selection.
- Edit flow end to end: ask for a change, model reads the note, proposes a
  find/replace, diff is shown, approve applies it through the Vault API, the
  open editor shows the new content, a snapshot is written, revert restores it.
- Stale detection: a note edited after the proposal cannot be approved.
- Conversation history persists across plugin reload.

Verified live against Ollama with qwen3:8b on a laptop (every scenario above).
Real OpenAI, Anthropic and Gemini keys were not available on the build
machine; those wire formats are tested against shapes from the official API
documentation. The custom endpoint has not been run against Moonshot,
OpenRouter or another live service yet; it is the OpenAI adapter pointed at
a different URL. To verify live:

1. Run Ollama with a tool-capable model and set it in settings; or add an
   OpenAI, Anthropic or Gemini key in the keychain.
2. Select **Test … connection**: it should report the Ollama version or the
   number of models your key can use.
3. In a scratch vault, create `Projects/Launch.md` containing
   `Launch date: November 1.` and send
   "Change the launch date in Projects/Launch.md to November 15".
4. Approve the proposal and confirm the note changed.

## Known limitations

- A ChatGPT, Claude or Gemini chat subscription cannot be used; only API keys
  or a local server.
- Custom endpoints get the standard OpenAI request shape. Provider-specific
  extras (OpenRouter routing options, reasoning fields some services stream)
  are not sent or shown, and a server without a `/models` route fails the
  connection test even if chat works.
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
node test/fake-server/server.mjs 11435 &   # fake Ollama, OpenAI, Anthropic, Gemini on :11435
node scripts/e2e-vault.mjs .e2e            # builds .e2e/vault and .e2e/userdata
/Applications/Obsidian.app/Contents/MacOS/Obsidian \
  --user-data-dir="$PWD/.e2e/userdata" --remote-debugging-port=9333
```

The isolated user-data directory means this Obsidian instance never sees your
real vaults or settings. The fake server answers scripted prompts such as
`hello`, `read Projects/Launch.md`, and
`edit Projects/Launch.md replace "November 1" with "November 15"`. Cloud
providers need a keychain secret holding the fake key: `sk-fake` for OpenAI,
`sk-ant-fake` for Anthropic, `gemini-fake` for Gemini. The custom endpoint
starts on the fake server's `/local/v1`, which needs no key and rejects tools;
`/keyed/v1` takes `custom-fake` in an `api-key` header.

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
