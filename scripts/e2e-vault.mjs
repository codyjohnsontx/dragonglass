/**
 * Builds a disposable Obsidian vault + isolated Electron user-data directory
 * for manual or automated end-to-end checks. Never touches real vaults.
 *
 *   node scripts/e2e-vault.mjs <workdir> [fakeServerBaseUrl]
 *
 * Creates <workdir>/vault (with the plugin installed from ./main.js) and
 * <workdir>/userdata (with the vault registered and set to open), then prints
 * the launch command. Run `npm run build` first.
 */
import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const workdir = resolve(process.argv[2] ?? '.e2e');
const fakeBase = process.argv[3] ?? 'http://127.0.0.1:11435';
const vault = resolve(workdir, 'vault');
const userData = resolve(workdir, 'userdata');
const pluginDir = resolve(vault, '.obsidian', 'plugins', 'dragonglass-ai');

for (const d of [vault, userData, pluginDir, resolve(vault, 'Projects')]) mkdirSync(d, { recursive: true });

if (!existsSync('main.js')) {
	console.error('main.js not found; run `npm run build` first');
	process.exit(1);
}
for (const f of ['main.js', 'manifest.json', 'styles.css']) cpSync(f, resolve(pluginDir, f));

writeFileSync(
	resolve(pluginDir, 'data.json'),
	JSON.stringify(
		{
			activeProvider: 'ollama',
			ollama: { baseUrl: fakeBase, model: 'fake-tools' },
			openai: { apiKeySecretId: '', model: 'fake-gpt', baseUrl: `${fakeBase}/v1` },
			anthropic: { apiKeySecretId: '', model: 'fake-claude', baseUrl: `${fakeBase}/anthropic/v1`, maxTokens: 1024 },
			gemini: { apiKeySecretId: '', model: 'fake-gemini', baseUrl: `${fakeBase}/gemini/v1beta` },
			custom: { apiKeySecretId: '', model: 'local-model', baseUrl: `${fakeBase}/local/v1`, auth: 'none' },
		},
		null,
		2,
	),
);

writeFileSync(resolve(vault, '.obsidian', 'community-plugins.json'), JSON.stringify(['dragonglass-ai']));
writeFileSync(resolve(vault, '.obsidian', 'app.json'), JSON.stringify({}));

writeFileSync(
	resolve(vault, 'Projects', 'Launch.md'),
	'---\nstatus: active\n---\n# Launch\n\nLaunch date: November 1.\n\nDepends on [[Milestones]].\n',
);
writeFileSync(resolve(vault, 'Projects', 'Milestones.md'), '# Milestones\n\n- Beta: October 20\n- Launch: see [[Launch]]\n');
writeFileSync(resolve(vault, 'Welcome.md'), '# Welcome\n\nThis is a disposable test vault for Dragonglass AI.\n');

const vaultId = 'e2e0000000000001';
writeFileSync(
	resolve(userData, 'obsidian.json'),
	JSON.stringify({ vaults: { [vaultId]: { path: vault, ts: Date.now(), open: true } } }),
);

console.log(`vault:    ${vault}`);
console.log(`userdata: ${userData}`);
console.log('launch:');
console.log(
	`  /Applications/Obsidian.app/Contents/MacOS/Obsidian --user-data-dir='${userData}' --remote-debugging-port=9333`,
);
