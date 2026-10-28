import { ToolCall, Usage } from '../providers/types';
import { ChangeProposal } from '../vault/proposals';

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
	usage?: Usage;
	/** Reasoning a thinking model streamed before the answer. Shown collapsed, never replayed. */
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
	const messages = (c['messages'] as unknown[]).filter(isStoredMessage);
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

function isProposal(v: unknown): v is ChangeProposal {
	if (!v || typeof v !== 'object') return false;
	const p = v as Record<string, unknown>;
	return (
		typeof p['id'] === 'string' &&
		typeof p['path'] === 'string' &&
		typeof p['after'] === 'string' &&
		(p['kind'] === 'create' || p['kind'] === 'edit') &&
		typeof p['status'] === 'string'
	);
}
