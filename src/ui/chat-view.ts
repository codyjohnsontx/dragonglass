import { ItemView, MarkdownRenderer, Notice, Platform, Scope, setIcon, TAbstractFile, TFile, WorkspaceLeaf } from 'obsidian';
import { ContextItem } from '../agent/context';
import { draftVersions, parseDraft } from '../agent/drafting';
import { AnswerSources, answerSources, linkWebMarkers, WebSource } from '../agent/sources';
import { RunEvent } from '../agent/runtime';
import { DragonglassCore } from '../core';
import { Conversation, ProposalTurn, proposalTurns, StoredMessage, TurnUsage, usageByTurn } from '../persistence/conversation';
import { modelChoices, ModelMenu, withConfiguredModel } from '../providers/model-choices';
import { ModelInfo, PROVIDER_IDS, ProviderErrorKind, ProviderId, ToolCall } from '../providers/types';
import { ActiveContext } from '../vault/port';
import { baseName } from '../vault/paths';
import { ConfirmModal } from './confirm-modal';
import { renderBatchCard, renderProposalCard } from './proposal-card';
import { markUnresolvedLinks, openInternalLink, renderSourcesList } from './sources-list';
import { NotePickerModal } from './note-picker';
import { copyToClipboard, CopyAnnouncer } from './copy';
import { isSendKey, sendShortcutLabel } from './composer-keys';
import { renderWebSearchApproval } from './web-approval';
import { labelInsertButtons, renderDraftCard, renderDraftRef } from './draft-card';
import { renderLoreCard } from './lore-card';
import type { WebSearchDecision, WebSearchRequest } from '../tools/web-tools';

export const VIEW_TYPE_CHAT = 'dragonglass-chat';

/**
 * The chat sidebar. Owns the currently open conversation, the composer and
 * the live rendering of a streaming turn. All provider and vault work goes
 * through DragonglassCore.
 */
export class ChatView extends ItemView {
	private conv: Conversation | null = null;
	private abort: AbortController | null = null;
	private attachments: TFile[] = [];
	private includeActive: boolean;
	private includeSelection: boolean;
	/**
	 * The selection sent with the last message. An editor selection outlives
	 * the message it was made for, so the same text is not attached again
	 * unless the user asks; a new selection is included as the setting says.
	 */
	private sentSelection: { path: string | null; text: string } | null = null;
	private readonly modelMenu = new ModelMenu();
	/** Bumped per connection check so a check for a provider switched away from cannot set the light. */
	private statusSeq = 0;

	private headerEl!: HTMLElement;
	private messagesEl!: HTMLElement;
	private contextBarEl!: HTMLElement;
	private composerEl!: HTMLElement;
	private inputEl!: HTMLTextAreaElement;
	private sendBtn!: HTMLButtonElement;
	private loreBtn!: HTMLButtonElement;
	private statusEl!: HTMLElement;
	/** Shared visually-hidden live region announcing a successful copy to screen readers. */
	private copyStatusEl!: HTMLElement;
	private liveEl: HTMLElement | null = null;
	private liveText = '';
	/** Live-turn feedback: a status line until the first answer token, and the thinking block. */
	private liveStatusEl: HTMLElement | null = null;
	private liveStatusText = '';
	private liveThinkingEl: HTMLElement | null = null;
	private liveThinkingBodyEl: HTMLElement | null = null;
	private liveThinking = '';
	private turnStartedAt = 0;
	/** When the current thinking phase began; null once its "Thought for" label is set. */
	private thinkingStartedAt: number | null = null;
	private turnTimer: number | null = null;
	/** Chips for tool calls the model has started this round, in call order, and the row holding them. */
	private liveToolRow: HTMLElement | null = null;
	private liveToolChips: HTMLElement[] = [];
	private runningChip: HTMLElement | null = null;
	private pendingApproval: { conv: Conversation; card: HTMLElement } | null = null;
	/** The draft version shown in each thread's card, by thread id, with the thread's version count when it was picked: a redraw keeps the user's place until a new version arrives. */
	private readonly shownDraft = new Map<string, { id: string; of: number }>();
	/** The conversation whose turn is running, while one is. */
	private liveConv: Conversation | null = null;
	private lastStatus: { state: 'ok' | 'error' | 'checking'; title: string } | null = null;
	/** Serializes announcements to the shared copyStatusEl across concurrent copy clicks. */
	private readonly copyAnnouncer = new CopyAnnouncer({
		setTimeout: (fn, delayMs) => window.setTimeout(fn, delayMs),
		clearTimeout: (id) => window.clearTimeout(id),
	});

	constructor(
		leaf: WorkspaceLeaf,
		private readonly core: DragonglassCore,
		private readonly onConversationChange: (id: string | null) => void,
	) {
		super(leaf);
		this.includeActive = core.getSettings().includeActiveNote;
		this.includeSelection = core.getSettings().includeSelection;
		this.navigation = false;
		// Mod+Enter is Obsidian's "open link in new tab" hotkey, which the app
		// scope claims before any element listener sees the key. A view scope is
		// consulted first while this view is focused, so the composer gets it.
		// The handler catches every key because Scope only passes a key it did
		// not handle on to the app scope when the matching handler is a
		// catch-all; a Mod+Enter handler returning nothing would swallow it.
		this.scope = new Scope(this.app.scope);
		this.scope.register(null, null, (evt) => {
			if (evt.target !== this.inputEl || !isSendKey(evt, Platform.isMacOS)) return;
			void this.submit();
			return false;
		});
	}

	getViewType(): string {
		return VIEW_TYPE_CHAT;
	}

	getDisplayText(): string {
		return 'Dragonglass AI';
	}

	getIcon(): string {
		return 'gem';
	}

	async onOpen(): Promise<void> {
		const root = this.contentEl;
		root.empty();
		root.addClass('dragonglass-view');
		this.headerEl = root.createDiv({ cls: 'dg-header' });
		this.messagesEl = root.createDiv({ cls: 'dg-messages' });
		this.registerDomEvent(this.messagesEl, 'click', (evt) => openInternalLink(this.app, evt));
		this.copyStatusEl = root.createDiv({ cls: 'dg-copy-status', attr: { role: 'status', 'aria-live': 'polite' } });
		this.contextBarEl = root.createDiv({ cls: 'dg-context-bar' });
		this.composerEl = root.createDiv({ cls: 'dg-composer' });
		this.buildComposer();
		await this.openConversation(this.core.getSettings().lastConversationId);
		this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.renderContextBar()));
		this.registerEvent(this.app.workspace.on('file-open', () => this.renderContextBar()));
		// Closing the tracked note's tab or popout fires neither event above.
		this.registerEvent(this.app.workspace.on('layout-change', () => this.renderContextBar()));
		// A note edited behind a pending proposal makes the proposal stale; say so before Approve is clicked.
		this.registerEvent(this.app.vault.on('modify', (file) => void this.onNoteModified(file)));
		await this.renderHeader();
		void this.refreshStatus();
	}

	async onClose(): Promise<void> {
		this.abort?.abort();
		this.copyAnnouncer.dispose();
		await this.core.store.flush();
	}

	// ---------------------------------------------------------------- header

	private async renderHeader(): Promise<void> {
		const h = this.headerEl;
		h.empty();
		const settings = this.core.getSettings();

		const convRow = h.createDiv({ cls: 'dg-header-row' });
		const convSelect = convRow.createEl('select', { cls: 'dropdown dg-conv-select' });
		const list = await this.core.store.listConversations();
		if (this.conv && !list.some((e) => e.id === this.conv?.id)) {
			list.unshift({ id: this.conv.id, title: this.conv.title, updatedAt: this.conv.updatedAt });
		}
		for (const entry of list) {
			const opt = convSelect.createEl('option', { text: entry.title, value: entry.id });
			if (entry.id === this.conv?.id) opt.selected = true;
		}
		convSelect.addEventListener('change', () => void this.openConversation(convSelect.value));
		this.iconButton(convRow, 'plus', 'New conversation', () => void this.newConversation());
		this.iconButton(convRow, 'trash-2', 'Delete conversation', () => void this.deleteConversation());

		const modelRow = h.createDiv({ cls: 'dg-header-row' });
		const providerSelect = modelRow.createEl('select', { cls: 'dropdown dg-provider-select' });
		for (const id of PROVIDER_IDS) {
			const opt = providerSelect.createEl('option', { text: this.core.provider(id).displayName, value: id });
			if (id === settings.activeProvider) opt.selected = true;
		}
		providerSelect.addEventListener('change', () => void this.switchProvider(providerSelect.value as ProviderId));
		const modelSelect = modelRow.createEl('select', { cls: 'dropdown dg-model-select' });
		const current = this.core.activeModel();
		const models = withConfiguredModel(this.modelMenu.models(settings.activeProvider), current);
		if (models.length === 0) modelSelect.createEl('option', { text: 'No model selected', value: '' });
		for (const m of models) modelSelect.createEl('option', { text: m.label ?? m.id, value: m.id });
		modelSelect.value = current;
		modelSelect.addEventListener('change', () => void this.core.setActiveModel(modelSelect.value));
		this.iconButton(modelRow, 'refresh-cw', 'Refresh model list', () => void this.refreshModels());
		this.statusEl = modelRow.createSpan({ cls: 'dg-status', text: '' });
		if (this.lastStatus) this.setStatus(this.lastStatus.state, this.lastStatus.title);
	}

	private async switchProvider(id: ProviderId): Promise<void> {
		await this.core.setActiveProvider(id);
		await this.renderHeader();
		void this.refreshStatus();
		this.renderContextBar();
	}

	private iconButton(parent: HTMLElement, icon: string, label: string, onClick: () => void): HTMLButtonElement {
		const btn = parent.createEl('button', { cls: 'clickable-icon dg-icon-btn', attr: { 'aria-label': label } });
		setIcon(btn, icon);
		btn.addEventListener('click', onClick);
		return btn;
	}

	/**
	 * Re-check the connection and show the result in the header light. The
	 * models the check listed fill the menu with `reloadModels`, when it holds
	 * nothing for the provider yet, or when they replace its suggested models.
	 * The menu falls back to the provider's suggested models when it cannot
	 * list its own, such as before a key is entered. With `quiet` false a
	 * failure is also raised as a Notice.
	 */
	private async refreshStatus(quiet = true, signal?: AbortSignal, reloadModels = false): Promise<void> {
		const seq = ++this.statusSeq;
		const prior = this.lastStatus;
		this.setStatus('checking', 'Checking connection…');
		const provider = this.core.getSettings().activeProvider;
		const status = await this.core.checkConnection(provider, signal);
		if (seq !== this.statusSeq) return;
		if (signal?.aborted) {
			if (prior) this.setStatus(prior.state, prior.title);
			return;
		}
		await this.showModels(provider, status.models, reloadModels);
		if (seq !== this.statusSeq) return;
		if (status.ok) {
			this.setStatus('ok', status.detail);
		} else {
			this.setStatus('error', status.error.userMessage());
			if (!quiet) new Notice(status.error.userMessage(), 8000);
		}
	}

	/** The refresh button: check again and reload the list, reporting failure as a Notice. */
	private async refreshModels(): Promise<void> {
		await this.refreshStatus(false, undefined, true);
	}

	private setStatus(state: 'ok' | 'error' | 'checking', title: string): void {
		this.lastStatus = { state, title };
		if (!this.statusEl) return;
		this.statusEl.empty();
		this.statusEl.dataset['state'] = state;
		this.statusEl.setAttribute('aria-label', title);
		this.statusEl.setAttribute('title', title);
		setIcon(this.statusEl, state === 'ok' ? 'circle-check' : state === 'error' ? 'circle-alert' : 'loader');
	}

	private async showModels(provider: ProviderId, listed: ModelInfo[] | undefined, replace: boolean): Promise<void> {
		// The user switched providers while the check ran.
		if (this.core.getSettings().activeProvider !== provider) return;
		const choices = modelChoices(provider, listed);
		if (!this.modelMenu.offer(provider, choices, replace)) return;
		if (!this.core.activeModel() && choices.models[0]) await this.core.setActiveModel(choices.models[0].id);
		await this.renderHeader();
	}

	// ---------------------------------------------------------- conversation

	private async openConversation(id: string | null): Promise<void> {
		this.abort?.abort();
		let conv = id ? await this.core.store.load(id) : null;
		if (!conv) {
			const list = await this.core.store.listConversations();
			const first = list[0];
			conv = first ? await this.core.store.load(first.id) : null;
		}
		if (!conv) conv = this.core.store.create();
		// Notes may have changed while this conversation was closed.
		await this.core.refreshProposals(conv);
		this.conv = conv;
		this.onConversationChange(conv.id);
		this.renderMessages();
		this.renderContextBar();
		if (this.headerEl.childElementCount > 0) await this.renderHeader();
	}

	private async newConversation(): Promise<void> {
		this.abort?.abort();
		this.conv = this.core.store.create();
		this.attachments = [];
		this.onConversationChange(this.conv.id);
		this.renderMessages();
		this.renderContextBar();
		await this.renderHeader();
		this.inputEl.focus();
	}

	private deleteConversation(): void {
		const conv = this.conv;
		if (!conv) return;
		const n = conv.messages.length;
		const what = n === 0 ? 'This empty conversation' : `"${conv.title}" and its ${n} message${n === 1 ? '' : 's'}`;
		new ConfirmModal(this.app, {
			title: 'Delete conversation?',
			body: `${what} will be removed from this vault. This cannot be undone.`,
			confirmText: 'Delete',
			destructive: true,
			onConfirm: async () => {
				if (this.conv === conv) this.abort?.abort();
				await this.core.store.delete(conv.id);
				if (this.conv === conv) {
					this.conv = null;
					await this.openConversation(null);
				} else {
					await this.renderHeader();
				}
			},
		}).open();
	}

	// -------------------------------------------------------------- messages

	private renderMessages(): void {
		const el = this.messagesEl;
		el.empty();
		if (!this.conv) return;
		if (this.conv.messages.length === 0) {
			const empty = el.createDiv({ cls: 'dg-empty' });
			empty.createEl('p', { text: 'Ask about your notes, or ask for an edit. Changes are shown as a diff for you to approve.' });
			return;
		}
		// One usage line per user turn, on its last reply, rather than one per tool round.
		const usage = this.core.getSettings().showUsage ? usageByTurn(this.conv.messages) : new Map<string, TurnUsage>();
		const sources = answerSources(this.conv.messages, this.conv.proposals, (link) => this.app.metadataCache.getFirstLinkpathDest(link, '')?.path ?? null);
		const messages = this.conv.messages;
		const answered = (c: ToolCall) => messages.some((t) => t.role === 'tool' && t.toolCallId === c.id);
		// While a turn runs, the calls of its latest reply are running or waiting, not "not run".
		const live = this.liveConv === this.conv ? [...messages].reverse().find((m) => m.role === 'assistant') : undefined;
		// A stopped reply whose calls returned ends after their result rows, where the turn ended.
		let stopped: StoredMessage | null = null;
		for (const m of messages) {
			if (stopped && m.role !== 'tool') {
				this.renderTurnEnd(stopped, el.createDiv({ cls: 'dg-msg dg-msg-assistant' }), usage.get(stopped.id));
				stopped = null;
			}
			const endAfterTools = !!m.interrupted && (m.toolCalls ?? []).some(answered);
			this.renderMessage(m, el, usage.get(m.id), { list: sources.lists.get(m.id), web: sources.web.get(m.id) ?? [] }, { live: m === live, endAfterTools });
			if (endAfterTools) stopped = m;
		}
		if (stopped) this.renderTurnEnd(stopped, el.createDiv({ cls: 'dg-msg dg-msg-assistant' }), usage.get(stopped.id));
		this.renderUsage(el);
		if (live && this.liveToolRow) el.appendChild(this.liveToolRow);
		if (this.pendingApproval?.conv === this.conv) el.appendChild(this.pendingApproval.card);
		this.scrollToBottom();
	}

	/**
	 * Render one stored message. A tool call is shown on the row of its result
	 * (the chip in the summary), so an assistant turn that only called tools
	 * renders as a bare step: its thinking, if any, and nothing else.
	 */
	private renderMessage(
		m: StoredMessage,
		parent: HTMLElement,
		turnUsage?: TurnUsage,
		sources?: { list?: AnswerSources; web: WebSource[] },
		opts: { live?: boolean; endAfterTools?: boolean } = {},
	): HTMLElement {
		const wrap = parent.createDiv({ cls: `dg-msg dg-msg-${m.role}` });
		if (m.role === 'user') {
			wrap.createDiv({ cls: 'dg-msg-body', text: m.content });
			if (m.context && (m.context.activeNotePath || m.context.selection || m.context.attachments.length)) {
				const ctx = wrap.createDiv({ cls: 'dg-msg-context' });
				if (m.context.activeNotePath) ctx.createSpan({ cls: 'dg-chip', text: `Active: ${m.context.activeNotePath}` });
				if (m.context.selection) ctx.createSpan({ cls: 'dg-chip', text: `Selection (${m.context.selection.length} chars)` });
				for (const a of m.context.attachments) ctx.createSpan({ cls: 'dg-chip', text: a.path });
			}
		} else if (m.role === 'assistant') {
			const toolOnly = !m.content && !m.error && (!m.interrupted || opts.endAfterTools) && (m.toolCalls?.length ?? 0) > 0;
			if (toolOnly) wrap.addClass('dg-msg-step');
			if (m.thinking) this.renderThinking(wrap, 'Thinking', m.thinking);
			if (m.loreCheck && this.conv) {
				this.renderLoreMessage(this.conv, m, wrap);
				if (sources?.list) renderSourcesList(wrap, sources.list);
			} else if (m.draft && this.conv) {
				this.renderDraftMessage(this.conv, m, wrap, sources);
			} else if (m.content) {
				const body = wrap.createDiv({ cls: 'dg-msg-body markdown-rendered' });
				void MarkdownRenderer.render(this.app, linkWebMarkers(m.content, sources?.web ?? []), body, '', this).then(() => markUnresolvedLinks(this.app, body));
				if (sources?.list) renderSourcesList(wrap, sources.list);
				const actions = this.addCopyButton(wrap, m.content);
				if (this.conv && sources?.list?.web.some((w) => w.source)) this.renderResearch(this.conv, m, wrap, actions);
			} else if (sources?.list) {
				renderSourcesList(wrap, sources.list);
			}
			// A call whose result never arrived (the run died first) has no result row to live on.
			const unanswered = opts.live ? [] : (m.toolCalls ?? []).filter((c) => !this.conv?.messages.some((t) => t.role === 'tool' && t.toolCallId === c.id));
			if (unanswered.length > 0) {
				const calls = wrap.createDiv({ cls: 'dg-tool-calls' });
				for (const c of unanswered) calls.createSpan({ cls: 'dg-chip dg-chip-tool', text: `${c.name}${argsPreview(c.argumentsJson)} (not run)` });
			}
			if (m.interrupted && !opts.endAfterTools) wrap.createDiv({ cls: 'dg-msg-note', text: 'Stopped.' });
			for (const w of m.warnings ?? []) wrap.createDiv({ cls: 'dg-msg-warning', text: w });
			if (m.error) wrap.createDiv({ cls: 'dg-msg-error', text: m.error });
			if (turnUsage && !opts.endAfterTools) wrap.createDiv({ cls: 'dg-msg-usage', text: usageLine(turnUsage, m.model) });
			if (wrap.childElementCount === 0) wrap.addClass('dg-msg-hidden');
		} else {
			const details = wrap.createEl('details', { cls: `dg-tool-result${m.isError ? ' dg-tool-error' : ''}` });
			const summary = details.createEl('summary');
			const call = this.conv ? findToolCall(this.conv, m.toolCallId) : undefined;
			const label = `${m.toolName ?? 'tool'}${call ? argsPreview(call.argumentsJson) : ''}`;
			summary.createSpan({ cls: 'dg-chip dg-chip-tool', text: label, attr: { title: label } });
			summary.appendText(m.isError ? ' error' : ' result');
			details.createEl('pre', { text: m.content.length > 4000 ? `${m.content.slice(0, 4000)}…` : m.content });
			if (m.proposalId && this.conv) this.renderReview(this.conv, m, wrap);
		}
		return wrap;
	}

	/**
	 * A reply that drafted scene text: what the model said about the draft,
	 * then the draft card on the thread's latest version, or on an earlier
	 * version a one-line reference that shows it in the card. The draft block
	 * itself is not rendered as Markdown; the card holds the scene text.
	 */
	private renderDraftMessage(conv: Conversation, m: StoredMessage, wrap: HTMLElement, sources?: { list?: AnswerSources; web: WebSource[] }): void {
		if (!m.draft) return;
		const thread = m.draft.thread;
		const commentary = parseDraft(m.content)?.commentary ?? '';
		if (commentary) {
			const body = wrap.createDiv({ cls: 'dg-msg-body markdown-rendered' });
			void MarkdownRenderer.render(this.app, linkWebMarkers(commentary, sources?.web ?? []), body, '', this).then(() => markUnresolvedLinks(this.app, body));
		}
		const versions = draftVersions(conv.messages, thread);
		const latest = versions[versions.length - 1];
		const mine = versions.find((v) => v.messageId === m.id);
		if (latest && latest.messageId === m.id) {
			const card = wrap.createDiv();
			card.dataset['draftThread'] = thread;
			this.drawDraft(conv, thread, card);
		} else if (mine) {
			renderDraftRef(wrap, mine.number, versions.length, () => {
				this.shownDraft.set(thread, { id: m.id, of: versions.length });
				const card = this.redrawDraft(conv, thread);
				card?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
			});
		}
		if (sources?.list) renderSourcesList(wrap, sources.list);
	}

	private drawDraft(conv: Conversation, thread: string, card: HTMLElement): void {
		const versions = draftVersions(conv.messages, thread);
		const pin = this.shownDraft.get(thread);
		renderDraftCard(card, {
			app: this.app,
			core: this.core,
			conv,
			versions,
			shown: pin && pin.of === versions.length ? pin.id : null,
			onStep: (id) => this.shownDraft.set(thread, { id, of: versions.length }),
			insert: (id) => this.insertDraft(conv, id),
			copy: (parent, text) => this.copyButton(parent, text, 'Copy draft to clipboard'),
			onChange: () => this.redrawDraft(conv, thread),
		});
	}

	/** Redraw a thread's card in place, so a live turn is not disturbed; returns the card, or null when it is not on screen. */
	private redrawDraft(conv: Conversation, thread: string): HTMLElement | null {
		if (this.conv !== conv) return null;
		const card = this.messagesEl.querySelector<HTMLElement>(`[data-draft-thread="${thread}"]`);
		if (card) this.drawDraft(conv, thread, card);
		return card;
	}

	/** Insert: propose putting the draft into the open note; the review appears in the card and scrolls into view, an error as a Notice. */
	private async insertDraft(conv: Conversation, messageId: string): Promise<void> {
		let inserted = false;
		try {
			await this.core.insertDraft(conv, messageId);
			inserted = true;
		} catch (e) {
			new Notice(e instanceof Error ? e.message : String(e), 8000);
		} finally {
			const thread = conv.messages.find((m) => m.id === messageId)?.draft?.thread;
			const card = thread ? this.redrawDraft(conv, thread) : null;
			if (inserted) card?.querySelector('.dg-draft-review')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
		}
	}

	/** A reply that ended a lore check: the list of issues, in place of the reply's own text. */
	private renderLoreMessage(conv: Conversation, m: StoredMessage, wrap: HTMLElement): void {
		const card = wrap.createDiv();
		card.dataset['loreCheck'] = m.id;
		this.drawLoreCard(conv, m.id, card);
	}

	private drawLoreCard(conv: Conversation, messageId: string, card: HTMLElement): void {
		const check = conv.messages.find((m) => m.id === messageId)?.loreCheck;
		if (!check) return;
		const redraw = () => this.redrawLoreCard(conv, messageId);
		const act = async (run: () => Promise<unknown>): Promise<void> => {
			try {
				await run();
			} catch (e) {
				new Notice(e instanceof Error ? e.message : String(e), 8000);
			}
			redraw();
		};
		renderLoreCard(card, {
			app: this.app,
			core: this.core,
			conv,
			check,
			fix: (issue) => act(() => this.core.fixLoreIssue(conv, messageId, issue.id)),
			intentional: (issue) => act(() => this.core.markLoreIntentional(conv, messageId, issue.id)),
			onChange: redraw,
		});
	}

	/** Redraw one check's list in place, so a live turn is not disturbed. */
	private redrawLoreCard(conv: Conversation, messageId: string): void {
		if (this.conv !== conv) return;
		const card = this.messagesEl.querySelector<HTMLElement>(`[data-lore-check="${messageId}"]`);
		if (card) this.drawLoreCard(conv, messageId, card);
	}

	/** The Stopped note and usage line of a stopped reply, drawn after its tool results. */
	private renderTurnEnd(m: StoredMessage, wrap: HTMLElement, turnUsage?: TurnUsage): void {
		wrap.createDiv({ cls: 'dg-msg-note', text: 'Stopped.' });
		if (turnUsage) wrap.createDiv({ cls: 'dg-msg-usage', text: usageLine(turnUsage, m.model) });
	}

	/**
	 * The review for a turn's proposals sits on the row of the turn's last
	 * proposal: a plain card for one proposal, a grouped card with Approve all
	 * for several (`proposalTurns`). While a turn is live each new proposal
	 * moves the review down to its own row, so the card drawn on an earlier
	 * row goes.
	 */
	private renderReview(conv: Conversation, m: StoredMessage, parent: HTMLElement): void {
		const turn = proposalTurns(conv).find((t) => t.proposals.some((p) => p.id === m.proposalId));
		if (!turn || turn.anchorMessageId !== m.id) return;
		this.messagesEl.querySelector(`[data-review-turn="${turn.turnId}"]`)?.remove();
		const card = parent.createDiv();
		card.dataset['reviewTurn'] = turn.turnId;
		this.drawReview(conv, turn, card);
	}

	private drawReview(conv: Conversation, turn: ProposalTurn, card: HTMLElement): void {
		const redraw = () => this.renderMessages();
		const [only] = turn.proposals;
		if (only && turn.proposals.length === 1) {
			card.dataset['proposalId'] = only.id;
			renderProposalCard(this.app, this.core, conv, only, card, redraw);
		} else {
			delete card.dataset['proposalId'];
			renderBatchCard(this.app, this.core, conv, turn.proposals, card, redraw);
		}
	}

	/**
	 * Re-check proposals for an edited note and redraw their reviews in place,
	 * without disturbing a live turn. A proposal in a grouped card redraws the
	 * whole group, since its header says whether Approve all is still allowed.
	 */
	private async onNoteModified(file: TAbstractFile): Promise<void> {
		const conv = this.conv;
		if (!conv || !(file instanceof TFile)) return;
		const changed = await this.core.refreshProposals(conv, file.path);
		if (this.conv !== conv) return;
		const turns = changed.length > 0 ? proposalTurns(conv) : [];
		const redrawn = new Set<HTMLElement>();
		for (const p of changed) {
			const el = this.messagesEl.querySelector<HTMLElement>(`[data-proposal-id="${p.id}"]`);
			if (!el) continue;
			const review = el.closest<HTMLElement>('[data-review-turn]');
			if (review) {
				if (redrawn.has(review)) continue;
				redrawn.add(review);
				const turn = turns.find((t) => t.proposals.includes(p));
				if (turn) this.drawReview(conv, turn, review);
				continue;
			}
			const draft = el.closest<HTMLElement>('[data-draft-thread]');
			if (draft) {
				// Only the review: redrawing the whole card would replace its Insert button mid-click, as the
				// editor's save on blur fires this between the mousedown and mouseup of a click on Insert.
				const thread = draft.dataset['draftThread'] ?? '';
				renderProposalCard(this.app, this.core, conv, p, el, () => this.redrawDraft(conv, thread));
				continue;
			}
			// As with a draft, only the review: a click on Fix it is what saved the note.
			const lore = el.closest<HTMLElement>('[data-lore-check]')?.dataset['loreCheck'];
			if (lore) renderProposalCard(this.app, this.core, conv, p, el, () => this.redrawLoreCard(conv, lore));
		}
	}

	/**
	 * A visible Copy button under a reply. It puts the reply's Markdown on the
	 * clipboard and reads "Copied" for a moment so a click is seen to work.
	 */
	private addCopyButton(wrap: HTMLElement, text: string): HTMLElement {
		const row = wrap.createDiv({ cls: 'dg-msg-actions' });
		this.copyButton(row, text, 'Copy reply to clipboard');
		return row;
	}

	/** A Copy button for `text` in `parent`, sharing the view's "Copied" announcement. */
	private copyButton(parent: HTMLElement, text: string, label: string): HTMLButtonElement {
		const btn = parent.createEl('button', { cls: 'dg-copy-btn', attr: { 'aria-label': label } });
		const icon = btn.createSpan();
		const caption = btn.createSpan();
		const show = (name: string, text: string): void => {
			setIcon(icon, name);
			caption.setText(text);
		};
		show('copy', 'Copy');
		let revert: number | null = null;
		btn.addEventListener('click', () => {
			const attempt = this.copyAnnouncer.begin();
			void copyToClipboard(text, activeWindow.navigator.clipboard).then((ok) => {
				if (!ok) return;
				btn.addClass('is-copied');
				show('check', 'Copied');
				this.copyAnnouncer.announce(attempt, this.copyStatusEl, 'Copied to clipboard.', 100);
				if (revert !== null) window.clearTimeout(revert);
				revert = window.setTimeout(() => {
					btn.removeClass('is-copied');
					show('copy', 'Copy');
					revert = null;
				}, 1500);
			});
		});
		return btn;
	}

	/**
	 * Save to vault, on an answer that cites web pages: proposes a research
	 * note, reviewed in a card under the answer. Once proposed the card
	 * replaces the button, unless the note was rejected, when it can be
	 * proposed again.
	 */
	private renderResearch(conv: Conversation, m: StoredMessage, wrap: HTMLElement, actions: HTMLElement): void {
		const proposal = m.researchProposalId ? conv.proposals[m.researchProposalId] : undefined;
		if (proposal && proposal.status !== 'rejected') {
			const card = wrap.createDiv({ cls: 'dg-research-review' });
			card.dataset['proposalId'] = proposal.id;
			renderProposalCard(this.app, this.core, conv, proposal, card, () => this.renderMessages());
			return;
		}
		const btn = actions.createEl('button', { cls: 'dg-copy-btn dg-save-research', attr: { 'aria-label': 'Propose a research note with this answer and its web sources' } });
		setIcon(btn.createSpan(), 'file-plus');
		btn.createSpan({ text: 'Save to vault' });
		btn.addEventListener('click', () => {
			btn.disabled = true;
			const resolve = (link: string) => this.app.metadataCache.getFirstLinkpathDest(link, '')?.path ?? null;
			void this.core
				.proposeResearchNote(conv, m.id, resolve)
				.then((p) => {
					if (!p) new Notice('This answer cites no web page, so there is nothing to save.');
				})
				.catch((e: unknown) => new Notice(`Could not propose the note: ${e instanceof Error ? e.message : String(e)}`, 10000))
				.finally(() => {
					if (this.conv === conv && !this.abort) this.renderMessages();
					else btn.disabled = false;
				});
		});
	}

	/**
	 * Ask the user to approve a web search, in the chat below the running
	 * turn. Stop, or switching conversations, declines it.
	 */
	private askWebSearch(conv: Conversation, req: WebSearchRequest, signal: AbortSignal): Promise<WebSearchDecision> {
		if (signal.aborted || this.conv !== conv) return Promise.resolve({ approved: false });
		this.runningChip?.querySelector('.dg-chip-label')?.setText('Waiting for your approval to search the web…');
		const card = this.messagesEl.createDiv({ cls: 'dg-msg dg-web-approval' });
		const pending = { conv, card };
		this.pendingApproval = pending;
		this.scrollToBottom();
		return renderWebSearchApproval(card, req, signal).finally(() => {
			if (this.pendingApproval === pending) this.pendingApproval = null;
			card.remove();
		});
	}

	/** Collapsed block holding a thinking model's reasoning. Returns the summary and body elements. */
	private renderThinking(parent: HTMLElement, summary: string, text: string): { details: HTMLDetailsElement; body: HTMLElement } {
		const details = parent.createEl('details', { cls: 'dg-thinking' });
		details.createEl('summary', { text: summary });
		const body = details.createDiv({ cls: 'dg-thinking-body', text });
		return { details, body };
	}

	private renderUsage(parent: HTMLElement): void {
		if (!this.conv || !this.core.getSettings().showUsage) return;
		const usage = this.core.conversationUsage(this.conv);
		const total = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
		if (total === 0) return;
		const billed = this.core.provider().capabilities.billed;
		const el = parent.createDiv({ cls: 'dg-conv-usage' });
		el.setText(`Conversation total: ${usage.inputTokens} in / ${usage.outputTokens} out tokens${billed ? ' (billed by your provider; this is an estimate, not an invoice)' : ''}`);
		const warn = this.core.getSettings().usageWarningTokens;
		if (warn > 0 && total >= warn) {
			el.addClass('dg-usage-warning');
			el.appendText(` · exceeds your warning threshold of ${warn} tokens`);
		}
	}

	private scrollToBottom(): void {
		this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
	}

	// ----------------------------------------------------------- context bar

	private renderContextBar(): void {
		const bar = this.contextBarEl;
		bar.empty();
		const active = this.core.vault.getActiveContext();
		const activeToggle = bar.createEl('button', {
			cls: `dg-chip dg-chip-toggle${this.includeActive && active.path ? ' is-active' : ''}`,
			text: active.path ? `Active note: ${active.path}` : 'No active note',
		});
		activeToggle.disabled = !active.path;
		activeToggle.addEventListener('click', () => {
			this.includeActive = !this.includeActive;
			this.renderContextBar();
		});
		if (active.selection) {
			const sent = this.selectionAlreadySent(active);
			const from = active.path ? ` from ${baseName(active.path)}` : '';
			const selToggle = bar.createEl('button', {
				cls: `dg-chip dg-chip-toggle${this.selectionIncluded(active) ? ' is-active' : ''}`,
				text: `Selection${from} (${active.selection.length} chars)`,
			});
			if (sent) selToggle.setAttribute('aria-label', 'Already sent with your previous message. Click to include it again.');
			selToggle.addEventListener('click', () => {
				if (sent) {
					this.sentSelection = null;
					this.includeSelection = true;
				} else {
					this.includeSelection = !this.includeSelection;
				}
				this.renderContextBar();
			});
		}
		for (const file of this.attachments) {
			const chip = bar.createSpan({ cls: 'dg-chip is-active', text: file.path });
			const x = chip.createSpan({ cls: 'dg-chip-remove', text: ' ×' });
			x.addEventListener('click', () => {
				this.attachments = this.attachments.filter((f) => f !== file);
				this.renderContextBar();
			});
		}
		const add = bar.createEl('button', { cls: 'dg-chip dg-chip-add', text: 'Attach note…' });
		add.addEventListener('click', () => {
			new NotePickerModal(this.app, (file) => {
				if (!this.attachments.includes(file)) this.attachments.push(file);
				this.renderContextBar();
			}).open();
		});
		if (this.core.activeProviderIsRemote()) {
			bar.createDiv({
				cls: 'dg-privacy-note',
				text: 'Highlighted context and your message are sent to the cloud provider you configured, with the sequel canon note and the opening of the open note while it is in the script folder.',
			});
		}
		// The note an Insert would go into follows the active note.
		labelInsertButtons(this.messagesEl, active.path);
		this.loreBtn.setText(active.selection ? 'Check lore of selection' : 'Check lore');
		this.loreBtn.disabled = !active.path;
		this.loreBtn.setAttribute('aria-label', active.path ? `Check ${active.selection ? 'the selection in ' : ''}${active.path} against the vault's lore` : 'Open a script note to check its lore');
	}

	private selectionAlreadySent(active: ActiveContext): boolean {
		return this.sentSelection !== null && this.sentSelection.text === active.selection && this.sentSelection.path === active.path;
	}

	private selectionIncluded(active: ActiveContext): boolean {
		return this.includeSelection && active.selection !== null && !this.selectionAlreadySent(active);
	}

	private async collectContext(): Promise<ContextItem[]> {
		const items: ContextItem[] = [];
		const active = this.core.vault.getActiveContext();
		if (this.includeActive && active.path) {
			const content = await this.core.vault.readNote(active.path);
			if (content !== null) items.push({ kind: 'active', label: 'Active note', path: active.path, content });
		}
		if (active.selection && this.selectionIncluded(active)) {
			items.push({ kind: 'selection', label: 'Selection', path: active.path, content: active.selection });
		}
		for (const file of this.attachments) {
			if (file.path === active.path && this.includeActive) continue;
			const content = await this.core.vault.readNote(file.path);
			if (content !== null) items.push({ kind: 'attachment', label: file.path, path: file.path, content });
		}
		return items;
	}

	// -------------------------------------------------------------- composer

	private buildComposer(): void {
		const c = this.composerEl;
		const shortcut = sendShortcutLabel(Platform.isMacOS);
		this.inputEl = c.createEl('textarea', {
			cls: 'dg-input',
			attr: { placeholder: `Message Dragonglass… (${shortcut} to send)`, rows: '3' },
		});
		// Enter and Shift+Enter insert a new line as in any textarea; the send
		// shortcut is registered on the view scope in the constructor.
		const row = c.createDiv({ cls: 'dg-composer-row' });
		this.loreBtn = row.createEl('button', { cls: 'dg-lore-run', text: 'Check lore' });
		this.loreBtn.addEventListener('click', () => void this.checkLore());
		this.sendBtn = row.createEl('button', { cls: 'mod-cta dg-send', text: 'Send' });
		this.sendBtn.addEventListener('click', () => void (this.abort ? this.stop() : this.submit()));
	}

	private stop(): void {
		this.abort?.abort();
	}

	private async submit(): Promise<void> {
		const text = this.inputEl.value.trim();
		if (!text || !this.conv || this.abort) return;
		const conv = this.conv;
		this.inputEl.value = '';
		const context = await this.collectContext();
		this.attachments = [];
		const selection = context.find((c) => c.kind === 'selection');
		if (selection) this.sentSelection = { path: selection.path, text: selection.content };
		await this.runTurn(conv, (signal, onEvent) =>
			this.core.send(conv, {
				text,
				context,
				signal,
				onEvent,
				approveWebSearch: (req, approvalSignal) => this.askWebSearch(conv, req, approvalSignal),
			}),
		);
	}

	/** The Check lore button: a turn of its own on the open note or its selection. */
	private async checkLore(): Promise<void> {
		const conv = this.conv;
		if (!conv || this.abort) return;
		let script: ContextItem;
		try {
			script = await this.core.loreScript();
		} catch (e) {
			new Notice(e instanceof Error ? e.message : String(e), 8000);
			return;
		}
		const resolve = (link: string) => this.app.metadataCache.getFirstLinkpathDest(link, '')?.path ?? null;
		await this.runTurn(conv, (signal, onEvent) => this.core.checkLore(conv, script, { signal, onEvent, resolve }));
	}

	/** Run one turn with the composer in its Stop state, rendering events as they arrive. */
	private async runTurn(conv: Conversation, run: (signal: AbortSignal, onEvent: (ev: RunEvent) => void) => Promise<void>): Promise<void> {
		this.abort = new AbortController();
		this.liveConv = conv;
		this.loreBtn.disabled = true;
		this.sendBtn.setText('Stop');
		this.sendBtn.removeClass('mod-cta');
		this.sendBtn.addClass('mod-warning');
		// The header light reflects the last check; a send is the moment it matters,
		// and it must finish first so a failure during the send is not painted over.
		await this.refreshStatus(true, this.abort.signal);
		if (this.messagesEl.querySelector('.dg-empty')) this.messagesEl.empty();
		try {
			await run(this.abort.signal, (ev) => this.onRunEvent(conv, ev));
		} finally {
			this.abort = null;
			this.liveConv = null;
			this.liveEl = null;
			this.endLiveTurn();
			this.sendBtn.setText('Send');
			this.sendBtn.addClass('mod-cta');
			this.sendBtn.removeClass('mod-warning');
			if (this.conv === conv) this.renderMessages();
			await this.renderHeader();
			this.renderContextBar();
		}
	}

	private onRunEvent(conv: Conversation, ev: RunEvent): void {
		if (this.conv !== conv) return;
		switch (ev.type) {
			case 'assistant_start': {
				const last = conv.messages[conv.messages.length - 1];
				// The user message was pushed before the run; render it once.
				const prev = conv.messages[conv.messages.length - 2];
				if (prev?.role === 'user' && !this.messagesEl.querySelector(`[data-id="${prev.id}"]`)) {
					this.renderMessage(prev, this.messagesEl).dataset['id'] = prev.id;
					// The first message names the conversation; show the name now, not after the reply.
					if (prev === conv.messages[0]) void this.renderHeader();
				}
				const wrap = this.messagesEl.createDiv({ cls: 'dg-msg dg-msg-assistant dg-msg-live' });
				if (last) wrap.dataset['id'] = last.id;
				this.endLiveTurn();
				this.liveStatusEl = wrap.createDiv({ cls: 'dg-live-status' });
				this.liveEl = wrap.createDiv({ cls: 'dg-msg-body' });
				this.liveText = '';
				this.liveThinking = '';
				this.liveThinkingEl = null;
				this.liveThinkingBodyEl = null;
				this.thinkingStartedAt = null;
				this.turnStartedAt = Date.now();
				// After a tool round the model is reading the result; say so instead of going blank.
				this.setLiveStatus(prev?.role === 'tool' ? `Reading the ${prev.toolName ?? 'tool'} result…` : 'Waiting for the model…');
				this.turnTimer = this.registerInterval(window.setInterval(() => this.setLiveStatus(this.liveStatusText), 1000));
				this.scrollToBottom();
				break;
			}
			case 'thinking_delta': {
				const wrap = this.liveEl?.parentElement;
				if (!wrap) break;
				if (!this.liveThinkingEl) {
					const { details, body } = this.renderThinking(wrap, 'Thinking…', '');
					wrap.insertBefore(details, this.liveEl);
					this.liveThinkingEl = details;
					this.liveThinkingBodyEl = body;
					this.thinkingStartedAt = Date.now();
				}
				this.liveThinking += ev.delta;
				this.liveThinkingBodyEl?.setText(this.liveThinking);
				this.setLiveStatus('Thinking…');
				this.scrollToBottom();
				break;
			}
			case 'text_delta':
				this.liveText += ev.delta;
				this.endThinking();
				this.clearLiveStatus();
				this.liveEl?.setText(this.liveText);
				this.scrollToBottom();
				break;
			case 'assistant_end': {
				this.endThinking();
				this.endLiveStatus();
				if (this.liveEl) {
					this.liveEl.empty();
					this.liveEl.addClass('markdown-rendered');
					const wrap = this.liveEl.parentElement;
					const stored = conv.messages.find((m) => m.id === wrap?.dataset['id']);
					if (stored?.loreCheck && wrap) {
						this.liveEl.remove();
						this.renderLoreMessage(conv, stored, wrap);
					} else if (stored?.draft && wrap) {
						// The reply drafted scene text: show the draft card now, not after the turn.
						this.liveEl.remove();
						this.renderDraftMessage(conv, stored, wrap);
					} else if (ev.content) {
						const live = this.liveEl;
						void MarkdownRenderer.render(this.app, ev.content, live, '', this).then(() => markUnresolvedLinks(this.app, live));
						// The run may go on with tool rounds; the reply is copyable as soon as it is complete.
						if (this.liveEl.parentElement) this.addCopyButton(this.liveEl.parentElement, ev.content);
					} else if (ev.toolCalls.length > 0) {
						// Tool-only round: the calls show on their result rows, so no bubble here.
						this.liveEl.parentElement?.addClass('dg-msg-step');
						this.liveEl.remove();
					}
				}
				break;
			}
			case 'warning':
				this.liveEl?.parentElement?.createDiv({ cls: 'dg-msg-warning', text: ev.message });
				new Notice(ev.message, 12000);
				break;
			case 'tool_call_start': {
				// The model is still writing the call's arguments; show the tool now.
				this.endLiveStatus();
				this.liveToolChips.push(this.toolChip(`${ev.name}…`));
				this.scrollToBottom();
				break;
			}
			case 'tool_call': {
				const chip = this.liveToolChips.shift() ?? this.toolChip('');
				chip.querySelector('.dg-chip-label')?.setText(`Running ${ev.call.name}${argsPreview(ev.call.argumentsJson)}…`);
				this.runningChip = chip;
				this.scrollToBottom();
				break;
			}
			case 'tool_result': {
				this.runningChip?.remove();
				this.runningChip = null;
				if (this.liveToolRow?.childElementCount === 0) {
					this.liveToolRow.remove();
					this.liveToolRow = null;
				}
				const stored = conv.messages[conv.messages.length - 1];
				if (stored?.role === 'tool') this.renderMessage(stored, this.messagesEl);
				this.scrollToBottom();
				break;
			}
			case 'tools_disabled':
				this.liveEl?.parentElement?.remove();
				this.liveEl = null;
				new Notice(`Model does not support tools; retrying without them. (${ev.reason})`);
				break;
			case 'error':
				if (ev.error.kind !== 'cancelled') new Notice(ev.error.userMessage(), 8000);
				if (CONNECTION_ERRORS.has(ev.error.kind)) this.setStatus('error', ev.error.userMessage());
				break;
		}
	}

	private setLiveStatus(text: string): void {
		if (!this.liveStatusEl) return;
		this.liveStatusText = text;
		const seconds = Math.round((Date.now() - this.turnStartedAt) / 1000);
		this.liveStatusEl.empty();
		const icon = this.liveStatusEl.createSpan();
		setIcon(icon, 'loader');
		this.liveStatusEl.createSpan({ text: seconds >= 2 ? `${text} ${seconds}s` : text });
	}

	/** Label the thinking block with how long the model reasoned, once its answer or turn end arrives. */
	private endThinking(): void {
		if (this.thinkingStartedAt === null) return;
		const seconds = Math.round((Date.now() - this.thinkingStartedAt) / 1000);
		this.liveThinkingEl?.querySelector('summary')?.setText(`Thought for ${seconds}s`);
		this.thinkingStartedAt = null;
	}

	private clearLiveStatus(): void {
		this.liveStatusEl?.remove();
		this.liveStatusEl = null;
	}

	/** Stop the live-turn timer and status line; the thinking block stays. */
	private endLiveStatus(): void {
		if (this.turnTimer !== null) {
			window.clearInterval(this.turnTimer);
			this.turnTimer = null;
		}
		this.clearLiveStatus();
	}

	/** End the live turn: the status line and any tool chips still waiting for a result go. */
	private endLiveTurn(): void {
		this.endLiveStatus();
		this.liveToolRow?.remove();
		this.liveToolRow = null;
		this.liveToolChips = [];
		this.runningChip = null;
	}

	/** A spinning tool chip in the row below the live reply, created on first use. */
	private toolChip(text: string): HTMLElement {
		this.liveToolRow ??= this.messagesEl.createDiv({ cls: 'dg-msg dg-msg-tool dg-tool-running' });
		const chip = this.liveToolRow.createSpan({ cls: 'dg-chip dg-chip-tool dg-chip-running' });
		setIcon(chip.createSpan({ cls: 'dg-chip-icon' }), 'loader');
		chip.createSpan({ cls: 'dg-chip-label', text });
		return chip;
	}
}

/** Error kinds that mean the provider itself is unreachable or refusing us, so the header light turns red. */
const CONNECTION_ERRORS = new Set<ProviderErrorKind>(['network', 'server', 'auth', 'rate_limit', 'model_not_found']);

/** The call a tool message answers, for showing its arguments on the result row. */
function findToolCall(conv: Conversation, toolCallId: string | undefined): ToolCall | undefined {
	if (!toolCallId) return undefined;
	for (const m of conv.messages) {
		const call = m.toolCalls?.find((c) => c.id === toolCallId);
		if (call) return call;
	}
	return undefined;
}

/** "qwen3:8b · 3,200 in / 900 out tokens over 3 requests (about 600 of them thinking)". */
function usageLine(u: TurnUsage, fallbackModel: string | undefined): string {
	const requests = u.requests > 1 ? ` over ${u.requests} requests` : '';
	const thinking = u.reasoningTokens ? ` (about ${u.reasoningTokens.toLocaleString('en-US')} of them thinking)` : '';
	const tokens = `${(u.inputTokens ?? 0).toLocaleString('en-US')} in / ${(u.outputTokens ?? 0).toLocaleString('en-US')} out tokens`;
	return `${u.model ?? fallbackModel ?? ''} · ${tokens}${requests}${thinking}`;
}

function argsPreview(json: string): string {
	try {
		const parsed = JSON.parse(json) as Record<string, unknown>;
		const path = parsed['path'] ?? parsed['query'] ?? parsed['folder'];
		if (typeof parsed['n'] === 'number') return ` (web ${parsed['n']})`;
		return typeof path === 'string' && path ? ` (${path})` : '';
	} catch {
		return '';
	}
}
