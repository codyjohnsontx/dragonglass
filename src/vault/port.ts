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

/** A file or folder that was created, changed, deleted or renamed, as the vault reports it. */
export type VaultChange =
	| { type: 'create' | 'modify' | 'delete'; path: string }
	| { type: 'rename'; path: string; oldPath: string };

export interface ActiveContext {
	path: string | null;
	selection: string | null;
}

/** Where an insert into the open note goes, taken from its editor at the moment of the click. */
export interface InsertTarget {
	path: string;
	/** The note's text as the editor holds it. */
	content: string;
	/** Selection bounds as offsets into `content`; both at the cursor when nothing is selected. */
	from: number;
	to: number;
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
	/** Move a note to the trash, following the user's "Deleted files" setting; never `Vault.delete` directly. Throws if there is no such note. */
	trashNote(path: string): Promise<void>;
	/** Write a file under the plugin's private data dir (snapshots). */
	writePluginFile(relativePath: string, content: string): Promise<void>;
	readPluginFile(relativePath: string): Promise<string | null>;
	listPluginFiles(relativeDir: string): Promise<string[]>;
	deletePluginFile(relativePath: string): Promise<void>;
	getActiveContext(): ActiveContext;
	/** The open note's editor state for an insert, after saving its pending edits; null with no note open. */
	getInsertTarget(): Promise<InsertTarget | null>;
	/** Hear about vault changes from now on; returns a function that stops listening. */
	onChange(listener: (change: VaultChange) => void): () => void;
}
