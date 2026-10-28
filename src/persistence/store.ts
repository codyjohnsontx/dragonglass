import { Conversation, ConversationIndexEntry, newConversation, sanitizeConversation } from './conversation';

/**
 * Conversation persistence. Each conversation lives in its own JSON file
 * under the plugin's data folder so one corrupt file cannot take the rest
 * down and so large histories are not rewritten on every message.
 *
 * Storage is abstracted behind `StoreBackend` (plugin-folder files in
 * Obsidian, an in-memory map in tests).
 */

export interface StoreBackend {
	read(relativePath: string): Promise<string | null>;
	write(relativePath: string, content: string): Promise<void>;
	remove(relativePath: string): Promise<void>;
	list(relativeDir: string): Promise<string[]>;
}

const DIR = 'conversations';

/** Timer functions, injectable so tests can run without a window. */
export interface Timers {
	set(fn: () => void, ms: number): number;
	clear(handle: number): void;
}

const windowTimers: Timers = {
	set: (fn, ms) => window.setTimeout(fn, ms),
	clear: (h) => window.clearTimeout(h),
};

export class ConversationStore {
	private cache = new Map<string, Conversation>();
	private index: ConversationIndexEntry[] | null = null;
	private pendingSaves = new Map<string, number>();

	constructor(
		private readonly backend: StoreBackend,
		private readonly now: () => number = () => Date.now(),
		private readonly saveDelayMs = 400,
		private readonly timers: Timers = windowTimers,
	) {}

	async listConversations(): Promise<ConversationIndexEntry[]> {
		if (this.index) return this.index;
		const files = await this.backend.list(DIR);
		const entries: ConversationIndexEntry[] = [];
		for (const file of files) {
			if (!file.endsWith('.json')) continue;
			const conv = await this.load(file.slice(DIR.length + 1, -'.json'.length));
			if (conv) entries.push({ id: conv.id, title: conv.title, updatedAt: conv.updatedAt });
		}
		entries.sort((a, b) => b.updatedAt - a.updatedAt);
		this.index = entries;
		return entries;
	}

	async load(id: string): Promise<Conversation | null> {
		const cached = this.cache.get(id);
		if (cached) return cached;
		const raw = await this.backend.read(`${DIR}/${id}.json`);
		if (raw === null) return null;
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw) as unknown;
		} catch {
			return null;
		}
		const conv = sanitizeConversation(parsed);
		if (!conv) return null;
		this.cache.set(id, conv);
		return conv;
	}

	create(): Conversation {
		const conv = newConversation(this.newId(), this.now());
		this.cache.set(conv.id, conv);
		this.touchIndex(conv);
		return conv;
	}

	/** Mark updated and schedule a debounced write. */
	touch(conv: Conversation): void {
		conv.updatedAt = this.now();
		this.touchIndex(conv);
		const existing = this.pendingSaves.get(conv.id);
		if (existing !== undefined) this.timers.clear(existing);
		this.pendingSaves.set(
			conv.id,
			this.timers.set(() => {
				this.pendingSaves.delete(conv.id);
				void this.save(conv);
			}, this.saveDelayMs),
		);
	}

	async save(conv: Conversation): Promise<void> {
		await this.backend.write(`${DIR}/${conv.id}.json`, JSON.stringify(conv));
	}

	/** Write every pending conversation immediately (plugin unload). */
	async flush(): Promise<void> {
		const ids = [...this.pendingSaves.keys()];
		for (const id of ids) {
			const t = this.pendingSaves.get(id);
			if (t !== undefined) this.timers.clear(t);
			this.pendingSaves.delete(id);
			const conv = this.cache.get(id);
			if (conv) await this.save(conv);
		}
	}

	async delete(id: string): Promise<void> {
		const t = this.pendingSaves.get(id);
		if (t !== undefined) this.timers.clear(t);
		this.pendingSaves.delete(id);
		this.cache.delete(id);
		if (this.index) this.index = this.index.filter((e) => e.id !== id);
		await this.backend.remove(`${DIR}/${id}.json`);
	}

	private touchIndex(conv: Conversation): void {
		if (!this.index) return;
		this.index = this.index.filter((e) => e.id !== conv.id);
		this.index.unshift({ id: conv.id, title: conv.title, updatedAt: conv.updatedAt });
	}

	private newId(): string {
		return `${this.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
	}
}
