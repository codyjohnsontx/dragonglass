import { describe, expect, it } from 'vitest';
import { InvalidPathError, validateVaultPath } from '../src/vault/paths';

const opts = { configDir: '.obsidian' };

describe('validateVaultPath', () => {
	it('normalizes separators and leading ./', () => {
		expect(validateVaultPath('./Notes\\Sub//A.md', opts)).toBe('Notes/Sub/A.md');
		expect(validateVaultPath('/Notes/A.md', opts)).toBe('Notes/A.md');
	});

	it.each([
		['../secrets.md', 'traversal', true],
		['Notes/../../x.md', 'traversal', true],
		['/etc/passwd', 'must end with .md', true],
		['C:/Users/x.md', 'absolute', true],
		['file:///tmp/x.md', 'URLs', true],
		['https://evil.example/x.md', 'URLs', true],
		['.obsidian/plugins/x.md', 'configuration folder', true],
		['.obsidian', 'configuration folder', false],
		['notes/bad\u0000name.md', 'control', true],
		['', 'empty', false],
		['notes/.', 'traversal', false],
	])('rejects %s', (input, reason, markdown) => {
		expect(() => validateVaultPath(input, { ...opts, markdown })).toThrowError(new RegExp(reason));
	});

	it('respects a custom config dir', () => {
		expect(() => validateVaultPath('cfg/app.json', { configDir: 'cfg', markdown: false })).toThrow(InvalidPathError);
		expect(validateVaultPath('.obsidian/x.md', { configDir: 'cfg' })).toBe('.obsidian/x.md');
	});

	it('allows the root for folders when asked', () => {
		expect(validateVaultPath('', { ...opts, markdown: false, allowRoot: true })).toBe('');
		expect(validateVaultPath('Folder/', { ...opts, markdown: false })).toBe('Folder');
	});

	it('rejects non-strings', () => {
		expect(() => validateVaultPath(42, opts)).toThrow(InvalidPathError);
	});
});
