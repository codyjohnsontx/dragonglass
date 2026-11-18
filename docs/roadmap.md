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
- **Batch review**: the proposals of one turn are reviewed as one grouped
  card with Approve all, Reject all and Undo all, each all or nothing with
  rollback; one proposal per note per turn; each note keeps its own controls.
- **Source markers**: answers cite `[[Note name]]` after each claim taken
  from a note, unsourced text is worded as the model's suggestion, and a
  sources list under the answer, checked against what the tools showed,
  flags cited notes whose text was not in the model's context. `[web N]`
  and "From the web" are ready for web results.
- **Internet fallback** through Tavily, the same for every provider: each
  search waits for the user's approval with its words editable, one approval
  lets the model read up to 3 result pages as length-capped plain text
  extracted in-house, web text is framed as untrusted, an optional
  preferred-sites list is searched first, `[web N]` markers link the pages,
  and Save to vault proposes a reviewed research note with its sources, the
  date and `from-web: true`. Not yet run against the live Tavily API.
- **Related notes**: a `related_notes` read tool ranks the notes connected to
  one note by direct links, co-citation, shared outgoing links and shared
  tags, read from the metadata cache, each with short reasons the model can
  explain ("both link to [[Fort Ashen]]", "shares #faction/ember"); the
  system prompt points the model at it for questions about a character,
  place, faction or what else connects to something.
- **More write tools**, each a reviewed proposal in the turn's batch:
  create folder, move or rename a note through `FileManager.renameFile`
  (links follow the user's setting; the review lists the notes whose links
  change), set or remove properties through `FileManager.processFrontMatter`
  (reviewed as old and new values), and `replace_section` in
  `propose_edit_note` to rewrite one section by heading. Moves and property
  changes revert; folders, like created notes, do not.
- **Writing assistant, build 1: drafting.** Dragonglass's purpose is a
  screenplay written beside the vault that holds its lore. Drafts appear in
  the chat as a draft card after the model looks the named characters and
  places up and cites them; they match the open note's format (Fountain,
  Markdown screenplay or prose, Fountain by default); each revision is a full
  rewrite with earlier versions a click away in the card; Insert puts the
  version shown over the selection or at the cursor of the open note through
  the normal review; an optional script folder keeps script pages out of lore
  searches. Build 3 follows below.
- **Writing assistant, build 2: lore check.** Check lore in the chat checks
  the open note or its selection against the vault for contradictions of
  relationships, timeline and voice. The notes the script names go with the
  check, and each issue is listed with its line and the note it contradicts,
  checked against the script and against what the model was shown. Fix it
  proposes the corrected line through the review; Intentional proposes adding
  the change to a sequel canon note, at a configurable path, created if absent.
  That note goes with every message and the model is told it overrides the
  lore for drafting and for the check; a line recorded through Intentional is
  not flagged again, while canon in the owner's own words is not guaranteed
  to hold (decision 22).

## Next

1. **Sequel canon second pass**: test each lore flag and each draft against
   the sequel canon note before it reaches the card, so canon in the owner's
   own words holds (decision 22), and decide whether to withhold write tools
   on draft requests.
2. **Writing assistant, build 3: brainstorm cards**: 3 to 5 short pitch
   cards for a beat before drafting, each with a "draft this" button, and a
   way to combine pitches ("combine 2 and 4"). Punch-up and reader notes come
   after these.
3. **Review outcome to the model**: tell the model on the next turn which of
   its proposals were approved, rejected or undone, so it does not assume a
   change it proposed was made. Today it learns only that the user must
   approve.
4. **Propose wikilinks**: suggest links between related notes, each with its
   reason, as reviewed edits.
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
