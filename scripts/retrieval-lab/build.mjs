// Bundle the lab's TypeScript entry points for Node, with `obsidian` aliased to the test stub.
import esbuild from 'esbuild';
import { fileURLToPath } from 'node:url';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
await esbuild.build({
	entryPoints: [here('./bench-search.ts'), here('./agent-run.ts')],
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: 'node22',
	outdir: here('./dist'),
	outExtension: { '.js': '.mjs' },
	alias: { obsidian: here('../../test/obsidian-stub.ts') },
	logLevel: 'warning',
});
