import { App, Plugin } from 'obsidian';
import { buildSystemPrompt, ContextItem, formatContextBlock, toProviderMessages } from './agent/context';
import { RunEvent, runAgent } from './agent/runtime';
import { ToolRegistry } from './agent/tools';
import { Conversation, deriveTitle, StoredMessage } from './persistence/conversation';
import { ConversationStore } from './persistence/store';
import { FetchHttpClient, HttpClient } from './providers/http';
import { createRequestUrlClient } from './providers/obsidian-http';
import { createProviders, modelFor, setModelFor } from './providers/registry';
import { ConnectionStatus, ModelInfo, Provider, ProviderError, ProviderId, Usage } from './providers/types';
import { DragonglassSettings } from './settings';
import { createVaultTools } from './tools/vault-tools';
import { ObsidianVaultPort } from './vault/obsidian-port';
import { ChangeProposal, ProposalEngine } from './vault/proposals';

/**
 * Wires providers, tools, persistence and the agent loop together. The chat
 * view talks to this class; nothing here touches the DOM.
 */

export interface SendOptions {
	text: string;
	context: ContextItem[];
	signal: AbortSignal;
	onEvent: (ev: RunEvent) => void;
}

export class DragonglassCore {
	readonly vault: ObsidianVaultPort;
	readonly store: ConversationStore;
	readonly proposals: ProposalEngine;
	readonly tools: ToolRegistry;
	private readonly providers;
	private readonly fetchClient = new FetchHttpClient();
	private readonly requestUrlClient: HttpClient;
	private settings: DragonglassSettings;
	private readonly saveSettings: () => Promise<void>;

	constructor(app: App, plugin: Plugin, settings: DragonglassSettings, saveSettings: () => Promise<void>) {
		this.settings = settings;
		this.saveSettings = saveSettings;
		this.vault = new ObsidianVaultPort(app, plugin);
		this.store = new ConversationStore(this.vault);
		this.proposals = new ProposalEngine(this.vault);
		this.tools = new ToolRegistry();
		for (const t of createVaultTools(this.vault, this.proposals, {
			maxReadChars: settings.maxCharsPerNote,
			maxSearchResults: 20,
		})) {
			this.tools.register(t);
		}
		this.requestUrlClient = createRequestUrlClient();
		this.providers = createProviders(
			() => (this.settings.transport === 'requestUrl' ? this.requestUrlClient : this.fetchClient),
			() => this.settings,
			{ getSecret: (id) => app.secretStorage.getSecret(id) },
		);
	}

	updateSettings(settings: DragonglassSettings): void {
		this.settings = settings;
	}

	getSettings(): DragonglassSettings {
		return this.settings;
	}

	provider(id: ProviderId = this.settings.activeProvider): Provider {
		return this.providers[id];
	}

	activeModel(): string {
		return modelFor(this.settings, this.settings.activeProvider);
	}

	async setActiveProvider(id: ProviderId): Promise<void> {
		this.settings.activeProvider = id;
		await this.saveSettings();
	}

	async setActiveModel(model: string): Promise<void> {
		setModelFor(this.settings, this.settings.activeProvider, model);
		await this.saveSettings();
	}

	checkConnection(id: ProviderId = this.settings.activeProvider, signal?: AbortSignal): Promise<ConnectionStatus> {
		return this.provider(id).checkConnection(signal);
	}

	listModels(id: ProviderId = this.settings.activeProvider, signal?: AbortSignal): Promise<ModelInfo[]> {
		return this.provider(id).listModels(signal);
	}

	/** True when the active provider sends data off the machine. */
	activeProviderIsRemote(): boolean {
		return this.provider().capabilities.remote;
	}

	/**
	 * Send a user message in `conv`, stream the reply, and persist every
	 * message as it is produced. Resolves when the turn is over.
	 */
	async send(conv: Conversation, opts: SendOptions): Promise<void> {
		const provider = this.provider();
		const model = this.activeModel();
		if (!model) {
			opts.onEvent({ type: 'error', error: new ProviderError('invalid_request', 'No model selected. Pick one in settings or the model menu.') });
			return;
		}
		const userMsg: StoredMessage = {
			id: newId(),
			role: 'user',
			content: opts.text,
			createdAt: Date.now(),
			context: {
				activeNotePath: opts.context.find((c) => c.kind === 'active')?.path ?? null,
				selection: opts.context.find((c) => c.kind === 'selection')?.content ?? null,
				attachments: opts.context.filter((c) => c.kind === 'attachment' && c.path).map((c) => ({ path: c.path as string })),
			},
		};
		if (conv.messages.length === 0) conv.title = deriveTitle(opts.text);
		conv.messages.push(userMsg);
		this.store.touch(conv);

		const system = buildSystemPrompt({ toolsEnabled: this.settings.toolsEnabled, maxCharsPerNote: this.settings.maxCharsPerNote });
		const contextBlock = formatContextBlock(opts.context, this.settings.maxCharsPerNote);
		const messages = toProviderMessages(system, conv.messages, contextBlock);

		let current: StoredMessage | null = null;
		const events = runAgent({
			provider,
			model,
			messages,
			tools: this.tools,
			toolsEnabled: this.settings.toolsEnabled,
			conversationId: conv.id,
			signal: opts.signal,
			maxIterations: this.settings.maxToolIterations,
		});
		for await (const ev of events) {
			switch (ev.type) {
				case 'assistant_start':
					current = { id: newId(), role: 'assistant', content: '', createdAt: Date.now(), provider: provider.id, model };
					conv.messages.push(current);
					break;
				case 'text_delta':
					if (current) current.content += ev.delta;
					break;
				case 'assistant_end':
					if (current) {
						current.content = ev.content;
						current.toolCalls = ev.toolCalls.length ? ev.toolCalls : undefined;
						current.usage = ev.usage;
					}
					this.store.touch(conv);
					break;
				case 'tools_disabled':
					if (current) conv.messages.splice(conv.messages.indexOf(current), 1);
					current = null;
					break;
				case 'tool_result': {
					const toolMsg: StoredMessage = {
						id: newId(),
						role: 'tool',
						content: ev.result.content,
						createdAt: Date.now(),
						toolCallId: ev.call.id,
						toolName: ev.call.name,
						isError: ev.result.isError,
					};
					if (ev.result.proposal) {
						conv.proposals[ev.result.proposal.id] = ev.result.proposal;
						toolMsg.proposalId = ev.result.proposal.id;
					}
					conv.messages.push(toolMsg);
					this.store.touch(conv);
					break;
				}
				case 'error':
					if (current) {
						if (ev.error.kind === 'cancelled') current.interrupted = true;
						else current.error = ev.error.userMessage();
					} else {
						conv.messages.push({
							id: newId(),
							role: 'assistant',
							content: '',
							createdAt: Date.now(),
							provider: provider.id,
							model,
							error: ev.error.userMessage(),
						});
					}
					this.store.touch(conv);
					break;
				default:
					break;
			}
			opts.onEvent(ev);
		}
		this.store.touch(conv);
	}

	/** Total tokens reported by the provider across the conversation. */
	conversationUsage(conv: Conversation): Usage {
		let inputTokens = 0;
		let outputTokens = 0;
		for (const m of conv.messages) {
			inputTokens += m.usage?.inputTokens ?? 0;
			outputTokens += m.usage?.outputTokens ?? 0;
		}
		return { inputTokens, outputTokens };
	}

	async approveProposal(conv: Conversation, p: ChangeProposal): Promise<void> {
		try {
			await this.proposals.apply(p);
		} finally {
			this.store.touch(conv);
		}
	}

	rejectProposal(conv: Conversation, p: ChangeProposal): void {
		this.proposals.reject(p);
		this.store.touch(conv);
	}

	async revertProposal(conv: Conversation, p: ChangeProposal): Promise<void> {
		try {
			await this.proposals.revert(p);
		} finally {
			this.store.touch(conv);
		}
	}
}

function newId(): string {
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
