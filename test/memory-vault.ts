import { StoreBackend } from '../src/persistence/store';
import { ActiveContext, NoteMetadata, VaultChange, VaultFileInfo, VaultFolderInfo, VaultPort } from '../src/vault/port';
import { baseName, parentFolder } from '../src/vault/paths';

/** In-memory VaultPort + StoreBackend for tests. Mirrors Obsidian semantics closely enough. */
export class MemoryVaultPort implements VaultPort, StoreBackend {
	readonly configDir = '.obsidian';
	files = new Map<string, string>();
	folders = new Set<string>();
	pluginFiles = new Map<string, string>();
	active: ActiveContext = { path: null, selection: null };
	private listeners = new Set<(change: VaultChange) => void>();
	private clock = 1_700_000_000_000;

	constructor(initial: Record<string, string> = {}) {
		for (const [path, content] of Object.entries(initial)) this.seed(path, content);
	}

	seed(path: string, content: string): void {
		const existed = this.files.has(path);
		this.files.set(path, content);
		this.emit({ type: existed ? 'modify' : 'create', path });
		let folder = parentFolder(path);
		while (folder) {
			this.folders.add(folder);
			folder = parentFolder(folder);
		}
	}

	listMarkdownFiles(): VaultFileInfo[] {
		return [...this.files.entries()]
			.filter(([p]) => p.endsWith('.md'))
			.map(([path, content]) => ({ path, name: baseName(path), size: content.length, mtime: this.clock }));
	}

	listFolder(folderPath: string): VaultFolderInfo | null {
		if (folderPath !== '' && !this.folders.has(folderPath)) return null;
		const children = new Set<string>();
		const prefix = folderPath === '' ? '' : `${folderPath}/`;
		for (const p of [...this.files.keys(), ...this.folders]) {
			if (!p.startsWith(prefix) || p === folderPath) continue;
			const rest = p.slice(prefix.length);
			const first = rest.split('/')[0];
			if (first) children.add(prefix + first);
		}
		return { path: folderPath, children: [...children] };
	}

	exists(path: string): boolean {
		return this.files.has(path) || this.folders.has(path);
	}

	isFolder(path: string): boolean {
		return this.folders.has(path);
	}

	readNote(path: string): Promise<string | null> {
		return Promise.resolve(this.files.get(path) ?? null);
	}

	getMetadata(path: string): NoteMetadata | null {
		const content = this.files.get(path);
		if (content === undefined) return null;
		const fm = parseFrontmatter(content);
		const tags = [...content.matchAll(/(?:^|\s)(#[\w/-]+)/g)].map((m) => m[1] as string);
		const headings = [...content.matchAll(/^(#{1,6})\s+(.+)$/gm)].map((m) => ({ level: (m[1] as string).length, text: m[2] as string }));
		const outgoing: string[] = [];
		const unresolved: string[] = [];
		for (const m of content.matchAll(/\[\[([^\]|#]+)/g)) {
			const target = this.resolveLink(m[1] as string);
			if (target) outgoing.push(target);
			else unresolved.push(m[1] as string);
		}
		const backlinks: string[] = [];
		for (const [other, otherContent] of this.files) {
			if (other === path) continue;
			for (const m of otherContent.matchAll(/\[\[([^\]|#]+)/g)) {
				if (this.resolveLink(m[1] as string) === path) backlinks.push(other);
			}
		}
		return { path, frontmatter: fm, tags, headings, outgoingLinks: [...new Set(outgoing)], unresolvedLinks: unresolved, backlinks: [...new Set(backlinks)].sort() };
	}

	private resolveLink(link: string): string | null {
		const name = link.trim();
		for (const p of this.files.keys()) {
			if (p === name || p === `${name}.md` || baseName(p) === name) return p;
		}
		return null;
	}

	createNote(path: string, content: string): Promise<void> {
		if (this.files.has(path)) return Promise.reject(new Error(`File already exists: ${path}`));
		this.seed(path, content);
		return Promise.resolve();
	}

	processNote(path: string, fn: (current: string) => string): Promise<void> {
		const current = this.files.get(path);
		if (current === undefined) return Promise.reject(new Error(`No note at ${path}`));
		this.files.set(path, fn(current));
		this.emit({ type: 'modify', path });
		return Promise.resolve();
	}

	/** Delete a note, or a folder and everything in it, reporting each path like Obsidian does. */
	delete(path: string): void {
		const prefix = `${path}/`;
		const wasFolder = this.folders.has(path);
		for (const p of [...this.files.keys()]) {
			if (p !== path && !p.startsWith(prefix)) continue;
			this.files.delete(p);
			this.emit({ type: 'delete', path: p });
		}
		for (const f of [...this.folders]) if (f === path || f.startsWith(prefix)) this.folders.delete(f);
		if (wasFolder) this.emit({ type: 'delete', path });
	}

	/**
	 * Rename a note or a folder. Like Obsidian (1.14), a folder reports a
	 * rename for itself first and then one for every file under it.
	 */
	rename(oldPath: string, newPath: string): void {
		const prefix = `${oldPath}/`;
		const moved: Array<[string, string]> = [];
		for (const [p, content] of [...this.files]) {
			if (p !== oldPath && !p.startsWith(prefix)) continue;
			this.files.delete(p);
			this.files.set(newPath + p.slice(oldPath.length), content);
			moved.push([newPath + p.slice(oldPath.length), p]);
		}
		for (const f of [...this.folders]) {
			if (f !== oldPath && !f.startsWith(prefix)) continue;
			this.folders.delete(f);
			this.folders.add(newPath + f.slice(oldPath.length));
		}
		let folder = parentFolder(newPath);
		while (folder) {
			this.folders.add(folder);
			folder = parentFolder(folder);
		}
		this.emit({ type: 'rename', path: newPath, oldPath });
		for (const [path, old] of moved) if (old !== oldPath) this.emit({ type: 'rename', path, oldPath: old });
	}

	onChange(listener: (change: VaultChange) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private emit(change: VaultChange): void {
		this.listeners.forEach((l) => l(change));
	}

	writePluginFile(rel: string, content: string): Promise<void> {
		this.pluginFiles.set(rel, content);
		return Promise.resolve();
	}

	readPluginFile(rel: string): Promise<string | null> {
		return Promise.resolve(this.pluginFiles.get(rel) ?? null);
	}

	listPluginFiles(relDir: string): Promise<string[]> {
		return Promise.resolve([...this.pluginFiles.keys()].filter((k) => k.startsWith(`${relDir}/`)));
	}

	deletePluginFile(rel: string): Promise<void> {
		this.pluginFiles.delete(rel);
		return Promise.resolve();
	}

	getActiveContext(): ActiveContext {
		return this.active;
	}

	// StoreBackend
	read = (rel: string): Promise<string | null> => this.readPluginFile(rel);
	write = (rel: string, content: string): Promise<void> => this.writePluginFile(rel, content);
	remove = (rel: string): Promise<void> => this.deletePluginFile(rel);
	list = (relDir: string): Promise<string[]> => this.listPluginFiles(relDir);
}

function parseFrontmatter(content: string): Record<string, unknown> | null {
	const m = /^---\n([\s\S]*?)\n---\n/.exec(content);
	if (!m) return null;
	const out: Record<string, unknown> = {};
	for (const line of (m[1] as string).split('\n')) {
		const idx = line.indexOf(':');
		if (idx < 0) continue;
		out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
	}
	return out;
}
