/** Untrusted text must not be able to close or open a delimiter of its own. */
export function defuse(text: string): string {
	return text.replace(/<<</g, '‹‹‹').replace(/>>>/g, '›››');
}

/** Untrusted text as a delimiter attribute: defused, on one line, without a double quote to end the value. */
export function attr(text: string): string {
	return defuse(text).replace(/"/g, '\'').replace(/[\r\n]+/g, ' ');
}
