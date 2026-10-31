/**
 * Path validation at the trust boundary between the model and the vault.
 * Every path the model supplies passes through `validateVaultPath` before it
 * touches the vault. Paths are vault-relative, forward-slash separated.
 */

export class InvalidPathError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'InvalidPathError';
	}
}

export function normalizeVaultPath(input: string): string {
	let p = input.trim().replace(/\\/g, '/');
	p = p.replace(/\/{2,}/g, '/');
	if (p.startsWith('./')) p = p.slice(2);
	if (p.startsWith('/')) p = p.slice(1);
	if (p.endsWith('/')) p = p.slice(0, -1);
	return p;
}

export interface PathOptions {
	/** Require a `.md` extension (notes). Default true. */
	markdown?: boolean;
	/** Allow the empty string meaning the vault root (folders only). Default false. */
	allowRoot?: boolean;
	/** The vault's config folder name (Vault#configDir). Writes and reads there are refused. */
	configDir: string;
}

/**
 * Returns the normalized path or throws InvalidPathError. Rejects absolute
 * paths, drive letters, `..` traversal, hidden config dirs, and control chars.
 */
export function validateVaultPath(input: unknown, opts: PathOptions): string {
	if (typeof input !== 'string') throw new InvalidPathError('path must be a string');
	if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(input.trim())) throw new InvalidPathError('URLs are not allowed as paths');
	const p = normalizeVaultPath(input);
	if (p === '') {
		if (opts.allowRoot) return '';
		throw new InvalidPathError('path must not be empty');
	}
	if (/^[a-zA-Z]:/.test(p)) throw new InvalidPathError('absolute paths are not allowed');
	// eslint-disable-next-line no-control-regex -- intentionally matching control characters
	if (/[\u0000-\u001f\u007f]/.test(p)) throw new InvalidPathError('path contains control characters');
	const segments = p.split('/');
	for (const seg of segments) {
		if (seg === '' ) throw new InvalidPathError('path contains an empty segment');
		if (seg === '.' || seg === '..') throw new InvalidPathError('path traversal is not allowed');
	}
	const configDir = normalizeVaultPath(opts.configDir);
	if (configDir && (p === configDir || p.startsWith(`${configDir}/`))) {
		throw new InvalidPathError(`the ${configDir} configuration folder is off limits`);
	}
	if (opts.markdown !== false && !p.toLowerCase().endsWith('.md')) {
		throw new InvalidPathError('note paths must end with .md');
	}
	return p;
}

export function parentFolder(path: string): string {
	const idx = path.lastIndexOf('/');
	return idx < 0 ? '' : path.slice(0, idx);
}

export function baseName(path: string): string {
	const idx = path.lastIndexOf('/');
	const name = idx < 0 ? path : path.slice(idx + 1);
	return name.replace(/\.md$/i, '');
}

/** Whether `path` lies inside one of `folders` (vault-relative, no trailing slash), at any depth. */
export function isUnderAny(path: string, folders: ReadonlySet<string>): boolean {
	for (let i = path.lastIndexOf('/'); i > 0; i = path.lastIndexOf('/', i - 1)) {
		if (folders.has(path.slice(0, i))) return true;
	}
	return false;
}
