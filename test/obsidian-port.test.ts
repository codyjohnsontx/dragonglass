import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { App, Plugin } from 'obsidian';
import { MarkdownView, TFile } from 'obsidian';
import { ObsidianVaultPort } from '../src/vault/obsidian-port';

interface FakeLeaf {
	view: unknown;
}

function noteLeaf(path: string, selection: string): FakeLeaf {
	const leaf: FakeLeaf = { view: null };
	leaf.view = Object.assign(new MarkdownView(), {
		leaf,
		file: Object.assign(new TFile(), { path }),
		editor: { getSelection: () => selection },
	});
	return leaf;
}

function fakeWorkspace(initialActive: FakeLeaf | null) {
	const handlers: Array<(leaf: FakeLeaf | null) => void> = [];
	const state = {
		active: initialActive,
		leaves: initialActive ? [initialActive] : ([] as FakeLeaf[]),
		activeFile: null as TFile | null,
	};
	const workspace = {
		on: (_name: string, cb: (leaf: FakeLeaf | null) => void) => {
			handlers.push(cb);
			return {};
		},
		onLayoutReady: (cb: () => void) => cb(),
		getActiveViewOfType: () => (state.active?.view instanceof MarkdownView ? state.active.view : null),
		getLeavesOfType: () => state.leaves,
		getActiveFile: () => state.activeFile,
	};
	const activate = (leaf: FakeLeaf) => {
		if (!state.leaves.includes(leaf)) state.leaves.push(leaf);
		state.active = leaf;
		for (const h of handlers) h(leaf);
	};
	const app = { vault: { configDir: '.obsidian' }, workspace } as unknown as App;
	const plugin = { registerEvent: () => undefined } as unknown as Plugin;
	return { port: new ObsidianVaultPort(app, plugin), state, activate };
}

const chatLeaf: FakeLeaf = { view: {} };

describe('ObsidianVaultPort.getActiveContext', () => {
	it('keeps the note focused before the plugin loaded once the chat takes focus', () => {
		const a = noteLeaf('A.md', 'picked text');
		const { port, activate } = fakeWorkspace(a);
		activate(chatLeaf);
		expect(port.getActiveContext()).toEqual({ path: 'A.md', selection: 'picked text' });
	});

	it('follows the last editor across windows, not the main split', () => {
		const a = noteLeaf('A.md', '');
		const b = noteLeaf('Popout/B.md', 'from popout');
		const { port, activate } = fakeWorkspace(a);
		activate(b);
		activate(chatLeaf);
		expect(port.getActiveContext()).toEqual({ path: 'Popout/B.md', selection: 'from popout' });
	});

	it('drops a closed editor and falls back to the active file', () => {
		const a = noteLeaf('A.md', 'gone');
		const { port, state, activate } = fakeWorkspace(a);
		activate(chatLeaf);
		state.leaves = state.leaves.filter((l) => l !== a);
		state.activeFile = Object.assign(new TFile(), { path: 'Other.md' });
		expect(port.getActiveContext()).toEqual({ path: 'Other.md', selection: null });
	});
});

/**
 * An editor whose own save is already writing when the insert asks for one,
 * as on the blur from clicking Insert: Obsidian's `save()` then returns at
 * once, and the vault holds the old text until that write lands.
 */
function savingEditorPort(writeMs: number) {
	const file = Object.assign(new TFile(), { path: 'Script/Scene.md' });
	let disk = 'KAEL\nAgain.\n';
	const typed = 'KAEL\nAgain. Now.\n';
	setTimeout(() => (disk = typed), writeMs);
	const leaf: FakeLeaf = { view: null };
	leaf.view = Object.assign(new MarkdownView(), {
		leaf,
		file,
		save: () => Promise.resolve(),
		editor: {
			getSelection: () => '',
			getValue: () => typed,
			getCursor: () => ({ line: 1, ch: 6 }),
			posToOffset: () => 11,
		},
	});
	const { port } = fakeWorkspace(leaf);
	const vault = (port as unknown as { app: { vault: Record<string, unknown> } }).app.vault;
	vault.getFileByPath = () => file;
	vault.cachedRead = () => Promise.resolve(disk);
	return { port, typed };
}

describe('ObsidianVaultPort.getInsertTarget', () => {
	beforeEach(() => vi.stubGlobal('window', globalThis));
	afterEach(() => vi.unstubAllGlobals());

	it('waits for an editor save already in flight, so the vault holds the typed text', async () => {
		const { port, typed } = savingEditorPort(150);
		const target = await port.getInsertTarget();
		expect(target?.content).toBe(typed);
		expect(await port.readNote('Script/Scene.md')).toBe(typed);
	});
});
