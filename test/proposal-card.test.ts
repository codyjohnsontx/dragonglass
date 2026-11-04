import { describe, expect, it } from 'vitest';
import { moveLinksText } from '../src/ui/proposal-card';
import { ChangeProposal } from '../src/vault/proposals';

function move(status: ChangeProposal['status'], linkUpdates: string[], newPath = 'Lore/Ember Gate.md'): ChangeProposal {
	return { id: 'p', conversationId: 'c', kind: 'move', path: 'Lore/Ashen Gate.md', newPath, before: '', after: '', baseHash: null, summary: 's', status, createdAt: 1, linkUpdates };
}

describe('moveLinksText', () => {
	const links = ['Act One.md', 'Act Two.md'];

	it.each(['pending', 'stale'] as const)('says what Obsidian will do while the move is %s', (status) => {
		expect(moveLinksText(move(status, links))).toBe('Obsidian will update the links to it in 2 notes, and asks first if "Automatically update internal links" is off:');
	});

	it('says what Obsidian did once the move is applied', () => {
		expect(moveLinksText(move('applied', links))).toBe('Obsidian updated the links to it in 2 notes, unless you chose not to when it asked:');
	});

	it.each(['rejected', 'reverted', 'failed'] as const)('makes no claim about links once the move is %s', (status) => {
		expect(moveLinksText(move(status, links))).toBeNull();
	});

	it.each(['pending', 'stale', 'applied', 'rejected', 'reverted', 'failed'] as const)('says no links are involved when none are, while %s', (status) => {
		expect(moveLinksText(move(status, []))).toBe('No other notes link to it.');
		expect(moveLinksText(move(status, [], 'Places/Ashen Gate.md'))).toBe('No links need to change.');
	});
});
