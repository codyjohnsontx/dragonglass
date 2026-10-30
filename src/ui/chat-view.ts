import { ItemView, MarkdownRenderer, Notice, setIcon, TAbstractFile, TFile, WorkspaceLeaf } from 'obsidian';
import { ContextItem } from '../agent/context';
import { RunEvent } from '../agent/runtime';
import { DragonglassCore } from '../core';
import { Conversation, StoredMessage, TurnUsage, usageByTurn } from '../persistence/conversation';
import { modelChoices, ModelMenu, withConfiguredModel } from '../providers/model-choices';
import { ModelInfo, PROVIDER_IDS, ProviderErrorKind, ProviderId, ToolCall } from '../providers/types';
import { ActiveContext } from '../vault/port';
import { baseName } from '../vault/paths';
import { ConfirmModal } from './confirm-modal';
import { renderProposalCard } from './proposal-card';
import { NotePickerModal } from './note-picker';
import { copyToClipboard, CopyAnnouncer } from './copy';

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
		for (const m of this.conv.messages) this.renderMessage(m, el, usage.get(m.id));
		this.renderUsage(el);
		this.scrollToBottom();
	}

	/**
	 * Render one stored message. A tool call is shown on the row of its result
	 * (the chip in the summary), so an assistant turn that only called tools
	 * renders as a bare step: its thinking, if any, and nothing else.
	 */
	private renderMessage(m: StoredMessage, parent: HTMLElement, turnUsage?: TurnUsage): HTMLElement {
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
			const toolOnly = !m.content && !m.error && !m.interrupted && (m.toolCalls?.length ?? 0) > 0;
			if (toolOnly) wrap.addClass('dg-msg-step');
			if (m.thinking) this.renderThinking(wrap, 'Thinking', m.thinking);
			if (m.content) {
				const body = wrap.createDiv({ cls: 'dg-msg-body markdown-rendered' });
				void MarkdownRenderer.render(this.app, m.content, body, '', this);
				this.addCopyButton(wrap, m.content);
			}
			// A call whose result never arrived (the run died first) has no result row to live on.
			const unanswered = (m.toolCalls ?? []).filter((c) => !this.conv?.messages.some((t) => t.role === 'tool' && t.toolCallId === c.id));
			if (unanswered.length > 0) {
				const calls = wrap.createDiv({ cls: 'dg-tool-calls' });
				for (const c of unanswered) calls.createSpan({ cls: 'dg-chip dg-chip-tool', text: `${c.name}${argsPreview(c.argumentsJson)} (not run)` });
			}
			if (m.interrupted) wrap.createDiv({ cls: 'dg-msg-note', text: 'Stopped.' });
			for (const w of m.warnings ?? []) wrap.createDiv({ cls: 'dg-msg-warning', text: w });
			if (m.error) wrap.createDiv({ cls: 'dg-msg-error', text: m.error });
			if (turnUsage) wrap.createDiv({ cls: 'dg-msg-usage', text: usageLine(turnUsage, m.model) });
			if (wrap.childElementCount === 0) wrap.addClass('dg-msg-hidden');
		} else {
			const details = wrap.createEl('details', { cls: `dg-tool-result${m.isError ? ' dg-tool-error' : ''}` });
			const summary = details.createEl('summary');
			const call = this.conv ? findToolCall(this.conv, m.toolCallId) : undefined;
			const label = `${m.toolName ?? 'tool'}${call ? argsPreview(call.argumentsJson) : ''}`;
			summary.createSpan({ cls: 'dg-chip dg-chip-tool', text: label, attr: { title: label } });
			summary.appendText(m.isError ? ' error' : ' result');
			details.createEl('pre', { text: m.content.length > 4000 ? `${m.content.slice(0, 4000)}…` : m.content });
			if (m.proposalId && this.conv) {
				const proposal = this.conv.proposals[m.proposalId];
				if (proposal) {
					const card = wrap.createDiv();
					card.dataset['proposalId'] = proposal.id;
					renderProposalCard(this.app, this.core, this.conv, proposal, card, () => this.renderMessages());
				}
			}
		}
		return wrap;
	}

	/** Re-check proposals for an edited note and redraw their cards in place, without disturbing a live turn. */
	private async onNoteModified(file: TAbstractFile): Promise<void> {
		const conv = this.conv;
		if (!conv || !(file instanceof TFile)) return;
		const changed = await this.core.refreshProposals(conv, file.path);
		if (this.conv !== conv) return;
		for (const p of changed) {
			const card = this.messagesEl.querySelector<HTMLElement>(`[data-proposal-id="${p.id}"]`);
			if (card) renderProposalCard(this.app, this.core, conv, p, card, () => this.renderMessages());
		}
	}

	/**
	 * A visible Copy button under a reply. It puts the reply's Markdown on the
	 * clipboard and reads "Copied" for a moment so a click is seen to work.
	 */
	private addCopyButton(wrap: HTMLElement, text: string): void {
		const row = wrap.createDiv({ cls: 'dg-msg-actions' });
		const btn = row.createEl('button', { cls: 'dg-copy-btn', attr: { 'aria-label': 'Copy reply to clipboard' } });
		const icon = btn.createSpan();
		const label = btn.createSpan();
		const show = (name: string, caption: string): void => {
			setIcon(icon, name);
			label.setText(caption);
		};
		show('copy', 'Copy');
		let revert: number | null = null;
		btn.addEventListener('click', () => {
			const attempt = this.copyAnnouncer.begin();
			void copyToClipboard(text, activeWindow.navigator.clipboard).then((ok) => {
				if (!ok) return;
				btn.addClass('is-copied');
				show('check', 'Copied');
				this.copyStatusEl.empty();
				this.copyAnnouncer.announce(attempt, 100, () => this.copyStatusEl.setText('Copied to clipboard.'));
				if (revert !== null) window.clearTimeout(revert);
				revert = window.setTimeout(() => {
					btn.removeClass('is-copied');
					show('copy', 'Copy');
					revert = null;
				}, 1500);
			});
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
				text: 'Highlighted context and your message are sent to the cloud provider you configured.',
			});
		}
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
		this.inputEl = c.createEl('textarea', {
			cls: 'dg-input',
			attr: { placeholder: 'Message Dragonglass… (Enter to send, Shift+Enter for newline)', rows: '3' },
		});
		this.inputEl.addEventListener('keydown', (e) => {
			if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
				e.preventDefault();
				void this.submit();
			}
		});
		const row = c.createDiv({ cls: 'dg-composer-row' });
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
		this.abort = new AbortController();
		this.sendBtn.setText('Stop');
		this.sendBtn.removeClass('mod-cta');
		this.sendBtn.addClass('mod-warning');
		// The header light reflects the last check; a send is the moment it matters,
		// and it must finish first so a failure during the send is not painted over.
		await this.refreshStatus(true, this.abort.signal);
		if (this.messagesEl.querySelector('.dg-empty')) this.messagesEl.empty();
		try {
			await this.core.send(conv, {
				text,
				context,
				signal: this.abort.signal,
				onEvent: (ev) => this.onRunEvent(conv, ev),
			});
		} finally {
			this.abort = null;
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
					if (ev.content) {
						void MarkdownRenderer.render(this.app, ev.content, this.liveEl, '', this);
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
		return typeof path === 'string' && path ? ` (${path})` : '';
	} catch {
		return '';
	}
}
