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

## Next

1. **Anthropic adapter** (Messages API, SSE, tool use blocks).
2. **Google Gemini adapter** (generateContent streaming, function declarations).
3. **Custom OpenAI-compatible endpoint** (reuse the OpenAI adapter with
   configurable base URL, auth header, and capability overrides).
4. **Batch review**: group proposals from one turn into a single review with
   approve-all, so multi-file changes are reviewed together.
5. **More write tools**: create folder, move/rename note, update frontmatter
   through `FileManager.processFrontMatter`, section-level replace by heading.
6. **Relationship tools**: "related notes" via shared links, tags and
   co-citation; propose wikilinks with reasons.
7. **Canvas**: read `.canvas` JSON, propose new boards and node/edge edits as
   reviewed file operations with schema validation.
8. **Bases**: read and propose `.base` files once the format is stable.
9. **Semantic retrieval**: optional local embeddings (Ollama embed models)
   with an on-disk index; never required.
10. **Cost estimates** for paid providers from a maintained price table,
    clearly labelled as estimates.
11. **Mobile check**: the code avoids Node/Electron APIs, but the UI has only
    been exercised on desktop.
