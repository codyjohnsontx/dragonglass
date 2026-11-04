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
- **Search index**: in-memory BM25 over note names, headings and content,
  kept current from vault events, and search results that carry the full
  text of the best matches within a token budget.
- **OpenAI Responses API** for models that take tool calls only there
  (GPT-6.1 Sol and Terra), statelessly with `store: false`; other OpenAI
  models and the custom endpoint stay on Chat Completions.
- **Source markers**: answers cite `[[Note name]]` after each claim taken
  from a note, unsourced text is worded as the model's suggestion, and a
  sources list under the answer, checked against what the tools showed,
  flags cited notes whose text was not in the model's context. `[web N]` and "From the web" are
  ready for web results.

## Next

1. **Internet fallback**: when the vault lacks an answer, search the web. Ask
   before every search, showing the search words, which the user can edit.
   Dragonglass runs the search itself through one web search service whose
   key lives in settings, the same way for every provider including local
   Ollama models, and treats results as untrusted content. One approval lets
   the model read up to 3 of that search's result pages as length-capped
   plain text extracted in-house (no runtime dependency). Claims from pages
   carry `[web N]` markers and the pages appear under "From the web". A
   "Save to vault" button proposes a reviewed research note with the sources,
   the date and a from-the-web frontmatter marker. An optional preferred-sites
   list is searched first, widening to the whole web only if nothing turns
   up. Waits on the owner choosing a search service from a researched
   comparison.
2. **Batch review**: group proposals from one turn into a single review with
   approve-all, so multi-file changes are reviewed together.
3. **More write tools**: create folder, move/rename note, update frontmatter
   through `FileManager.processFrontMatter`, section-level replace by heading.
4. **Relationship tools**: "related notes" via shared links, tags and
   co-citation; propose wikilinks with reasons.
5. **Canvas**: read `.canvas` JSON, propose new boards and node/edge edits as
   reviewed file operations with schema validation.
6. **Bases**: read and propose `.base` files once the format is stable.
7. **Semantic retrieval**: optional local embeddings (Ollama embed models)
   fused with the keyword index, only if a measurement on a real vault shows
   they help; never required.
8. **Cost estimates** for paid providers from a maintained price table,
   clearly labelled as estimates.
9. **Mobile check**: the code avoids Node/Electron APIs, but the UI has only
   been exercised on desktop.
