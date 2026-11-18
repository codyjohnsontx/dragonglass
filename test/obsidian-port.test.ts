import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { App, Plugin } from 'obsidian';
import { MarkdownView, TFile } from 'obsidian';
import { ObsidianVaultPort } from '../src/vault/obsidian-port';
import { ProposalError } from '../src/vault/proposals';

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
	const metadataCache = { on: () => ({}) };
	const app = { vault: { configDir: '.obsidian' }, workspace, metadataCache } as unknown as App;
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
function savingEditorPort(writeMs: number, mode: 'source' | 'preview' = 'source') {
	const file = Object.assign(new TFile(), { path: 'Script/Scene.md' });
	let disk = 'KAEL\nAgain.\n';
	const typed = 'KAEL\nAgain. Now.\n';
	setTimeout(() => (disk = typed), writeMs);
	const leaf: FakeLeaf = { view: null };
	leaf.view = Object.assign(new MarkdownView(), {
		leaf,
		file,
		getMode: () => mode,
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

	it('refuses a note in Reading mode at once, with what to do instead of the hidden editor\'s state', async () => {
		const { port } = savingEditorPort(0, 'preview');
		const refusal = port.getInsertTarget();
		await expect(refusal).rejects.toBeInstanceOf(ProposalError);
		await expect(refusal).rejects.toThrow(/Switch the note to editing/);
	});
});

/** An App whose index and rename can be stepped by hand: `resolve` is Obsidian finishing a note, `renameRewrites` the notes a rename rewrites. */
function fakeIndexedApp() {
	const noteFile = (path: string) => Object.assign(new TFile(), { path, extension: path.split('.').pop() });
	const modifyListeners = new Set<(file: TFile) => void>();
	const resolveListeners: Array<(file: TFile) => void> = [];
	const state = {
		renames: [] as string[],
		renameRewrites: [] as string[],
		renameFailure: null as Error | null,
		process: (): Promise<unknown> => Promise.resolve(),
		resolvedLinks: {} as Record<string, Record<string, number>>,
		links: {} as Record<string, Array<{ link: string }>>,
	};
	const modify = (path: string) => modifyListeners.forEach((l) => l(noteFile(path)));
	const app = {
		vault: {
			configDir: '.obsidian',
			getFileByPath: noteFile,
			getAbstractFileByPath: () => null,
			getFolderByPath: () => ({}),
			create: () => Promise.resolve(),
			process: () => state.process(),
			read: () => Promise.resolve(''),
			on: (_name: string, listener: (file: TFile) => void) => {
				modifyListeners.add(listener);
				return listener;
			},
			offref: (ref: (file: TFile) => void) => modifyListeners.delete(ref),
		},
		fileManager: {
			renameFile: (_file: TFile, to: string) => {
				state.renames.push(to);
				state.renameRewrites.forEach(modify);
				return state.renameFailure ? Promise.reject(state.renameFailure) : Promise.resolve();
			},
			processFrontMatter: () => Promise.resolve(),
		},
		metadataCache: {
			get resolvedLinks() {
				return state.resolvedLinks;
			},
			unresolvedLinks: {},
			on: (_name: string, listener: (file: TFile) => void) => {
				resolveListeners.push(listener);
				return {};
			},
			getFileCache: (file: TFile) => ({ links: state.links[file.path] ?? [], frontmatter: { position: 'Warden of the Gate' } }),
			getFirstLinkpathDest: (link: string) => ({ path: `${link}.md` }),
		},
		workspace: { on: () => ({}), onLayoutReady: () => undefined },
	} as unknown as App;
	const plugin = { registerEvent: () => undefined } as unknown as Plugin;
	const resolve = (path: string) => resolveListeners.forEach((l) => l(noteFile(path)));
	return { port: new ObsidianVaultPort(app, plugin), state, modify, resolve };
}

const settled = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('ObsidianVaultPort index wait', () => {
	const timers = new Map<number, () => void>();

	beforeEach(() => {
		let id = 0;
		timers.clear();
		vi.stubGlobal('window', {
			setTimeout: (fn: () => void) => {
				timers.set(++id, fn);
				return id;
			},
			clearTimeout: (timer: number) => timers.delete(timer),
		});
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('starts a second rename only once the notes the first rewrote are indexed', async () => {
		const { port, state, resolve } = fakeIndexedApp();
		state.renameRewrites = ['Act Two.md', 'Act Three.md'];
		await port.moveNote('Gate.md', 'Ember Gate.md');
		state.renameRewrites = [];

		const second = port.moveNote('Kael.md', 'Kael Varn.md');
		await settled();
		expect(state.renames).toEqual(['Ember Gate.md']);
		resolve('Act Two.md');
		await settled();
		expect(state.renames).toEqual(['Ember Gate.md']);
		resolve('Act Three.md');
		await second;
		expect(state.renames).toEqual(['Ember Gate.md', 'Kael Varn.md']);
		expect(timers.size).toBe(0);
	});

	it('does not wait for a file that is not a note', async () => {
		const { port, state } = fakeIndexedApp();
		state.renameRewrites = ['Board.canvas'];
		await port.moveNote('Gate.md', 'Ember Gate.md');
		await port.moveNote('Kael.md', 'Kael Varn.md');
		expect(state.renames).toEqual(['Ember Gate.md', 'Kael Varn.md']);
	});

	it.each([
		['processNote', (port: ObsidianVaultPort) => port.processNote('Act Two.md', (c) => c)],
		['createNote', (port: ObsidianVaultPort) => port.createNote('Act Two.md', '[[Gate]]')],
		['processFrontMatter', (port: ObsidianVaultPort) => port.processFrontMatter('Act Two.md', () => undefined)],
	])('reads links only once a note written through %s is indexed', async (_name, write) => {
		const { port, state, resolve } = fakeIndexedApp();
		await write(port);
		let found: unknown = null;
		const links = port.linksTo('Gate.md').then((refs) => (found = refs));
		await settled();
		expect(found).toBeNull();

		state.resolvedLinks = { 'Act Two.md': { 'Gate.md': 1 } };
		state.links = { 'Act Two.md': [{ link: 'Gate' }] };
		resolve('Act Two.md');
		await links;
		expect(found).toEqual([{ source: 'Act Two.md', link: 'Gate' }]);
	});

	it('leaves nothing to wait for after a write that failed', async () => {
		const { port, state } = fakeIndexedApp();
		state.process = () => Promise.reject(new Error('disk full'));
		await expect(port.processNote('Act Two.md', (c) => c)).rejects.toThrow('disk full');
		await port.moveNote('Gate.md', 'Ember Gate.md');
		expect(state.renames).toEqual(['Ember Gate.md']);
		expect(timers.size).toBe(0);
	});

	it('releases a rename already waiting when the write it waits for fails', async () => {
		const { port, state } = fakeIndexedApp();
		let fail: (e: Error) => void = () => undefined;
		state.process = () => new Promise((_, reject) => (fail = reject));
		const write = port.processNote('Act Two.md', (c) => c);
		const move = port.moveNote('Gate.md', 'Ember Gate.md');
		await settled();
		expect(state.renames).toEqual([]);
		fail(new Error('disk full'));
		await expect(write).rejects.toThrow('disk full');
		await move;
		expect(state.renames).toEqual(['Ember Gate.md']);
		expect(timers.size).toBe(0);
	});

	it('goes ahead after the timeout when Obsidian never reports the note, and does not wait for it again', async () => {
		const { port, state } = fakeIndexedApp();
		await port.processNote('Act Two.md', (c) => c);
		const first = port.moveNote('Gate.md', 'Ember Gate.md');
		const second = port.linksTo('Gate.md');
		await settled();
		expect(state.renames).toEqual([]);
		expect(timers.size).toBe(2);

		[...timers.values()][0]?.();
		await Promise.all([first, second]);
		expect(state.renames).toEqual(['Ember Gate.md']);
		expect(timers.size).toBe(0);
		await port.moveNote('Kael.md', 'Kael Varn.md');
		expect(state.renames).toEqual(['Ember Gate.md', 'Kael Varn.md']);
	});

	it.each([
		['succeeds', null],
		['fails', new Error('rename failed')],
	])('stops tracking changes once a rename %s', async (_name, failure) => {
		const { port, state, modify } = fakeIndexedApp();
		state.renameFailure = failure;
		await port.moveNote('Gate.md', 'Ember Gate.md').catch(() => undefined);
		state.renameFailure = null;
		modify('Unrelated.md');
		await port.moveNote('Kael.md', 'Kael Varn.md');
		expect(state.renames).toEqual(['Ember Gate.md', 'Kael Varn.md']);
		expect(timers.size).toBe(0);
	});
});

describe('ObsidianVaultPort.getMetadata', () => {
	it('keeps a property named position, which is the user\'s own', () => {
		const { port } = fakeIndexedApp();
		expect(port.getMetadata('Kael.md')?.frontmatter).toEqual({ position: 'Warden of the Gate' });
	});

	it('gives the same properties through getFrontmatter', () => {
		const { port } = fakeIndexedApp();
		expect(port.getFrontmatter('Kael.md')).toEqual({ position: 'Warden of the Gate' });
	});
});
