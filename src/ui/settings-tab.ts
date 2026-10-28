import { App, Notice, PluginSettingTab, SettingDefinitionItem } from 'obsidian';
import type DragonglassPlugin from '../main';
import { ProviderId } from '../providers/types';
import { DragonglassSettings, MIN_NUM_CTX } from '../settings';

/**
 * Declarative settings tab (Obsidian 1.13+). Keys are dotted paths into the
 * settings object so nested provider settings work with the generic
 * getControlValue / setControlValue hooks.
 */
export class DragonglassSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private readonly plugin: DragonglassPlugin,
	) {
		super(app, plugin);
	}

	getControlValue(key: string): unknown {
		return getPath(this.plugin.settings, key);
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		setPath(this.plugin.settings, key, value);
		await this.plugin.saveSettings();
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			{
				name: 'Provider',
				desc: 'Which AI provider the chat uses. You can also switch from the chat sidebar.',
				control: {
					type: 'dropdown',
					key: 'activeProvider',
					options: {
						ollama: 'Ollama (local)',
						openai: 'OpenAI (cloud, billed to your account)',
						anthropic: 'Anthropic (cloud, billed to your account)',
						gemini: 'Google Gemini (cloud, billed to your account)',
					},
				},
			},
			{
				type: 'group',
				heading: 'Ollama',
				items: [
					{
						name: 'Server URL',
						desc: 'Where your Ollama server listens. Nothing leaves this machine unless you point this at a remote host.',
						control: {
							type: 'text',
							key: 'ollama.baseUrl',
							placeholder: 'http://127.0.0.1:11434',
							validate: (v) => (/^https?:\/\/\S+$/.test(v.trim()) ? undefined : 'Enter a URL starting with http:// or https://'),
						},
					},
					{
						name: 'Model',
						desc: 'A model you have pulled, for example llama3.1 or qwen2.5. Tool calling needs a tool-capable model.',
						control: { type: 'text', key: 'ollama.model', placeholder: 'llama3.1' },
					},
					{
						name: 'Context window',
						desc: 'Tokens of prompt plus reply per request (Ollama option num_ctx). Ollama\'s own default of 4096 cannot hold one long note and silently cuts the prompt. Larger windows use more memory. Capped at what the model supports.',
						control: { type: 'number', key: 'ollama.numCtx', min: MIN_NUM_CTX, max: 1_048_576, step: 1024 },
					},
					{
						name: 'Let thinking models think',
						desc: 'Models such as qwen3 reason before answering, which can take a minute per turn; the reasoning is shown collapsed in the chat. Turn off for faster, direct answers.',
						control: { type: 'toggle', key: 'ollama.think' },
					},
					{
						name: 'Test Ollama connection',
						desc: 'Checks that the server answers at the URL above.',
						action: () => void this.test('ollama'),
					},
				],
			},
			{
				type: 'group',
				heading: 'OpenAI',
				items: [
					{
						name: 'API key',
						desc: 'Stored in Obsidian\'s keychain (Settings → General → Keychain), never in plugin files or notes.',
						control: { type: 'secret', key: 'openai.apiKeySecretId' },
					},
					{
						name: 'Model',
						desc: 'For example gpt-4o-mini or gpt-4.1.',
						control: { type: 'text', key: 'openai.model', placeholder: 'gpt-4o-mini' },
					},
					{
						name: 'Test OpenAI connection',
						desc: 'Lists models with your key. Makes one small request to OpenAI.',
						action: () => void this.test('openai'),
					},
				],
			},
			{
				type: 'group',
				heading: 'Anthropic',
				items: [
					{
						name: 'API key',
						desc: 'Stored in Obsidian\'s keychain (Settings → General → Keychain), never in plugin files or notes. Sent only to Anthropic.',
						control: { type: 'secret', key: 'anthropic.apiKeySecretId' },
					},
					{
						name: 'Model',
						desc: 'For example claude-sonnet-4-5 or claude-haiku-4-5. The chat sidebar lists the models your key can use.',
						control: { type: 'text', key: 'anthropic.model', placeholder: 'claude-sonnet-4-5' },
					},
					{
						name: 'Max output tokens',
						desc: 'Anthropic requires a cap on each reply. Raise it if long answers or note drafts get cut off; it must not exceed what the model allows.',
						control: { type: 'number', key: 'anthropic.maxTokens', min: 256, max: 128000, step: 256 },
					},
					{
						name: 'Test Anthropic connection',
						desc: 'Lists models with your key. Makes one small request to Anthropic.',
						action: () => void this.test('anthropic'),
					},
				],
			},
			{
				type: 'group',
				heading: 'Google Gemini',
				items: [
					{
						name: 'API key',
						desc: 'A Gemini API key from Google AI Studio. Stored in Obsidian\'s keychain (Settings → General → Keychain), never in plugin files or notes. Sent only to Google.',
						control: { type: 'secret', key: 'gemini.apiKeySecretId' },
					},
					{
						name: 'Model',
						desc: 'For example gemini-2.5-flash or gemini-2.5-pro. The chat sidebar lists the models your key can use.',
						control: { type: 'text', key: 'gemini.model', placeholder: 'gemini-2.5-flash' },
					},
					{
						name: 'Test Gemini connection',
						desc: 'Lists models with your key. Makes one small request to Google.',
						action: () => void this.test('gemini'),
					},
				],
			},
			{
				type: 'group',
				heading: 'Context',
				items: [
					{
						name: 'Include the active note by default',
						desc: 'You can toggle this per message in the sidebar.',
						control: { type: 'toggle', key: 'includeActiveNote' },
					},
					{
						name: 'Include selected text by default',
						control: { type: 'toggle', key: 'includeSelection' },
					},
					{
						name: 'Max characters per note',
						desc: 'Longer notes are truncated before being sent. For Ollama the cap is also lowered to half the context window when that is smaller.',
						control: { type: 'number', key: 'maxCharsPerNote', min: 1000, max: 500000, step: 1000 },
					},
				],
			},
			{
				type: 'group',
				heading: 'Tools',
				items: [
					{
						name: 'Let the model use vault tools',
						desc: 'Read-only tools (list, search, read, metadata) run automatically. Edits are always proposed for your approval first.',
						control: { type: 'toggle', key: 'toolsEnabled' },
					},
					{
						name: 'Max tool rounds per message',
						control: { type: 'number', key: 'maxToolIterations', min: 1, max: 50, step: 1 },
					},
				],
			},
			{
				type: 'group',
				heading: 'Usage',
				items: [
					{
						name: 'Show token usage',
						desc: 'Token counts come from the provider. Costs are billed by the provider; this plugin only reports counts.',
						control: { type: 'toggle', key: 'showUsage' },
					},
					{
						name: 'Usage warning threshold',
						desc: 'Warn when a conversation exceeds this many tokens. Set to zero to disable. This is a reminder in the sidebar, not a spending limit.',
						control: { type: 'number', key: 'usageWarningTokens', min: 0, step: 1000 },
					},
				],
			},
			{
				type: 'group',
				heading: 'Advanced',
				items: [
					{
						name: 'Network transport',
						desc: 'Streaming uses the fetch API. If your Ollama server rejects requests from Obsidian (CORS), switch to Obsidian\'s request API; replies then arrive all at once.',
						control: {
							type: 'dropdown',
							key: 'transport',
							options: { fetch: 'Streaming (fetch)', requestUrl: 'Obsidian request API (no streaming)' },
						},
					},
				],
			},
			{
				type: 'group',
				heading: 'Privacy',
				items: [
					{
						name: 'What is sent',
						desc: 'Only your message, the context you attach (highlighted in the sidebar), and the results of tools the model calls are sent, and only to the provider you configured. The plugin never uploads the whole vault, collects telemetry, or contacts any other server. Conversations are stored in this vault\'s plugin folder.',
					},
				],
			},
		];
	}

	private async test(id: ProviderId): Promise<void> {
		const status = await this.plugin.core.checkConnection(id);
		new Notice(status.ok ? `Connected: ${status.detail}` : status.error.userMessage(), 8000);
	}
}

function getPath(obj: DragonglassSettings, key: string): unknown {
	let cur: unknown = obj;
	for (const part of key.split('.')) {
		if (!cur || typeof cur !== 'object') return undefined;
		cur = (cur as Record<string, unknown>)[part];
	}
	return cur;
}

function setPath(obj: DragonglassSettings, key: string, value: unknown): void {
	const parts = key.split('.');
	const last = parts.pop();
	if (!last) return;
	let cur: Record<string, unknown> = obj as unknown as Record<string, unknown>;
	for (const part of parts) {
		const next = cur[part];
		if (!next || typeof next !== 'object') return;
		cur = next as Record<string, unknown>;
	}
	cur[last] = value;
}
