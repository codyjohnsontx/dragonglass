import { ItemView, MarkdownRenderer, Notice, setIcon, TFile, WorkspaceLeaf } from 'obsidian';
import { ContextItem } from '../agent/context';
import { RunEvent } from '../agent/runtime';
import { DragonglassCore } from '../core';
import { Conversation, StoredMessage } from '../persistence/conversation';
import { countModels, ModelInfo, PROVIDER_IDS, ProviderId } from '../providers/types';
import { renderProposalCard } from './proposal-card';
import { NotePickerModal } from './note-picker';

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
	private models: ModelInfo[] = [];

	private headerEl!: HTMLElement;
	private messagesEl!: HTMLElement;
	private contextBarEl!: HTMLElement;
	private composerEl!: HTMLElement;
	private inputEl!: HTMLTextAreaElement;
	private sendBtn!: HTMLButtonElement;
	private statusEl!: HTMLElement;
	private liveEl: HTMLElement | null = null;
	private liveText = '';
	private lastStatus: { state: 'ok' | 'error' | 'checking'; title: string } | null = null;

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
		this.contextBarEl = root.createDiv({ cls: 'dg-context-bar' });
		this.composerEl = root.createDiv({ cls: 'dg-composer' });
		this.buildComposer();
		await this.openConversation(this.core.getSettings().lastConversationId);
		this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.renderContextBar()));
		this.registerEvent(this.app.workspace.on('file-open', () => this.renderContextBar()));
		// Closing the tracked note's tab or popout fires neither event above.
		this.registerEvent(this.app.workspace.on('layout-change', () => this.renderContextBar()));
		await this.renderHeader();
		void this.refreshStatus();
	}

	async onClose(): Promise<void> {
		this.abort?.abort();
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
		const ids = new Set(this.models.map((m) => m.id));
		if (current && !ids.has(current)) modelSelect.createEl('option', { text: current, value: current });
		if (!current && this.models.length === 0) modelSelect.createEl('option', { text: 'No model selected', value: '' });
		for (const m of this.models) modelSelect.createEl('option', { text: m.label ?? m.id, value: m.id });
		modelSelect.value = current;
		modelSelect.addEventListener('change', () => void this.core.setActiveModel(modelSelect.value));
		this.iconButton(modelRow, 'refresh-cw', 'Refresh model list', () => void this.loadModels());
		this.statusEl = modelRow.createSpan({ cls: 'dg-status', text: '' });
		if (this.lastStatus) this.setStatus(this.lastStatus.state, this.lastStatus.title);
	}

	private async switchProvider(id: ProviderId): Promise<void> {
		await this.core.setActiveProvider(id);
		this.models = [];
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

	private async refreshStatus(): Promise<void> {
		this.setStatus('checking', 'Checking connection…');
		const status = await this.core.checkConnection();
		if (status.ok) {
			this.setStatus('ok', status.detail);
			if (this.models.length === 0) await this.loadModels(true);
		} else {
			this.setStatus('error', status.error.userMessage());
		}
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

	private async loadModels(quiet = false): Promise<void> {
		try {
			this.models = await this.core.listModels();
			if (!this.core.activeModel() && this.models[0]) await this.core.setActiveModel(this.models[0].id);
			await this.renderHeader();
			this.setStatus('ok', `${countModels(this.models.length)} available`);
		} catch (e) {
			if (!quiet) new Notice(e instanceof Error ? e.message : String(e));
		}
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

	private async deleteConversation(): Promise<void> {
		if (!this.conv) return;
		this.abort?.abort();
		await this.core.store.delete(this.conv.id);
		this.conv = null;
		await this.openConversation(null);
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
		for (const m of this.conv.messages) this.renderMessage(m, el);
		this.renderUsage(el);
		this.scrollToBottom();
	}

	private renderMessage(m: StoredMessage, parent: HTMLElement): HTMLElement {
		const wrap = parent.createDiv({ cls: `dg-msg dg-msg-${m.role}` });
		if (m.role === 'user') {
			wrap.createDiv({ cls: 'dg-msg-body', text: m.content });
			if (m.context && (m.context.activeNotePath || m.context.selection || m.context.attachments.length)) {
				const ctx = wrap.createDiv({ cls: 'dg-msg-context' });
				if (m.context.activeNotePath) ctx.createSpan({ cls: 'dg-chip', text: `Active: ${m.context.activeNotePath}` });
				if (m.context.selection) ctx.createSpan({ cls: 'dg-chip', text: 'Selection' });
				for (const a of m.context.attachments) ctx.createSpan({ cls: 'dg-chip', text: a.path });
			}
		} else if (m.role === 'assistant') {
			const body = wrap.createDiv({ cls: 'dg-msg-body markdown-rendered' });
			if (m.content) void MarkdownRenderer.render(this.app, m.content, body, '', this);
			if (m.toolCalls?.length) {
				const calls = wrap.createDiv({ cls: 'dg-tool-calls' });
				for (const c of m.toolCalls) {
					calls.createSpan({ cls: 'dg-chip dg-chip-tool', text: `${c.name}${argsPreview(c.argumentsJson)}` });
				}
			}
			if (m.interrupted) wrap.createDiv({ cls: 'dg-msg-note', text: 'Stopped.' });
			if (m.error) wrap.createDiv({ cls: 'dg-msg-error', text: m.error });
			if (m.usage && this.core.getSettings().showUsage && (m.usage.inputTokens || m.usage.outputTokens)) {
				wrap.createDiv({
					cls: 'dg-msg-usage',
					text: `${m.model ?? ''} · ${m.usage.inputTokens ?? 0} in / ${m.usage.outputTokens ?? 0} out tokens`,
				});
			}
		} else {
			const details = wrap.createEl('details', { cls: `dg-tool-result${m.isError ? ' dg-tool-error' : ''}` });
			details.createEl('summary', { text: `${m.isError ? 'Tool error' : 'Tool result'}: ${m.toolName ?? 'tool'}` });
			details.createEl('pre', { text: m.content.length > 4000 ? `${m.content.slice(0, 4000)}…` : m.content });
			if (m.proposalId && this.conv) {
				const proposal = this.conv.proposals[m.proposalId];
				if (proposal) {
					const card = wrap.createDiv();
					renderProposalCard(this.app, this.core, this.conv, proposal, card, () => this.renderMessages());
				}
			}
		}
		return wrap;
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
			const selToggle = bar.createEl('button', {
				cls: `dg-chip dg-chip-toggle${this.includeSelection ? ' is-active' : ''}`,
				text: `Selection (${active.selection.length} chars)`,
			});
			selToggle.addEventListener('click', () => {
				this.includeSelection = !this.includeSelection;
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

	private async collectContext(): Promise<ContextItem[]> {
		const items: ContextItem[] = [];
		const active = this.core.vault.getActiveContext();
		if (this.includeActive && active.path) {
			const content = await this.core.vault.readNote(active.path);
			if (content !== null) items.push({ kind: 'active', label: 'Active note', path: active.path, content });
		}
		if (this.includeSelection && active.selection) {
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
		this.abort = new AbortController();
		this.sendBtn.setText('Stop');
		this.sendBtn.removeClass('mod-cta');
		this.sendBtn.addClass('mod-warning');
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
				}
				const wrap = this.messagesEl.createDiv({ cls: 'dg-msg dg-msg-assistant dg-msg-live' });
				if (last) wrap.dataset['id'] = last.id;
				this.liveEl = wrap.createDiv({ cls: 'dg-msg-body' });
				this.liveEl.setText('…');
				this.liveText = '';
				this.scrollToBottom();
				break;
			}
			case 'text_delta':
				this.liveText += ev.delta;
				this.liveEl?.setText(this.liveText);
				this.scrollToBottom();
				break;
			case 'assistant_end':
				if (this.liveEl) {
					this.liveEl.empty();
					this.liveEl.addClass('markdown-rendered');
					if (ev.content) void MarkdownRenderer.render(this.app, ev.content, this.liveEl, '', this);
				}
				break;
			case 'tool_call': {
				const el = this.messagesEl.createDiv({ cls: 'dg-msg dg-msg-tool dg-tool-running' });
				el.createSpan({ cls: 'dg-chip dg-chip-tool', text: `Running ${ev.call.name}${argsPreview(ev.call.argumentsJson)}…` });
				this.scrollToBottom();
				break;
			}
			case 'tool_result': {
				this.messagesEl.querySelector('.dg-tool-running')?.remove();
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
				break;
		}
	}
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
