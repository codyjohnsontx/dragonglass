#!/usr/bin/env node
/**
 * Ask the local model what query it would type into search_notes for each
 * benchmark question, so the bench can also score "model-chosen" queries
 * rather than only the full question. Adds `modelQuery` to questions.json.
 *
 *   node scripts/retrieval-lab/gen-queries.mjs <outdir> [model] [ollamaBaseUrl]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const outdir = process.argv[2];
const model = process.argv[3] ?? 'qwen3:8b';
const base = process.argv[4] ?? 'http://127.0.0.1:11434';
const file = join(outdir, 'questions.json');
const questions = JSON.parse(readFileSync(file, 'utf8'));

const SYSTEM =
	'You pick the query for a note search tool inside an Obsidian vault. The tool matches notes containing ANY of the query words and ranks notes containing more of the words higher. ' +
	'Reply with the query only: 2 to 6 plain words, no quotes, no punctuation, no explanation.';

let done = 0;
const t0 = performance.now();
for (const q of questions) {
	if (q.modelQuery) {
		done++;
		continue;
	}
	const res = await fetch(`${base}/api/chat`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			model,
			stream: false,
			think: false,
			options: { num_ctx: 4096, temperature: 0 },
			messages: [
				{ role: 'system', content: SYSTEM },
				{ role: 'user', content: `Question: ${q.question}\nQuery:` },
			],
		}),
	});
	if (!res.ok) throw new Error(`Ollama returned ${res.status} for ${q.id}: ${(await res.text()).slice(0, 200)}`);
	const data = await res.json();
	const modelQuery = String(data.message?.content ?? '').replace(/<think>[\s\S]*?<\/think>/g, '').trim().split('\n')[0].replace(/^query:\s*/i, '').trim();
	if (!modelQuery) throw new Error(`empty model query for ${q.id}`);
	q.modelQuery = modelQuery;
	done++;
	if (done % 20 === 0) {
		writeFileSync(file, JSON.stringify(questions, null, 1));
		console.log(`${done}/${questions.length} (${((performance.now() - t0) / 1000).toFixed(0)} s)`);
	}
}
writeFileSync(file, JSON.stringify(questions, null, 1));
console.log(`done ${done} queries in ${((performance.now() - t0) / 1000).toFixed(0)} s`);
for (const q of questions.slice(0, 8)) console.log(`  ${q.kind}: "${q.question}" -> "${q.modelQuery}"`);
