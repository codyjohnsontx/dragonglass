/**
 * Live questions against a generated vault through the plugin's own agent
 * loop, system prompt, vault tools and Ollama adapter, one fresh
 * conversation per question, strictly one request at a time.
 *
 *   node scripts/retrieval-lab/dist/agent-run.mjs <outdir> --ids q1,q5,q3,q17,q35,q8
 *        [--model qwen3:8b] [--ollama http://127.0.0.1:11434] [--auto-read-tokens 4000] [--rounds 8] [--out file.json]
 *
 * `--auto-read-tokens 0` runs search with excerpts only. Correct means the
 * final answer contains the planted answer (case, commas and $ ignored);
 * read the printed answers to confirm. Talks only to the given Ollama URL.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { autoReadBudget, buildSystemPrompt, noteTokenBudget, vaultMap } from '../../src/agent/context';
import { runAgent } from '../../src/agent/runtime';
import { ToolRegistry } from '../../src/agent/tools';
import { FetchHttpClient } from '../../src/providers/http';
import { OllamaProvider } from '../../src/providers/ollama';
import { VaultSearchIndex } from '../../src/search/vault-index';
import { createVaultTools } from '../../src/tools/vault-tools';
import { ProposalEngine } from '../../src/vault/proposals';
import { DirVaultPort } from './dir-vault';

interface Question {
	id: string;
	kind: string;
	question: string;
	answers: string[];
	answer?: string;
}

const args = process.argv.slice(2);
const outdir = args[0];
if (!outdir) throw new Error('usage: agent-run.mjs <outdir> --ids q1,q2 [options]');
const opt = (name: string, fallback: string): string => {
	const i = args.indexOf(`--${name}`);
	return i >= 0 ? (args[i + 1] ?? fallback) : fallback;
};
const model = opt('model', 'qwen3:8b');
const baseUrl = opt('ollama', 'http://127.0.0.1:11434');
const autoReadSetting = Number(opt('auto-read-tokens', '4000'));
const rounds = Number(opt('rounds', '8'));
const ids = opt('ids', '').split(',').filter(Boolean);
const maxChars = 20_000;

const all = JSON.parse(readFileSync(join(outdir, 'questions.json'), 'utf8')) as Question[];
const questions = ids.length ? ids.map((id) => all.find((q) => q.id === id)!).filter(Boolean) : all;
const vault = new DirVaultPort(join(outdir, 'vault'));
const index = new VaultSearchIndex(vault, () => new Promise((resolve) => setTimeout(resolve, 0)));
await index.start();

const provider = new OllamaProvider(new FetchHttpClient(), () => ({ baseUrl, model, numCtx: 16_384, think: true }));
const window = await provider.contextWindow(model);
const options = { maxReadChars: maxChars, maxReadTokens: noteTokenBudget(window), maxSearchResults: 20, autoReadTokens: autoReadBudget(autoReadSetting, window) };
console.log(`${model}, context ${window}, read budget ${options.maxReadTokens}, auto-read ${options.autoReadTokens} tokens, ${questions.length} questions`);

const normalize = (s: string): string => s.toLowerCase().replace(/[\s,$]+/g, ' ').replace(/[^\w ]/g, '').trim();
const records = [];
for (const q of questions) {
	const tools = new ToolRegistry();
	for (const tool of createVaultTools(vault, new ProposalEngine(vault), options, index)) tools.register(tool);
	const calls: string[] = [];
	let final = '';
	let toolRounds = 0;
	let answerTextSeen = false;
	let error: string | undefined;
	const started = performance.now();
	for await (const ev of runAgent({
		provider,
		model,
		system: (toolsEnabled) => buildSystemPrompt({ toolsEnabled, maxCharsPerNote: maxChars, vault: vaultMap(vault, null) }),
		messages: [{ role: 'user', content: q.question }],
		tools,
		toolsEnabled: true,
		conversationId: q.id,
		signal: new AbortController().signal,
		maxIterations: rounds,
	})) {
		if (ev.type === 'assistant_end') {
			if (ev.content) final = ev.content;
			if (ev.toolCalls.length) toolRounds++;
		} else if (ev.type === 'tool_result') {
			calls.push(`${ev.call.name}${ev.result.isError ? '!' : ''}`);
			if (q.answers.some((a) => ev.result.content.includes(`<<<note path="${a}">>>`))) answerTextSeen = true;
		} else if (ev.type === 'error') {
			error = ev.error.message;
		}
	}
	const seconds = Math.round((performance.now() - started) / 1000);
	const correct = q.answer ? normalize(final).includes(normalize(q.answer)) : null;
	records.push({ id: q.id, kind: q.kind, question: q.question, expected: q.answer, correct, toolRounds, calls, answerTextSeen, seconds, final, error });
	console.log(`${q.id} ${q.kind}: ${correct ? 'correct' : 'WRONG'}, ${toolRounds} tool rounds (${calls.join(', ')}), ${seconds} s, answer note read: ${answerTextSeen ? 'yes' : 'no'}${error ? `, error ${error}` : ''}`);
	console.log(`   expected ${q.answer}; answered: ${final.replace(/\s+/g, ' ').slice(0, 240)}`);
}
const correct = records.filter((r) => r.correct).length;
const meanRounds = records.reduce((a, r) => a + r.toolRounds, 0) / records.length;
const meanSeconds = records.reduce((a, r) => a + r.seconds, 0) / records.length;
console.log(`\n${correct}/${records.length} correct, mean ${meanRounds.toFixed(1)} tool rounds, mean ${meanSeconds.toFixed(0)} s, answer note read in ${records.filter((r) => r.answerTextSeen).length}/${records.length}`);
const out = opt('out', '');
if (out) writeFileSync(out, JSON.stringify(records, null, 1));
