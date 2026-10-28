/**
 * Narrow interface over the Obsidian vault used by tools and the proposal
 * engine. `ObsidianVaultPort` wraps `App`; tests use `MemoryVaultPort`.
 * Keeping this small is what makes the vault logic unit-testable.
 */

export interface VaultFileInfo {
	path: string;
	/** Basename without extension. */
	name: string;
	size: number;
	mtime: number;
}

export interface VaultFolderInfo {
	path: string;
	children: string[];
}

export interface NoteMetadata {
	path: string;
	frontmatter: Record<string, unknown> | null;
	tags: string[];
	headings: Array<{ level: number; text: string }>;
	/** Resolved outgoing wikilinks (vault paths). */
	outgoingLinks: string[];
	/** Links to notes that do not exist. */
	unresolvedLinks: string[];
	/** Vault paths of notes that link here. */
	backlinks: string[];
}

export interface ActiveContext {
	path: string | null;
	selection: string | null;
}

export interface VaultPort {
	/** Name of the vault's configuration folder (usually `.obsidian`). */
	readonly configDir: string;
	listMarkdownFiles(): VaultFileInfo[];
	listFolder(folderPath: string): VaultFolderInfo | null;
	exists(path: string): boolean;
	isFolder(path: string): boolean;
	readNote(path: string): Promise<string | null>;
	getMetadata(path: string): NoteMetadata | null;
	/** Create a note; throws if the file already exists. Creates parent folders. */
	createNote(path: string, content: string): Promise<void>;
	/**
	 * Atomically transform a note. `fn` receives the current content and
	 * returns the new content; throwing inside `fn` aborts without writing.
	 */
	processNote(path: string, fn: (current: string) => string): Promise<void>;
	/** Write a file under the plugin's private data dir (snapshots). */
	writePluginFile(relativePath: string, content: string): Promise<void>;
	readPluginFile(relativePath: string): Promise<string | null>;
	listPluginFiles(relativeDir: string): Promise<string[]>;
	deletePluginFile(relativePath: string): Promise<void>;
	getActiveContext(): ActiveContext;
}
