# Roadmap

Status as of the MVP (0.1.0). Items are ordered; each builds on the previous
without redesigning the provider or tool architecture.

## Done in 0.1.0

- Plugin scaffold on the official sample-plugin conventions.
- Chat sidebar: streaming, multiple persistent conversations, provider and
  model selection, active-note and selection context, note attachments,
  Markdown rendering, tool and error states, stop.
- Providers: Ollama (native API) and OpenAI (Chat Completions), behind one
  interface with explicit capabilities and a non-streaming fallback transport.
- Read tools: list files, read note, search names and content, note metadata
  (properties, tags, headings, outgoing links, backlinks), active note.
- Write tools: propose create note, propose edit note (find/replace, append,
  replace all). Diff review, approve, reject, revert, stale detection,
  snapshots.
- Secure key storage through Obsidian's SecretStorage.
- Token usage display and a configurable usage warning.
- Unit tests against an in-memory vault and a fake Ollama/OpenAI server.

## Done after 0.1.0

- **Anthropic adapter** (Messages API, SSE, tool use blocks).
- **Google Gemini adapter** (streamGenerateContent, function declarations,
  thought signatures).
- Switching providers mid-conversation replays tool history across providers.
- **Custom OpenAI-compatible endpoint**: the OpenAI adapter with a
  configurable base URL, bearer / custom-header / no authentication, and
  tool-calling and streaming overrides (Moonshot, OpenRouter, Groq, LM Studio,
  vLLM, llama.cpp).

## Next

1. **Batch review**: group proposals from one turn into a single review with
   approve-all, so multi-file changes are reviewed together.
2. **More write tools**: create folder, move/rename note, update frontmatter
   through `FileManager.processFrontMatter`, section-level replace by heading.
3. **Relationship tools**: "related notes" via shared links, tags and
   co-citation; propose wikilinks with reasons.
4. **Canvas**: read `.canvas` JSON, propose new boards and node/edge edits as
   reviewed file operations with schema validation.
5. **Bases**: read and propose `.base` files once the format is stable.
6. **Semantic retrieval**: optional local embeddings (Ollama embed models)
   with an on-disk index; never required.
7. **Cost estimates** for paid providers from a maintained price table,
   clearly labelled as estimates.
8. **Mobile check**: the code avoids Node/Electron APIs, but the UI has only
   been exercised on desktop.
