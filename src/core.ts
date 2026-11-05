import { App, Plugin } from 'obsidian';
import { autoReadBudget, buildSystemPrompt, ContextItem, fitLoreNotes, formatContextBlock, noteTokenBudget, shownChars, toProviderMessages, userMessage, vaultMap } from './agent/context';
import { RunEvent, runAgent } from './agent/runtime';
import { ToolRegistry } from './agent/tools';
import { Conversation, deriveTitle, StoredMessage } from './persistence/conversation';
import { ConversationStore } from './persistence/store';
import { FetchHttpClient, HttpClient } from './providers/http';
import { createRequestUrlClient } from './providers/obsidian-http';
import { loadModelChoices, ModelChoices } from './providers/model-choices';
import { createProviders, modelFor, setModelFor } from './providers/registry';
import { ConnectionStatus, Provider, ProviderError, ProviderId, Usage } from './providers/types';
import { DragonglassSettings } from './settings';
import { VaultSearchIndex } from './search/vault-index';
import { createVaultTools } from './tools/vault-tools';
import { createWebTools, DEFAULT_MAX_PAGE_CHARS, nextWebNumber, WebSearchApprover } from './tools/web-tools';
import { researchNoteFor } from './web/research-note';
import { parsePreferredSites, TavilySearch } from './web/search';
import { draftingForSend, followsDraft, parseDraft, proposeDraftInsert, revisionReminder, threadForDraft } from './agent/drafting';
import { canonContext, canonNotePath, groundLoreCheck, isLoreNote, loreForScript, LoreCheckRecord, LoreIssue, loreCheckRequest, parseLoreBlock, proposeCanonEntry, proposeLoreFix, RawIssue, shownPaths } from './agent/lore-check';
import { ObsidianVaultPort } from './vault/obsidian-port';
import { baseName, normalizeVaultPath } from './vault/paths';
import { ChangeProposal, ProposalEngine, ProposalError } from './vault/proposals';

/**
 * Wires providers, tools, persistence and the agent loop together. The chat
 * view talks to this class; nothing here touches the DOM.
 */

export interface SendOptions {
	text: string;
	context: ContextItem[];
	signal: AbortSignal;
	onEvent: (ev: RunEvent) => void;
	/** Asks the user to approve a web search. Without it, or without a Tavily key, the model has no web tools. */
	approveWebSearch?: WebSearchApprover;
	/** This send is a lore check of the first context item. */
	loreCheck?: { scriptPath: string; resolve: (link: string) => string | null };
}

export interface LoreCheckOptions {
	signal: AbortSignal;
	onEvent: (ev: RunEvent) => void;
	/** Resolves a cited note's name to its path, as Obsidian would. */
	resolve: (link: string) => string | null;
}

export class DragonglassCore {
	readonly vault: ObsidianVaultPort;
	readonly store: ConversationStore;
	readonly proposals: ProposalEngine;
	readonly searchIndex: VaultSearchIndex;
	private readonly providers;
	private readonly fetchClient = new FetchHttpClient();
	private readonly requestUrlClient: HttpClient;
	private readonly webSearch: TavilySearch;
	private readonly getSecret: (id: string) => string | null;
	private settings: DragonglassSettings;
	private readonly saveSettings: () => Promise<void>;

	constructor(app: App, plugin: Plugin, settings: DragonglassSettings, saveSettings: () => Promise<void>) {
		this.settings = settings;
		this.saveSettings = saveSettings;
		this.vault = new ObsidianVaultPort(app, plugin);
		this.store = new ConversationStore(this.vault);
		this.proposals = new ProposalEngine(this.vault);
		this.searchIndex = new VaultSearchIndex(this.vault);
		// After layout ready: Obsidian reports every file as created while it loads the vault.
		app.workspace.onLayoutReady(() => void this.searchIndex.start());
		this.requestUrlClient = createRequestUrlClient();
		this.getSecret = (id) => app.secretStorage.getSecret(id);
		// Search and page reads go through requestUrl whatever the chat transport: no CORS, and the same for every provider.
		this.webSearch = new TavilySearch(this.requestUrlClient, () => ({ baseUrl: this.settings.webSearch.baseUrl, apiKey: () => this.webSearchKey() }));
		this.providers = createProviders(
			() => (this.settings.transport === 'requestUrl' ? this.requestUrlClient : this.fetchClient),
			() => this.settings,
			{ getSecret: (id) => app.secretStorage.getSecret(id) },
		);
	}

	dispose(): void {
		this.searchIndex.dispose();
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

	/** Models to offer for `id`: its own list when it answers, else its built-in suggestions. */
	modelChoices(id: ProviderId = this.settings.activeProvider, signal?: AbortSignal): Promise<ModelChoices> {
		return loadModelChoices(this.provider(id), signal);
	}

	/** The Tavily key from SecretStorage, or null when none is set. */
	private webSearchKey(): string | null {
		const id = this.settings.webSearch.apiKeySecretId;
		const key = id ? this.getSecret(id) : null;
		return key?.trim() ? key : null;
	}

	/** True when the active provider sends data off the machine. */
	activeProviderIsRemote(): boolean {
		return this.provider().capabilities.remote;
	}

	/** The model's context window when the provider reports it; note budgets in agent/context derive from it. */
	private async contextWindow(provider: Provider, model: string, signal?: AbortSignal): Promise<number | undefined> {
		if (!provider.contextWindow) return undefined;
		try {
			return await provider.contextWindow(model, signal);
		} catch {
			return undefined;
		}
	}

	/**
	 * The vault tools for one send. Each send gets its own registry so the
	 * note budgets the read tools apply are the ones computed for that send's
	 * provider and model, even when two sends overlap.
	 */
	private createTools(contextWindow: number | undefined, web: { approve: WebSearchApprover; firstNumber: number } | null, readOnly: boolean): ToolRegistry {
		const tools = new ToolRegistry();
		const maxReadTokens = noteTokenBudget(contextWindow);
		const options = () => ({
			maxReadChars: this.settings.maxCharsPerNote,
			maxReadTokens,
			maxSearchResults: 20,
			autoReadTokens: autoReadBudget(this.settings.autoReadTokens, contextWindow),
			excludeFolder: this.scriptFolder(),
		});
		for (const t of createVaultTools(this.vault, this.proposals, options, this.searchIndex)) if (t.readOnly || !readOnly) tools.register(t);
		if (web) {
			const webTools = createWebTools({
				search: this.webSearch,
				http: this.requestUrlClient,
				approve: web.approve,
				preferredSites: () => parsePreferredSites(this.settings.webSearch.preferredSites),
				maxPageChars: Math.min(DEFAULT_MAX_PAGE_CHARS, this.settings.maxCharsPerNote),
				// Three pages share the room one note read gets.
				maxPageTokens: maxReadTokens === undefined ? undefined : Math.floor(maxReadTokens / 3),
				firstNumber: web.firstNumber,
			});
			for (const t of webTools) tools.register(t);
		}
		return tools;
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
		const lore = opts.loreCheck;
		const contextWindow = await this.contextWindow(provider, model, opts.signal);
		const noteTokens = noteTokenBudget(contextWindow);
		const canon = await canonContext(this.vault, this.canonNote());
		const { items: loreNotes, named } = lore ? await loreForScript(this.vault, opts.context[0]?.content.slice(0, this.settings.maxCharsPerNote) ?? '', { scriptPath: lore.scriptPath, scriptFolder: this.scriptFolder(), canonPath: this.canonNote() }) : { items: [], named: 0 };
		const context = fitLoreNotes([...opts.context, ...loreNotes, ...(canon ? [canon] : [])], this.settings.maxCharsPerNote, noteTokens);
		const userMsg = userMessage(newId(), opts.text, context, Date.now());
		if (conv.messages.length === 0) conv.title = deriveTitle(opts.text);
		conv.messages.push(userMsg);
		this.store.touch(conv);

		const contextBlock = [formatContextBlock(context, this.settings.maxCharsPerNote, noteTokens), lore ? '' : revisionReminder(conv.messages)].filter(Boolean).join('\n\n');
		const messages = toProviderMessages(conv.messages, contextBlock);
		const map = vaultMap(this.vault, userMsg.context?.activeNotePath ?? null, this.scriptFolder());
		const drafting = await draftingForSend(this.vault, opts.context, this.scriptFolder());
		const webReady = this.webSearchKey() !== null && opts.approveWebSearch !== undefined;
		const webSearch = webReady ? 'available' : 'needs-key';
		const pastSources = conv.messages.map((m) => m.sources);
		const webSources = conv.messages.some((m) => m.sources?.some((src) => src.kind === 'web'));

		let current: StoredMessage | null = null;
		const events = runAgent({
			provider,
			model,
			system: (toolsEnabled) => buildSystemPrompt({ toolsEnabled, maxCharsPerNote: this.settings.maxCharsPerNote, vault: map, webSearch, webSources, drafting, loreCheck: lore?.scriptPath, canon: canon ? canon.label : undefined }),
			messages,
			tools: this.createTools(
				contextWindow,
				!lore && webReady && opts.approveWebSearch ? { approve: opts.approveWebSearch, firstNumber: nextWebNumber(pastSources) } : null,
				lore !== undefined || followsDraft(conv.messages, this.vault.getActiveContext().path),
			),
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
				case 'thinking_delta':
					if (current) current.thinking = (current.thinking ?? '') + ev.delta;
					break;
				case 'assistant_end':
					if (current) {
						current.content = ev.content;
						current.thinking = ev.thinking || undefined;
						current.toolCalls = ev.toolCalls.length ? ev.toolCalls : undefined;
						current.usage = ev.usage;
						current.warnings = ev.warnings.length ? ev.warnings : undefined;
						const draft = parseDraft(ev.content);
						if (draft) current.draft = { thread: threadForDraft(conv.messages, draft.fresh, newId), text: draft.text };
						const issues = lore && ev.toolCalls.length === 0 ? parseLoreBlock(ev.content) : null;
						if (lore && issues) current.loreCheck = this.loreResult(conv, userMsg.id, lore, context, canon, named, issues, noteTokens);
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
					if (ev.result.sources?.length) toolMsg.sources = ev.result.sources;
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
		if (lore && !opts.signal.aborted && current && !current.error && !current.loreCheck) {
			(current.warnings ??= []).push('The model did not answer with a list of issues, so there is nothing to fix from here. Run the check again.');
		}
		this.store.touch(conv);
	}

	/** Check a lore check reply against the script and what the turn showed the model. */
	private loreResult(conv: Conversation, userId: string, lore: NonNullable<SendOptions['loreCheck']>, context: ContextItem[], canon: ContextItem | null, named: number, raw: RawIssue[], noteTokens: number | undefined): LoreCheckRecord {
		const [script] = context;
		const shown = shownPaths(conv.messages, userId);
		const sent = shownChars(context, this.settings.maxCharsPerNote, noteTokens);
		const chars = sent[0] ?? 0;
		const total = script?.content.length ?? 0;
		const canonChars = canon ? (sent[context.indexOf(canon)] ?? 0) : 0;
		const loreCut = named - context.filter((item, i) => item.kind === 'lore' && sent[i] === item.content.length).length;
		const notes = { scriptPath: lore.scriptPath, scriptFolder: this.scriptFolder() };
		const grounded = groundLoreCheck(raw, {
			...notes,
			scope: (script?.content ?? '').slice(0, chars),
			canonText: canon?.content ?? null,
			resolve: lore.resolve,
			shown,
			newId,
		});
		const readLore = grounded.issues.length > 0 || [...shown].some((p) => p !== this.canonNote() && isLoreNote(p, notes));
		return {
			scriptPath: lore.scriptPath,
			...grounded,
			...(readLore ? {} : { readNoLore: true as const }),
			...(chars < total ? { shown: { chars, of: total } } : {}),
			...(canon && canonChars < canon.content.length ? { canonShown: { chars: canonChars, of: canon.content.length } } : {}),
			...(loreCut > 0 ? { loreCut } : {}),
		};
	}

	/**
	 * Save to vault: propose a research note for an answer that cites web
	 * pages. It goes through the ProposalEngine like any new note and is
	 * reviewed under the answer; nothing is written until the user approves.
	 * Returns null when the answer cites no web page a search returned.
	 */
	async proposeResearchNote(conv: Conversation, messageId: string, resolve: (link: string) => string | null): Promise<ChangeProposal | null> {
		const note = researchNoteFor(conv.messages, conv.proposals, messageId, resolve, (path) => this.vault.exists(path), new Date());
		const message = conv.messages.find((m) => m.id === messageId);
		if (!note || !message) return null;
		const proposal = await this.proposals.proposeCreate(conv.id, note.path, note.content, 'Research note from a web-sourced answer');
		conv.proposals[proposal.id] = proposal;
		message.researchProposalId = proposal.id;
		this.store.touch(conv);
		return proposal;
	}

	/** The script folder setting as a vault path; empty when unset. */
	scriptFolder(): string {
		return normalizeVaultPath(this.settings.scriptFolder);
	}

	/** The sequel canon note's vault path. */
	canonNote(): string {
		return canonNotePath(this.settings.canonNote, this.vault.configDir);
	}

	/**
	 * What a lore check covers: the open note, or its selection when there is
	 * one. Refuses, with a reason for the user, when there is nothing to check.
	 */
	async loreScript(): Promise<ContextItem> {
		const { path, selection } = this.vault.getActiveContext();
		if (!path) throw new ProposalError('Open the script note to check, then try again.');
		if (path === this.canonNote()) throw new ProposalError(`${baseName(path)} is the sequel canon note, so there is nothing to check it against.`);
		const content = selection || (await this.vault.readNote(path));
		if (!content?.trim()) throw new ProposalError(`${baseName(path)} is empty, so there is nothing to check.`);
		return selection ? { kind: 'selection', label: 'Selection', path, content } : { kind: 'active', label: 'Active note', path, content };
	}

	/** Lore check: a read-only turn on `script`; the result lands on the reply as a `LoreCheckRecord`. */
	async checkLore(conv: Conversation, script: ContextItem, opts: LoreCheckOptions): Promise<void> {
		const path = script.path ?? '';
		await this.send(conv, { text: loreCheckRequest(path, script.kind === 'selection'), context: [script], signal: opts.signal, onEvent: opts.onEvent, loreCheck: { scriptPath: path, resolve: opts.resolve } });
	}

	/** The issue and its check, or an error for a list that is gone. */
	private loreIssue(conv: Conversation, messageId: string, issueId: string): { check: LoreCheckRecord; issue: LoreIssue } {
		const check = conv.messages.find((m) => m.id === messageId)?.loreCheck;
		const issue = check?.issues.find((i) => i.id === issueId);
		if (!check || !issue) throw new ProposalError('That issue is no longer in this conversation.');
		return { check, issue };
	}

	/** Fix it: propose the corrected line in the script, reviewed under the issue. */
	async fixLoreIssue(conv: Conversation, messageId: string, issueId: string): Promise<ChangeProposal> {
		const { check, issue } = this.loreIssue(conv, messageId, issueId);
		return this.holdIssueProposal(conv, issue, await proposeLoreFix(this.proposals, this.vault, conv.id, check.scriptPath, issue));
	}

	/** Intentional: propose recording the change in the sequel canon note, reviewed under the issue. */
	async markLoreIntentional(conv: Conversation, messageId: string, issueId: string): Promise<ChangeProposal> {
		const { check, issue } = this.loreIssue(conv, messageId, issueId);
		return this.holdIssueProposal(conv, issue, await proposeCanonEntry(this.proposals, this.vault, conv.id, this.canonNote(), check.scriptPath, issue));
	}

	private holdIssueProposal(conv: Conversation, issue: LoreIssue, proposal: ChangeProposal): ChangeProposal {
		conv.proposals[proposal.id] = proposal;
		issue.proposalId = proposal.id;
		this.store.touch(conv);
		return proposal;
	}

	/**
	 * Insert a draft version into the open note: a proposal that puts the
	 * draft over the editor's selection or at its cursor, reviewed under the
	 * draft like any edit. An earlier insert of the same thread still awaiting
	 * review is superseded (rejected), so one review is open per draft.
	 */
	async insertDraft(conv: Conversation, messageId: string): Promise<ChangeProposal> {
		const message = conv.messages.find((m) => m.id === messageId);
		if (!message?.draft) throw new ProposalError('There is no draft to insert.');
		const target = await this.vault.getInsertTarget();
		if (!target) throw new ProposalError('Open the note to insert into, place the cursor or select the text to replace, then try again.');
		const proposal = await proposeDraftInsert(this.proposals, conv.id, target, message.draft.text, this.scriptFolder());
		for (const m of conv.messages) {
			if (m.draft?.thread !== message.draft.thread) continue;
			for (const id of m.draft.inserts ?? []) {
				const earlier = conv.proposals[id];
				if (earlier && (earlier.status === 'pending' || earlier.status === 'stale')) this.proposals.reject(earlier);
			}
		}
		conv.proposals[proposal.id] = proposal;
		(message.draft.inserts ??= []).push(proposal.id);
		this.store.touch(conv);
		return proposal;
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

	/**
	 * Re-check the conversation's open proposals against the vault, all of
	 * them or only those for `path`. Returns the proposals whose status
	 * changed so the view can redraw their cards.
	 */
	async refreshProposals(conv: Conversation, path?: string): Promise<ChangeProposal[]> {
		const changed: ChangeProposal[] = [];
		for (const p of Object.values(conv.proposals)) {
			if (path !== undefined && p.path !== path) continue;
			if (await this.proposals.refresh(p)) changed.push(p);
		}
		if (changed.length > 0) this.store.touch(conv);
		return changed;
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

	/** Approve all: apply a turn's pending proposals together, all or nothing (`ProposalEngine.applyAll`). */
	async approveAll(conv: Conversation, batch: readonly ChangeProposal[]): Promise<ChangeProposal[]> {
		try {
			return await this.proposals.applyAll(batch);
		} finally {
			this.store.touch(conv);
		}
	}

	rejectAll(conv: Conversation, batch: readonly ChangeProposal[]): void {
		for (const p of batch) this.proposals.reject(p);
		this.store.touch(conv);
	}

	/** Undo all: revert a turn's applied proposals together, all or nothing (`ProposalEngine.revertAll`). */
	async revertAll(conv: Conversation, batch: readonly ChangeProposal[]): Promise<ChangeProposal[]> {
		try {
			return await this.proposals.revertAll(batch);
		} finally {
			this.store.touch(conv);
		}
	}
}

function newId(): string {
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
