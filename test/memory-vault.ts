import { StoreBackend } from '../src/persistence/store';
import { ActiveContext, LinkRef, NoteMetadata, VaultChange, VaultFileInfo, VaultFolderInfo, VaultPort } from '../src/vault/port';
import { baseName, parentFolder } from '../src/vault/paths';

/** In-memory VaultPort + StoreBackend for tests. Mirrors Obsidian semantics closely enough. */
export class MemoryVaultPort implements VaultPort, StoreBackend {
	readonly configDir = '.obsidian';
	files = new Map<string, string>();
	folders = new Set<string>();
	pluginFiles = new Map<string, string>();
	/** Notes moved to the trash, by their former path, with the content they held. */
	trashed = new Map<string, string>();
	/** Folders moved to the trash. */
	trashedFolders: string[] = [];
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

	createFolder(path: string): Promise<void> {
		if (this.exists(path)) return Promise.reject(new Error(`Folder already exists: ${path}`));
		let folder: string | null = path;
		while (folder) {
			this.folders.add(folder);
			folder = parentFolder(folder);
		}
		this.emit({ type: 'create', path });
		return Promise.resolve();
	}

	/**
	 * Like `FileManager.renameFile` with "Automatically update internal links"
	 * on: links in other notes that name the old path or the old name are
	 * rewritten to the new path (shortest form when the new name is unique).
	 */
	moveNote(from: string, to: string): Promise<void> {
		const content = this.files.get(from);
		if (content === undefined) return Promise.reject(new Error(`No note at ${from}`));
		if (this.exists(to)) return Promise.reject(new Error(`A file already exists at ${to}`));
		const refs = this.linksTo(from);
		this.rename(from, to);
		const oldName = baseName(from);
		const unique = [...this.files.keys()].filter((p) => baseName(p) === baseName(to)).length === 1;
		const target = unique ? baseName(to) : to.replace(/\.md$/, '');
		for (const source of new Set(refs.map((r) => r.source))) {
			const text = this.files.get(source);
			if (text === undefined) continue;
			const next = text.replace(/\[\[([^\]|#]+)/g, (whole, link: string) => {
				const l = link.trim();
				return l === oldName || l === from || l === from.replace(/\.md$/, '') ? `[[${target}` : whole;
			});
			if (next !== text) {
				this.files.set(source, next);
				this.emit({ type: 'modify', path: source });
			}
		}
		return Promise.resolve();
	}

	/** Parses and writes a small YAML subset (scalars and lists), enough for tests; Obsidian's own YAML is used in the app. */
	processFrontMatter(path: string, fn: (frontmatter: Record<string, unknown>) => void): Promise<string> {
		const content = this.files.get(path);
		if (content === undefined) return Promise.reject(new Error(`No note at ${path}`));
		const m = /^---\n([\s\S]*?)\n?---\n?/.exec(content);
		const fm = m ? parseYaml(m[1] ?? '') : {};
		try {
			fn(fm);
		} catch (e) {
			return Promise.reject(e instanceof Error ? e : new Error(String(e)));
		}
		const body = m ? content.slice(m[0].length) : content;
		const yaml = Object.keys(fm).length > 0 ? `---\n${toYaml(fm)}---\n` : '';
		const next = yaml + body;
		this.files.set(path, next);
		this.emit({ type: 'modify', path });
		return Promise.resolve(next);
	}

	linksTo(path: string): LinkRef[] {
		const refs: LinkRef[] = [];
		for (const [source, text] of this.files) {
			if (source === path) continue;
			for (const m of text.matchAll(/\[\[([^\]|#]+)/g)) {
				const link = (m[1] as string).trim();
				if (this.resolveLink(link) === path) refs.push({ source, link });
			}
		}
		return refs;
	}

	trashFolder(path: string): Promise<void> {
		if (!this.folders.has(path)) return Promise.reject(new Error(`No folder at ${path}`));
		this.delete(path);
		this.trashedFolders.push(path);
		return Promise.resolve();
	}

	trashNote(path: string): Promise<void> {
		const content = this.files.get(path);
		if (content === undefined) return Promise.reject(new Error(`No note at ${path}`));
		this.trashed.set(path, content);
		this.files.delete(path);
		this.emit({ type: 'delete', path });
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
	return parseYaml(m[1] as string);
}

function parseScalar(text: string): unknown {
	const t = text.trim();
	if (t === '') return null;
	if (t === 'true' || t === 'false') return t === 'true';
	if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
	if (/^".*"$/.test(t)) return JSON.parse(t) as unknown;
	if (t.startsWith('[') && t.endsWith(']')) return t.slice(1, -1).split(',').map((v) => parseScalar(v)).filter((v) => v !== null);
	return t;
}

/** `key: value` lines, and `key:` followed by `  - item` lines for lists. */
function parseYaml(yaml: string): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	let list: unknown[] | null = null;
	for (const line of yaml.split('\n')) {
		const item = /^\s+-\s*(.*)$/.exec(line);
		if (item && list) {
			list.push(parseScalar(item[1] as string));
			continue;
		}
		const idx = line.indexOf(':');
		if (idx < 0) continue;
		const key = line.slice(0, idx).trim();
		const rest = line.slice(idx + 1);
		if (rest.trim() === '') {
			list = [];
			out[key] = list;
		} else {
			list = null;
			out[key] = parseScalar(rest);
		}
	}
	for (const [k, v] of Object.entries(out)) if (Array.isArray(v) && v.length === 0) out[k] = null;
	return out;
}

function toYaml(fm: Record<string, unknown>): string {
	let out = '';
	for (const [key, value] of Object.entries(fm)) {
		if (Array.isArray(value)) out += `${key}:\n${value.map((v) => `  - ${String(v)}\n`).join('')}`;
		else if (value === null) out += `${key}:\n`;
		else out += `${key}: ${typeof value === 'string' && /^(true|false|-?\d+(\.\d+)?)$/.test(value) ? JSON.stringify(value) : String(value)}\n`;
	}
	return out;
}
