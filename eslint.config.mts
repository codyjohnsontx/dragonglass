import obsidianmd from 'eslint-plugin-obsidianmd';
import globals from 'globals';
import { globalIgnores, defineConfig } from 'eslint/config';

export default defineConfig(
	globalIgnores([
		'node_modules',
		'dist',
		'esbuild.config.mjs',
		'version-bump.mjs',
		'versions.json',
		'main.js',
		'package.json',
		'package-lock.json',
		'tsconfig.json',
		'test/**',
		'scripts/**',
		'vitest.config.ts',
	]),
	{
		languageOptions: {
			globals: {
				...globals.browser,
			},
			parserOptions: {
				projectService: {
					allowDefaultProject: ['eslint.config.mts', 'manifest.json'],
				},
				tsconfigRootDir: import.meta.dirname,
				extraFileExtensions: ['.json'],
			},
		},
	},
	...obsidianmd.configs.recommended,
	{
		// The streaming transport needs fetch: requestUrl cannot stream and is the configurable fallback.
		files: ['src/providers/http.ts'],
		rules: { 'no-restricted-globals': 'off' },
	},
	{
		rules: {
			'obsidianmd/ui/sentence-case': [
				'warn',
				{
					brands: ['Dragonglass', 'Ollama', 'OpenAI', 'Obsidian', 'GPT', 'CORS', 'API', 'URL', 'Keychain'],
					ignoreRegex: ['^https?://'],
				},
			],
		},
	},
);
