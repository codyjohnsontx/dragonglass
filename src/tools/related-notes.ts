import { NoteLinks } from '../vault/port';
import { baseName } from '../vault/paths';

/**
 * Notes related to one note through the link graph and tags, each with the
 * reasons, for the `related_notes` tool. Four kinds of evidence count:
 *
 * - a direct link, in either direction;
 * - co-citation: a third note links to both;
 * - shared outgoing links: both link to the same note;
 * - shared tags (compared case-insensitively, as Obsidian does).
 *
 * Each shared neighbour (the citing note, the shared target, the tag) scores
 * 1 / ln(its degree), the Adamic-Adar weighting: a tag on two notes or a note
 * cited by two notes says much more than a tag on half the vault or an index
 * note that links to everything. A direct link scores `DIRECT_LINK` times the
 * same weight of the linking note's out-degree, per direction, so a link from
 * an index or list note counts little. The order is deterministic: score,
 * then path.
 */

export interface RelatedNote {
	path: string;
	score: number;
	/** Short reasons, strongest kind first, naming notes as [[Basename]]. */
	reasons: string[];
}

/** Score of a direct link, per direction, before damping by the linking note's out-degree. */
const DIRECT_LINK = 2;
/** Notes or tags named in one reason before "and N more". */
const NAMED_PER_REASON = 3;

interface Evidence {
	/** Weight of its link to the target, 0 if none. */
	linksTo: number;
	/** Weight of the target's link to it, 0 if none. */
	linkedFrom: number;
	/** Notes linking to both, with their weight. */
	citedBy: Map<string, number>;
	/** Notes both link to, with their weight. */
	sharedLinks: Map<string, number>;
	/** Shared tags as the target spells them, with their weight. */
	sharedTags: Map<string, number>;
}

/** The notes most related to `target`, best first, at most `limit`; `total` counts every related note. */
export function relatedNotes(graph: NoteLinks[], target: string, limit: number): { notes: RelatedNote[]; total: number } {
	const notes = new Set(graph.map((n) => n.path));
	const out = new Map<string, string[]>();
	const inbound = new Map<string, string[]>();
	const tagged = new Map<string, string[]>();
	const tagsOf = new Map<string, Map<string, string>>();
	for (const n of [...graph].sort((a, b) => cmp(a.path, b.path))) {
		const targets = [...new Set(n.outgoingLinks)].filter((p) => p !== n.path && notes.has(p)).sort(cmp);
		out.set(n.path, targets);
		for (const t of targets) push(inbound, t, n.path);
		const tags = new Map<string, string>();
		for (const tag of n.tags) if (!tags.has(tag.toLowerCase())) tags.set(tag.toLowerCase(), tag);
		tagsOf.set(n.path, tags);
		for (const key of tags.keys()) push(tagged, key, n.path);
	}

	const found = new Map<string, Evidence>();
	const evidence = (path: string): Evidence => {
		let e = found.get(path);
		if (!e) {
			e = { linksTo: 0, linkedFrom: 0, citedBy: new Map(), sharedLinks: new Map(), sharedTags: new Map() };
			found.set(path, e);
		}
		return e;
	};
	const linked = out.get(target) ?? [];
	const linking = inbound.get(target) ?? [];
	for (const p of linked) evidence(p).linkedFrom = DIRECT_LINK * weight(linked.length);
	for (const p of linking) evidence(p).linksTo = DIRECT_LINK * weight(out.get(p)?.length ?? 1);
	for (const citing of linking) {
		const cited = out.get(citing) ?? [];
		for (const p of cited) if (p !== target) evidence(p).citedBy.set(citing, weight(cited.length));
	}
	for (const shared of linked) {
		const citing = inbound.get(shared) ?? [];
		for (const p of citing) if (p !== target) evidence(p).sharedLinks.set(shared, weight(citing.length));
	}
	for (const [key, spelled] of tagsOf.get(target) ?? []) {
		const withTag = tagged.get(key) ?? [];
		for (const p of withTag) if (p !== target) evidence(p).sharedTags.set(spelled, weight(withTag.length));
	}

	const ranked = [...found]
		.map(([path, e]) => ({ path, score: score(e), reasons: reasons(e, target) }))
		.sort((a, b) => b.score - a.score || cmp(a.path, b.path));
	return { notes: ranked.slice(0, Math.max(0, limit)), total: ranked.length };
}

/** Adamic-Adar weight of a neighbour with `degree` connections, counted as at least 2. */
function weight(degree: number): number {
	return 1 / Math.log(Math.max(2, degree));
}

function score(e: Evidence): number {
	let s = e.linksTo + e.linkedFrom;
	for (const w of [...e.citedBy.values(), ...e.sharedLinks.values(), ...e.sharedTags.values()]) s += w;
	// Rounded so equal evidence reached in a different order ties exactly and falls back to the path.
	return Math.round(s * 1e9) / 1e9;
}

function reasons(e: Evidence, target: string): string[] {
	const t = link(target);
	const out: string[] = [];
	if (e.linksTo > 0 && e.linkedFrom > 0) out.push(`links both ways with ${t}`);
	else if (e.linkedFrom > 0) out.push(`${t} links to it`);
	else if (e.linksTo > 0) out.push(`links to ${t}`);
	if (e.citedBy.size > 0) {
		const from = named(e.citedBy, link);
		out.push(e.citedBy.size === 1 ? `linked together with ${t} from ${from}` : `linked together with ${t} from ${e.citedBy.size} notes: ${from}`);
	}
	if (e.sharedLinks.size > 0) out.push(`both link to ${named(e.sharedLinks, link)}`);
	if (e.sharedTags.size > 0) out.push(`shares ${named(e.sharedTags, (tag) => tag)}`);
	return out;
}

/** The strongest few, rarest first, then "and N more". */
function named(weights: Map<string, number>, show: (key: string) => string): string {
	const keys = [...weights].sort((a, b) => b[1] - a[1] || cmp(a[0], b[0])).map(([k]) => k);
	const shown = keys.slice(0, NAMED_PER_REASON).map(show).join(', ');
	return keys.length > NAMED_PER_REASON ? `${shown} and ${keys.length - NAMED_PER_REASON} more` : shown;
}

function link(path: string): string {
	return `[[${baseName(path)}]]`;
}

function push(map: Map<string, string[]>, key: string, value: string): void {
	const list = map.get(key);
	if (list) list.push(value);
	else map.set(key, [value]);
}

/** Code-unit order, so the result does not depend on the locale. */
function cmp(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}
