import { App, MarkdownView, normalizePath, Plugin, TFile, TFolder } from 'obsidian';
import { ActiveContext, NoteMetadata, VaultFileInfo, VaultFolderInfo, VaultPort } from './port';
import { parentFolder } from './paths';
import { StoreBackend } from '../persistence/store';

/** VaultPort backed by the live Obsidian App. Thin by design; logic lives in the port's callers. */
export class ObsidianVaultPort implements VaultPort, StoreBackend {
	readonly configDir: string;

	constructor(
		private readonly app: App,
		private readonly plugin: Plugin,
	) {
		this.configDir = app.vault.configDir;
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
		const tags = new Set<string>();
		for (const t of cache?.tags ?? []) tags.add(t.tag);
		const fmTags = cache?.frontmatter?.['tags'] as unknown;
		if (Array.isArray(fmTags)) fmTags.forEach((t) => typeof t === 'string' && tags.add(t.startsWith('#') ? t : `#${t}`));
		else if (typeof fmTags === 'string') tags.add(fmTags.startsWith('#') ? fmTags : `#${fmTags}`);
		const resolved = this.app.metadataCache.resolvedLinks[path] ?? {};
		const unresolved = this.app.metadataCache.unresolvedLinks[path] ?? {};
		const backlinks: string[] = [];
		for (const [source, targets] of Object.entries(this.app.metadataCache.resolvedLinks)) {
			if (targets[path]) backlinks.push(source);
		}
		const frontmatter = cache?.frontmatter ? { ...cache.frontmatter } : null;
		if (frontmatter) delete frontmatter['position'];
		return {
			path,
			frontmatter,
			tags: [...tags],
			headings: (cache?.headings ?? []).map((h) => ({ level: h.level, text: h.heading })),
			outgoingLinks: Object.keys(resolved),
			unresolvedLinks: Object.keys(unresolved),
			backlinks: backlinks.sort(),
		};
	}

	async createNote(path: string, content: string): Promise<void> {
		const folder = parentFolder(path);
		if (folder && !this.app.vault.getFolderByPath(folder)) {
			await this.app.vault.createFolder(folder);
		}
		await this.app.vault.create(path, content);
	}

	async processNote(path: string, fn: (current: string) => string): Promise<void> {
		const file = this.app.vault.getFileByPath(path);
		if (!file) throw new Error(`No note at ${path}`);
		await this.app.vault.process(file, fn);
	}

	getActiveContext(): ActiveContext {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		const file = view?.file ?? this.app.workspace.getActiveFile();
		const selection = view?.editor.getSelection() ?? '';
		return { path: file instanceof TFile ? file.path : null, selection: selection.length > 0 ? selection : null };
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
