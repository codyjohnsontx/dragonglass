import { ToolCall, Usage } from '../providers/types';
import type { DraftRecord } from '../agent/drafting';
import type { LoreCheckRecord, LoreIssue } from '../agent/lore-check';
import type { Source } from '../agent/sources';
import { ChangeProposal, PROPOSAL_KINDS } from '../vault/proposals';

/**
 * Conversation model persisted locally. Messages carry everything the UI
 * needs to re-render (tool calls, results, proposals, usage) and everything
 * the runtime needs to rebuild provider messages.
 */

export interface AttachedNote {
	path: string;
}

export interface ContextSnapshot {
	activeNotePath: string | null;
	selection: string | null;
	attachments: AttachedNote[];
}

export interface StoredMessage {
	id: string;
	role: 'user' | 'assistant' | 'tool';
	content: string;
	createdAt: number;
	/** Context that was sent alongside a user message (for transparency). */
	context?: ContextSnapshot;
	toolCalls?: ToolCall[];
	toolCallId?: string;
	toolName?: string;
	isError?: boolean;
	proposalId?: string;
	/**
	 * On an answer that drew on the web: the research note "Save to vault"
	 * proposed for it, reviewed under the answer. Not a tool proposal, so it
	 * is not part of the turn's batch review.
	 */
	researchProposalId?: string;
	/**
	 * On a reply that drafted scene text: the draft, its thread and the insert
	 * proposals made from it. A draft message is shown as a draft card, not a
	 * plain reply; `content` still holds the whole reply for the model.
	 */
	draft?: DraftRecord;
	/**
	 * On the reply that ends a lore check: the issues it found, with the
	 * proposals made from them. Shown as a list of issues, not a plain reply;
	 * `content` still holds the whole reply for the model.
	 */
	loreCheck?: LoreCheckRecord;
	/**
	 * What the message showed the model, for the answer's sources list: for a
	 * tool result the notes and web pages it returned, for a user message the
	 * notes sent as context. Absent on user messages saved before sources were
	 * recorded; their turns get no list.
	 */
	sources?: Source[];
	usage?: Usage;
	/** Reasoning a thinking model streamed before the answer. Shown collapsed; not replayed in later turns. */
	thinking?: string;
	/** Provider warnings for this turn, for example a prompt cut to fit the context window. */
	warnings?: string[];
	/** Provider + model that produced an assistant message. */
	provider?: string;
	model?: string;
	/** Set when the assistant turn ended abnormally. */
	error?: string;
	/** True when the message was cut off by Stop. */
	interrupted?: boolean;
}

export interface Conversation {
	id: string;
	title: string;
	createdAt: number;
	updatedAt: number;
	messages: StoredMessage[];
	proposals: Record<string, ChangeProposal>;
}

export interface ConversationIndexEntry {
	id: string;
	title: string;
	updatedAt: number;
}

export function newConversation(id: string, now: number): Conversation {
	return { id, title: 'New conversation', createdAt: now, updatedAt: now, messages: [], proposals: {} };
}

/** Token usage of one user turn: every model request it took, added up. */
export interface TurnUsage extends Usage {
	/** Model requests in the turn: one plus one per tool round. */
	requests: number;
	model?: string;
}

/**
 * Sum usage per user turn (a user message and everything up to the next one)
 * and key it by the assistant message that should show it: the last one in
 * the turn, so a reply reached through tool rounds shows one line, not one
 * per round. Turns without a reported count are left out.
 */
export function usageByTurn(messages: StoredMessage[]): Map<string, TurnUsage> {
	const out = new Map<string, TurnUsage>();
	let turn: TurnUsage | null = null;
	let lastAssistantId: string | null = null;
	const close = () => {
		if (turn && lastAssistantId && (turn.inputTokens || turn.outputTokens)) out.set(lastAssistantId, turn);
		turn = null;
		lastAssistantId = null;
	};
	for (const m of messages) {
		if (m.role === 'user') close();
		if (m.role !== 'assistant') continue;
		turn ??= { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, requests: 0 };
		turn.requests++;
		turn.inputTokens = (turn.inputTokens ?? 0) + (m.usage?.inputTokens ?? 0);
		turn.outputTokens = (turn.outputTokens ?? 0) + (m.usage?.outputTokens ?? 0);
		turn.reasoningTokens = (turn.reasoningTokens ?? 0) + (m.usage?.reasoningTokens ?? 0);
		if (m.model) turn.model = m.model;
		lastAssistantId = m.id;
	}
	close();
	return out;
}

/** The proposals one user turn produced, in the order they were made. */
export interface ProposalTurn {
	/** Id of the user message that began the turn; empty for proposals before any user message. */
	turnId: string;
	proposals: ChangeProposal[];
	/** Id of the tool message carrying the turn's last proposal, where the review renders. */
	anchorMessageId: string;
}

/**
 * Group proposals by user turn (a user message and everything up to the next
 * one). A turn with two or more is reviewed as one batch. The grouping is
 * derived from the messages here, not stored, so conversations saved before
 * batches existed group the same way when reopened.
 */
export function proposalTurns(conv: Conversation): ProposalTurn[] {
	const out: ProposalTurn[] = [];
	let turnId = '';
	let current: ProposalTurn | null = null;
	for (const m of conv.messages) {
		if (m.role === 'user') {
			turnId = m.id;
			current = null;
			continue;
		}
		if (m.role !== 'tool' || !m.proposalId) continue;
		const proposal = conv.proposals[m.proposalId];
		if (!proposal) continue;
		if (!current) {
			current = { turnId, proposals: [], anchorMessageId: m.id };
			out.push(current);
		}
		current.proposals.push(proposal);
		current.anchorMessageId = m.id;
	}
	return out;
}

export function deriveTitle(firstUserMessage: string): string {
	const line = firstUserMessage.split('\n').find((l) => l.trim().length > 0) ?? 'New conversation';
	const trimmed = line.trim().replace(/\s+/g, ' ');
	return trimmed.length > 60 ? `${trimmed.slice(0, 57)}…` : trimmed;
}

/** Runtime validation for data read from disk. Drops anything malformed. */
export function sanitizeConversation(raw: unknown): Conversation | null {
	if (!raw || typeof raw !== 'object') return null;
	const c = raw as Record<string, unknown>;
	if (typeof c['id'] !== 'string' || !Array.isArray(c['messages'])) return null;
	const messages = (c['messages'] as unknown[]).filter(isStoredMessage).map(sanitizeDraft).map(sanitizeLoreCheck);
	const proposalsRaw = c['proposals'];
	const proposals: Record<string, ChangeProposal> = {};
	if (proposalsRaw && typeof proposalsRaw === 'object') {
		for (const [k, v] of Object.entries(proposalsRaw as Record<string, unknown>)) {
			if (isProposal(v)) proposals[k] = v;
		}
	}
	return {
		id: c['id'],
		title: typeof c['title'] === 'string' ? c['title'] : 'Conversation',
		createdAt: typeof c['createdAt'] === 'number' ? c['createdAt'] : 0,
		updatedAt: typeof c['updatedAt'] === 'number' ? c['updatedAt'] : 0,
		messages,
		proposals,
	};
}

function isStoredMessage(v: unknown): v is StoredMessage {
	if (!v || typeof v !== 'object') return false;
	const m = v as Record<string, unknown>;
	return (
		typeof m['id'] === 'string' &&
		(m['role'] === 'user' || m['role'] === 'assistant' || m['role'] === 'tool') &&
		typeof m['content'] === 'string'
	);
}

/** Drop a malformed draft record; the message then renders as a plain reply. */
function sanitizeDraft(m: StoredMessage): StoredMessage {
	const d = m.draft as unknown;
	if (d === undefined) return m;
	if (!d || typeof d !== 'object') return { ...m, draft: undefined };
	const r = d as Record<string, unknown>;
	if (typeof r['thread'] !== 'string' || typeof r['text'] !== 'string') return { ...m, draft: undefined };
	const inserts = Array.isArray(r['inserts']) ? r['inserts'].filter((id): id is string => typeof id === 'string') : undefined;
	return { ...m, draft: { thread: r['thread'], text: r['text'], ...(inserts?.length ? { inserts } : {}) } };
}

/** Drop a malformed lore check, or a malformed issue in one; the message then renders as a plain reply. */
function sanitizeLoreCheck(m: StoredMessage): StoredMessage {
	const c = m.loreCheck as unknown;
	if (c === undefined) return m;
	if (!c || typeof c !== 'object') return { ...m, loreCheck: undefined };
	const r = c as Record<string, unknown>;
	if (typeof r['scriptPath'] !== 'string' || !Array.isArray(r['issues'])) return { ...m, loreCheck: undefined };
	const shown = shownRecord(r['shown']);
	const canonShown = shownRecord(r['canonShown']);
	return {
		...m,
		loreCheck: {
			scriptPath: r['scriptPath'],
			issues: r['issues'].filter(isLoreIssue),
			...(r['readNoLore'] === true ? { readNoLore: true as const } : {}),
			...(typeof r['leftOut'] === 'number' ? { leftOut: r['leftOut'] } : {}),
			...(shown ? { shown } : {}),
			...(canonShown ? { canonShown } : {}),
		},
	};
}

function shownRecord(v: unknown): { chars: number; of: number } | null {
	const s = v as Record<string, unknown> | undefined;
	return typeof s?.['chars'] === 'number' && typeof s['of'] === 'number' ? { chars: s['chars'], of: s['of'] } : null;
}

function isLoreIssue(v: unknown): v is LoreIssue {
	if (!v || typeof v !== 'object') return false;
	const i = v as Record<string, unknown>;
	return ['id', 'line', 'says', 'note', 'notePath'].every((k) => typeof i[k] === 'string') && (i['fix'] === undefined || typeof i['fix'] === 'string') && (i['proposalId'] === undefined || typeof i['proposalId'] === 'string');
}

function isProposal(v: unknown): v is ChangeProposal {
	if (!v || typeof v !== 'object') return false;
	const p = v as Record<string, unknown>;
	return (
		typeof p['id'] === 'string' &&
		typeof p['path'] === 'string' &&
		typeof p['after'] === 'string' &&
		PROPOSAL_KINDS.includes(p['kind'] as ChangeProposal['kind']) &&
		typeof p['status'] === 'string'
	);
}
