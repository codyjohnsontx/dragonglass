# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

## Orientation

- Obsidian community plugin, TypeScript, esbuild, zero runtime deps. Commands: `npm run build`, `npm test`, `npm run lint` (see README "Development").
- Layout and trust boundaries: `docs/architecture.md`. Why things are the way they are: `docs/decisions.md`. What is next: `docs/roadmap.md`.
- Plugin id `dragonglass-ai` is public API; never change it. Bump `manifest.json` + `versions.json` together (`npm version` runs `version-bump.mjs`).

## Testing

- Unit tests run in Node with `obsidian` aliased to `test/obsidian-stub.ts` (see `vitest.config.ts`); keep Obsidian-API code in `src/vault/obsidian-port.ts`, `src/providers/obsidian-http.ts` and `src/ui/` so everything else stays testable against `test/memory-vault.ts`.
- Adapter tests hit `test/fake-server/server.mjs` over real HTTP; it scripts the Ollama, OpenAI, Anthropic and Gemini wire formats (keys in its header comment) and must send CORS headers or in-app fetch from the `app://obsidian.md` origin fails.
- In-app check without a real model: build, run the fake server, `node scripts/e2e-vault.mjs <dir>`, launch Obsidian with `--user-data-dir=<dir>/userdata --remote-debugging-port=9333`, then drive it with `CHROME_DEVTOOLS_AXI_BROWSER_URL=http://127.0.0.1:9333 chrome-devtools-axi selectpage 1` and `eval`. A fresh vault opens in Restricted mode; `await app.plugins.setEnable(true); await app.plugins.enablePluginAndSave('dragonglass-ai')` clears it. In Obsidian 1.14 Settings opens in its own window with its own devtools page ("Settings - <vault> - Obsidian"); `chrome-devtools-axi selectpage <that page id>` screenshots it, and Notices raised from settings actions (connection tests) appear there, not in the main document. Settings values can also be read via DOM queries on `app.setting.activeTab.containerEl`.
- Same recipe against a real local model: pass `http://127.0.0.1:11434` as the base URL to `scripts/e2e-vault.mjs` and set `ollama.model` in the vault's plugin `data.json`. A fresh vault first shows a "trust the author" dialog that stays above plugin modals until dismissed. Ollama's own account of what the model received is the runner's `new prompt … n_tokens` line in `/opt/homebrew/var/log/ollama.log` (brew install); `prompt_eval_count` in the reply matches it.

## Sharp edges

- `eslint-plugin-obsidianmd` forbids inline `eslint-disable` of `no-restricted-globals`; the `fetch` exemption for the streaming transport lives in `eslint.config.mts` for `src/providers/http.ts` only. Streaming cannot use `requestUrl`.
- Settings use the declarative `getSettingDefinitions()` API (Obsidian 1.13+) with dotted keys; `minAppVersion` 1.13.2 comes from the `secret` control. Do not reintroduce `display()`.
- Write tools never write. Anything that changes a note goes through `ProposalEngine.apply` after user approval, and apply re-checks the content hash inside `Vault.process`.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
