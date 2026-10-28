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
Ollama allows the `app://` origin by default and OpenAI sends permissive CORS
headers, so this works out of the box. Users behind a stricter Ollama config
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
Ollama and OpenAI wire formats with scripted behaviour. The same server backs
the in-app end-to-end check, so the chat, tool loop, diff and apply path were
exercised in a real Obsidian instance without a live model.
