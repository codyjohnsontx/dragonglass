import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ActiveContext, NoteMetadata, VaultChange, VaultFileInfo, VaultFolderInfo, VaultPort } from '../../src/vault/port';
import { baseName } from '../../src/vault/paths';

/**
 * Read-only VaultPort over a folder of Markdown, shaped like
 * ObsidianVaultPort: note text held in memory as Obsidian's cache does,
 * `listMarkdownFiles` building fresh objects per call, and backlinks found
 * by scanning every note's resolved links. Writes are refused; nothing is
 * ever written into the folder. `renameInMemory` moves notes in the
 * in-memory copy only, reporting it like Obsidian, for benchmarks of how the
 * index follows changes.
 */
export class DirVaultPort implements VaultPort {
	readonly configDir = '.obsidian';
	readonly text = new Map<string, string>();
	private readonly folders = new Set<string>();
	private resolvedLinks: Record<string, Record<string, number>> = {};
	private unresolvedLinks: Record<string, Record<string, number>> = {};
	private readonly listeners = new Set<(change: VaultChange) => void>();

	constructor(readonly root: string) {
		this.scan('');
		this.resolveLinks();
	}

	private scan(rel: string): void {
		for (const entry of readdirSync(join(this.root, rel), { withFileTypes: true })) {
			if (entry.name.startsWith('.')) continue;
			const p = rel ? `${rel}/${entry.name}` : entry.name;
			if (entry.isDirectory()) {
				this.folders.add(p);
				this.scan(p);
			} else if (entry.name.endsWith('.md')) {
				this.text.set(p, readFileSync(join(this.root, p), 'utf8'));
			}
		}
	}

	private resolveLinks(): void {
		const byName = new Map<string, string[]>();
		for (const p of [...this.text.keys()].sort()) {
			const n = baseName(p).toLowerCase();
			byName.set(n, (byName.get(n) ?? []).concat(p));
		}
		for (const [p, content] of this.text) {
			const resolved: Record<string, number> = {};
			const unresolved: Record<string, number> = {};
			for (const m of content.matchAll(/\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g)) {
				const link = (m[1] as string).trim().replace(/\.md$/, '');
				const target = this.text.has(`${link}.md`) ? `${link}.md` : byName.get(baseName(link).toLowerCase())?.[0];
				if (target) resolved[target] = (resolved[target] ?? 0) + 1;
				else unresolved[link] = (unresolved[link] ?? 0) + 1;
			}
			this.resolvedLinks[p] = resolved;
			this.unresolvedLinks[p] = unresolved;
		}
	}

	listMarkdownFiles(): VaultFileInfo[] {
		return [...this.text].map(([path, content]) => ({ path, name: baseName(path), size: content.length, mtime: 0 }));
	}

	listFolder(folderPath: string): VaultFolderInfo | null {
		if (folderPath !== '' && !this.folders.has(folderPath)) return null;
		const children = new Set<string>();
		const prefix = folderPath === '' ? '' : `${folderPath}/`;
		for (const p of [...this.text.keys(), ...this.folders]) {
			if (!p.startsWith(prefix) || p === folderPath) continue;
			const first = p.slice(prefix.length).split('/')[0];
			if (first) children.add(prefix + first);
		}
		return { path: folderPath, children: [...children] };
	}

	exists(path: string): boolean {
		return this.text.has(path) || this.folders.has(path);
	}

	isFolder(path: string): boolean {
		return this.folders.has(path);
	}

	readNote(path: string): Promise<string | null> {
		return Promise.resolve(this.text.get(path) ?? null);
	}

	getMetadata(path: string): NoteMetadata | null {
		const content = this.text.get(path);
		if (content === undefined) return null;
		const fm = /^---\n([\s\S]*?)\n---\n/.exec(content);
		const frontmatter: Record<string, unknown> | null = fm ? {} : null;
		for (const line of fm?.[1]?.split('\n') ?? []) {
			const i = line.indexOf(':');
			if (i > 0 && frontmatter) frontmatter[line.slice(0, i).trim()] = line.slice(i + 1).trim();
		}
		const tags = [...new Set([...content.matchAll(/(?:^|\s)(#[\w/-]+)/g)].map((m) => m[1] as string))];
		const headings = [...content.matchAll(/^(#{1,6})\s+(.+)$/gm)].map((m) => ({ level: (m[1] as string).length, text: m[2] as string }));
		const backlinks: string[] = [];
		for (const [source, targets] of Object.entries(this.resolvedLinks)) if (targets[path]) backlinks.push(source);
		return {
			path,
			frontmatter,
			tags,
			headings,
			outgoingLinks: Object.keys(this.resolvedLinks[path] ?? {}),
			unresolvedLinks: Object.keys(this.unresolvedLinks[path] ?? {}),
			backlinks: backlinks.sort(),
		};
	}

	createNote(): Promise<void> {
		return Promise.reject(new Error('read-only lab vault'));
	}
	processNote(): Promise<void> {
		return Promise.reject(new Error('read-only lab vault'));
	}
	writePluginFile(): Promise<void> {
		return Promise.reject(new Error('read-only lab vault'));
	}
	readPluginFile(): Promise<string | null> {
		return Promise.resolve(null);
	}
	listPluginFiles(): Promise<string[]> {
		return Promise.resolve([]);
	}
	deletePluginFile(): Promise<void> {
		return Promise.reject(new Error('read-only lab vault'));
	}
	getActiveContext(): ActiveContext {
		return { path: null, selection: null };
	}
	onChange(listener: (change: VaultChange) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** Rename a folder in memory (never on disk); reports one rename, for the folder. Returns how many notes moved. */
	renameInMemory(oldPath: string, newPath: string): number {
		const prefix = `${oldPath}/`;
		let moved = 0;
		for (const [p, content] of [...this.text]) {
			if (!p.startsWith(prefix)) continue;
			this.text.delete(p);
			this.text.set(newPath + p.slice(oldPath.length), content);
			moved++;
		}
		for (const f of [...this.folders]) {
			if (f !== oldPath && !f.startsWith(prefix)) continue;
			this.folders.delete(f);
			this.folders.add(newPath + f.slice(oldPath.length));
		}
		this.listeners.forEach((l) => l({ type: 'rename', path: newPath, oldPath }));
		return moved;
	}
}
