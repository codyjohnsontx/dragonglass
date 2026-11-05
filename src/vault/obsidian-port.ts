import type { CachedMetadata } from 'obsidian';
import { App, MarkdownView, normalizePath, Plugin, TFile, TFolder, WorkspaceLeaf } from 'obsidian';
import { ActiveContext, InsertTarget, LinkRef, NoteLinks, NoteMetadata, VaultChange, VaultFileInfo, VaultFolderInfo, VaultPort } from './port';
import { parentFolder } from './paths';
import { StoreBackend } from '../persistence/store';

/** How long an insert waits for an editor save already in flight to reach the vault, and how often it looks. */
const SAVE_WAIT_MS = 2000;
const SAVE_POLL_MS = 50;

/** How long a rename or link lookup waits for Obsidian to index notes this port wrote before it goes ahead anyway. */
const INDEX_WAIT_MS = 5000;

/** VaultPort backed by the live Obsidian App. Thin by design; logic lives in the port's callers. */
export class ObsidianVaultPort implements VaultPort, StoreBackend {
	readonly configDir: string;
	private lastMarkdownLeaf: WorkspaceLeaf | null = null;
	private readonly changeListeners = new Set<(change: VaultChange) => void>();
	private listeningToVault = false;
	/**
	 * Notes this port wrote, or a rename through it rewrote links in, that
	 * Obsidian has not indexed yet. It parses a note into `resolvedLinks`
	 * some time after the write, and both `renameFile` and `linksTo` read
	 * links from there.
	 */
	private readonly unindexed = new Set<string>();
	private readonly indexWaiters = new Set<() => void>();

	constructor(
		private readonly app: App,
		private readonly plugin: Plugin,
	) {
		this.configDir = app.vault.configDir;
		plugin.registerEvent(
			app.workspace.on('active-leaf-change', (leaf) => {
				if (leaf?.view instanceof MarkdownView) this.lastMarkdownLeaf = leaf;
			}),
		);
		plugin.registerEvent(
			app.metadataCache.on('resolve', (file) => {
				this.unindexed.delete(file.path);
				this.releaseIndexWaiters();
			}),
		);
		app.workspace.onLayoutReady(() => {
			if (!this.lastMarkdownLeaf) this.lastMarkdownLeaf = app.workspace.getActiveViewOfType(MarkdownView)?.leaf ?? null;
		});
	}

	listMarkdownFiles(): VaultFileInfo[] {
		return this.app.vault.getMarkdownFiles().map((f) => ({
			path: f.path,
			name: f.basename,
			size: f.stat.size,
			mtime: f.stat.mtime,
		}));
	}

	listFolder(folderPath: string): VaultFolderInfo | null {
		const folder = folderPath === '' ? this.app.vault.getRoot() : this.app.vault.getFolderByPath(folderPath);
		if (!folder) return null;
		return { path: folder.path, children: folder.children.map((c) => c.path) };
	}

	exists(path: string): boolean {
		return this.app.vault.getAbstractFileByPath(path) !== null;
	}

	isFolder(path: string): boolean {
		return this.app.vault.getAbstractFileByPath(path) instanceof TFolder;
	}

	async readNote(path: string): Promise<string | null> {
		const file = this.app.vault.getFileByPath(path);
		if (!file) return null;
		return this.app.vault.cachedRead(file);
	}

	getMetadata(path: string): NoteMetadata | null {
		const file = this.app.vault.getFileByPath(path);
		if (!file) return null;
		const cache = this.app.metadataCache.getFileCache(file);
		const tags = noteTags(cache);
		const resolved = this.app.metadataCache.resolvedLinks[path] ?? {};
		const unresolved = this.app.metadataCache.unresolvedLinks[path] ?? {};
		const backlinks: string[] = [];
		for (const [source, targets] of Object.entries(this.app.metadataCache.resolvedLinks)) {
			if (targets[path]) backlinks.push(source);
		}
		const frontmatter = cache?.frontmatter ? { ...cache.frontmatter } : null;
		return {
			path,
			frontmatter,
			tags,
			headings: (cache?.headings ?? []).map((h) => ({ level: h.level, text: h.heading })),
			outgoingLinks: Object.keys(resolved),
			unresolvedLinks: Object.keys(unresolved),
			backlinks: backlinks.sort(),
		};
	}

	linkGraph(): NoteLinks[] {
		const { metadataCache } = this.app;
		return this.app.vault.getMarkdownFiles().map((f) => ({
			path: f.path,
			outgoingLinks: Object.keys(metadataCache.resolvedLinks[f.path] ?? {}),
			tags: noteTags(metadataCache.getFileCache(f)),
		}));
	}

	async createNote(path: string, content: string): Promise<void> {
		const folder = parentFolder(path);
		if (folder && !this.app.vault.getFolderByPath(folder)) {
			await this.app.vault.createFolder(folder);
		}
		await this.writing(path, () => this.app.vault.create(path, content));
	}

	async processNote(path: string, fn: (current: string) => string): Promise<void> {
		const file = this.app.vault.getFileByPath(path);
		if (!file) throw new Error(`No note at ${path}`);
		await this.writing(path, () => this.app.vault.process(file, fn));
	}

	async createFolder(path: string): Promise<void> {
		await this.app.vault.createFolder(path);
	}

	async moveNote(from: string, to: string): Promise<void> {
		const file = this.app.vault.getFileByPath(from);
		if (!file) throw new Error(`No note at ${from}`);
		if (this.app.vault.getAbstractFileByPath(to)) throw new Error(`A file already exists at ${to}`);
		const folder = parentFolder(to);
		if (folder && !this.app.vault.getFolderByPath(folder)) await this.app.vault.createFolder(folder);
		await this.whenIndexed();
		const rewritten = this.app.vault.on('modify', (f) => {
			if (f instanceof TFile && f.extension === 'md') this.unindexed.add(f.path);
		});
		try {
			await this.app.fileManager.renameFile(file, to);
		} finally {
			this.app.vault.offref(rewritten);
		}
	}

	async processFrontMatter(path: string, fn: (frontmatter: Record<string, unknown>) => void): Promise<string> {
		const file = this.app.vault.getFileByPath(path);
		if (!file) throw new Error(`No note at ${path}`);
		await this.writing(path, () => this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => fn(fm)));
		return this.app.vault.read(file);
	}

	/** Track `path` as waiting to be indexed while `write` changes it; a write that fails leaves the index as it was. */
	private async writing<T>(path: string, write: () => Promise<T>): Promise<T> {
		this.unindexed.add(path);
		try {
			return await write();
		} catch (e) {
			this.unindexed.delete(path);
			this.releaseIndexWaiters();
			throw e;
		}
	}

	private releaseIndexWaiters(): void {
		if (this.unindexed.size === 0) [...this.indexWaiters].forEach((done) => done());
	}

	/** Resolves once Obsidian has indexed every note this port wrote, or after `INDEX_WAIT_MS` if it never reports one. */
	private whenIndexed(): Promise<void> {
		if (this.unindexed.size === 0) return Promise.resolve();
		return new Promise((resolve) => {
			const done = () => {
				window.clearTimeout(timer);
				this.indexWaiters.delete(done);
				resolve();
			};
			const timer = window.setTimeout(() => {
				this.unindexed.clear();
				this.releaseIndexWaiters();
			}, INDEX_WAIT_MS);
			this.indexWaiters.add(done);
		});
	}

	async linksTo(path: string): Promise<LinkRef[]> {
		await this.whenIndexed();
		const refs: LinkRef[] = [];
		for (const [source, targets] of Object.entries(this.app.metadataCache.resolvedLinks)) {
			if (source === path || !targets[path]) continue;
			const file = this.app.vault.getFileByPath(source);
			const cache = file ? this.app.metadataCache.getFileCache(file) : null;
			for (const ref of [...(cache?.links ?? []), ...(cache?.embeds ?? []), ...(cache?.frontmatterLinks ?? [])]) {
				const link = ref.link.split(/[#|]/)[0] ?? '';
				if (this.app.metadataCache.getFirstLinkpathDest(link, source)?.path === path) refs.push({ source, link });
			}
		}
		return refs;
	}

	async trashFolder(path: string): Promise<void> {
		const folder = this.app.vault.getFolderByPath(path);
		if (!folder) throw new Error(`No folder at ${path}`);
		await this.app.fileManager.trashFile(folder);
	}

	/** Obsidian's own trash, honouring the user's "Deleted files" preference; never `Vault.delete`. */
	async trashNote(path: string): Promise<void> {
		const file = this.app.vault.getFileByPath(path);
		if (!file) throw new Error(`No note at ${path}`);
		await this.app.fileManager.trashFile(file);
	}

	/** The Markdown view the user was last in, while it is still open; else whatever Markdown view is active. */
	private markdownView(): MarkdownView | null {
		const leaf = this.lastMarkdownLeaf;
		const tracked =
			leaf?.view instanceof MarkdownView && this.app.workspace.getLeavesOfType('markdown').includes(leaf) ? leaf.view : null;
		return tracked ?? this.app.workspace.getActiveViewOfType(MarkdownView);
	}

	getActiveContext(): ActiveContext {
		const view = this.markdownView();
		const file = view?.file ?? this.app.workspace.getActiveFile();
		const selection = view?.editor.getSelection() ?? '';
		return { path: file instanceof TFile ? file.path : null, selection: selection.length > 0 ? selection : null };
	}

	/**
	 * The editor's text and selection at the moment of an insert. Pending
	 * edits are saved first so the vault holds what the editor shows and the
	 * proposal's freshness check passes. When the editor's own save is already
	 * writing (the blur from clicking Insert starts one), `save()` returns
	 * before that write lands, so this waits a short while for the vault to
	 * catch up. A save that fails or never lands leaves the text as it is and
	 * the proposal engine reports the mismatch.
	 */
	async getInsertTarget(): Promise<InsertTarget | null> {
		const view = this.markdownView();
		const file = view?.file;
		if (!view || !file) return null;
		try {
			await view.save();
		} catch {
			// Reported by the engine's unsaved-changes check.
		}
		const editor = view.editor;
		for (let waited = 0; waited < SAVE_WAIT_MS && (await this.app.vault.cachedRead(file)) !== editor.getValue(); waited += SAVE_POLL_MS) {
			await new Promise((resolve) => window.setTimeout(resolve, SAVE_POLL_MS));
		}
		return {
			path: file.path,
			content: editor.getValue(),
			from: editor.posToOffset(editor.getCursor('from')),
			to: editor.posToOffset(editor.getCursor('to')),
		};
	}

	/**
	 * Vault events are registered on the first listener. Subscribe after the
	 * layout is ready: before that, Obsidian reports every existing file as
	 * created while it loads the vault.
	 */
	onChange(listener: (change: VaultChange) => void): () => void {
		if (!this.listeningToVault) {
			this.listeningToVault = true;
			const emit = (change: VaultChange) => this.changeListeners.forEach((l) => l(change));
			const { vault } = this.app;
			this.plugin.registerEvent(vault.on('create', (f) => emit({ type: 'create', path: f.path })));
			this.plugin.registerEvent(vault.on('modify', (f) => emit({ type: 'modify', path: f.path })));
			this.plugin.registerEvent(vault.on('delete', (f) => emit({ type: 'delete', path: f.path })));
			this.plugin.registerEvent(vault.on('rename', (f, oldPath) => emit({ type: 'rename', path: f.path, oldPath })));
		}
		this.changeListeners.add(listener);
		return () => this.changeListeners.delete(listener);
	}

	// --- plugin-private files (snapshots, conversations) ---

	private pluginPath(rel: string): string {
		const dir = this.plugin.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.plugin.manifest.id}`;
		return normalizePath(`${dir}/${rel}`);
	}

	async writePluginFile(relativePath: string, content: string): Promise<void> {
		const full = this.pluginPath(relativePath);
		const dir = parentFolder(full);
		if (!(await this.app.vault.adapter.exists(dir))) await this.app.vault.adapter.mkdir(dir);
		await this.app.vault.adapter.write(full, content);
	}

	async readPluginFile(relativePath: string): Promise<string | null> {
		const full = this.pluginPath(relativePath);
		if (!(await this.app.vault.adapter.exists(full))) return null;
		return this.app.vault.adapter.read(full);
	}

	async listPluginFiles(relativeDir: string): Promise<string[]> {
		const full = this.pluginPath(relativeDir);
		if (!(await this.app.vault.adapter.exists(full))) return [];
		const listing = await this.app.vault.adapter.list(full);
		const prefix = this.pluginPath('');
		return listing.files.map((f) => f.startsWith(`${prefix}/`) ? f.slice(prefix.length + 1) : f);
	}

	async deletePluginFile(relativePath: string): Promise<void> {
		const full = this.pluginPath(relativePath);
		if (await this.app.vault.adapter.exists(full)) await this.app.vault.adapter.remove(full);
	}

	// StoreBackend
	read(relativePath: string): Promise<string | null> {
		return this.readPluginFile(relativePath);
	}
	write(relativePath: string, content: string): Promise<void> {
		return this.writePluginFile(relativePath, content);
	}
	remove(relativePath: string): Promise<void> {
		return this.deletePluginFile(relativePath);
	}
	list(relativeDir: string): Promise<string[]> {
		return this.listPluginFiles(relativeDir);
	}
}

/** Body tags and the `tags` property, each once, with `#`. */
function noteTags(cache: CachedMetadata | null): string[] {
	const tags = new Set<string>();
	for (const t of cache?.tags ?? []) tags.add(t.tag);
	const fmTags = cache?.frontmatter?.['tags'] as unknown;
	if (Array.isArray(fmTags)) fmTags.forEach((t) => typeof t === 'string' && tags.add(t.startsWith('#') ? t : `#${t}`));
	else if (typeof fmTags === 'string') tags.add(fmTags.startsWith('#') ? fmTags : `#${fmTags}`);
	return [...tags];
}
