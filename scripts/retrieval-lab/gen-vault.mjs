#!/usr/bin/env node
/**
 * Synthetic but realistic Obsidian vault generator for retrieval benchmarks.
 *
 *   node scripts/retrieval-lab/gen-vault.mjs <outdir> <noteCount> [seed]
 *
 * Writes <outdir>/vault/** (Markdown notes with frontmatter, wikilinks that
 * form a hub-and-cluster graph, daily notes, meetings, people, projects,
 * reading, reference and inbox notes) and <outdir>/questions.json: questions
 * with the vault path(s) that hold the answer, in four kinds:
 *   keyword     the question reuses the words of the planted fact
 *   paraphrase  the question says the same thing in other words
 *   unnamed     like paraphrase, but the host note is described, not named
 *   multihop    the host note is reached through a person or hub note
 */
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';

const outdir = process.argv[2];
const N = Number(process.argv[3] ?? 500);
const seed = Number(process.argv[4] ?? 7);
if (!outdir || !Number.isFinite(N)) {
	console.error('usage: gen-vault.mjs <outdir> <noteCount> [seed]');
	process.exit(1);
}

// ---------- deterministic randomness ----------
let s = seed >>> 0 || 1;
function rnd() {
	s += 0x6d2b79f5;
	let t = s;
	t = Math.imul(t ^ (t >>> 15), t | 1);
	t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
	return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const ri = (n) => Math.floor(rnd() * n);
const pick = (a) => a[ri(a.length)];
const chance = (p) => rnd() < p;
function shuffle(a) {
	const b = a.slice();
	for (let i = b.length - 1; i > 0; i--) {
		const j = ri(i + 1);
		[b[i], b[j]] = [b[j], b[i]];
	}
	return b;
}
function sample(a, k) {
	return shuffle(a).slice(0, Math.min(k, a.length));
}

// ---------- domains: vocabulary clusters ----------
const DOMAINS = [
	{ name: 'woodworking', tag: 'workshop', nouns: ['dovetail', 'chisel', 'walnut board', 'table saw', 'jointer', 'mortise', 'tenon', 'finish', 'sandpaper grit', 'glue-up', 'clamp', 'bandsaw', 'veneer', 'router bit'], sentences: ['Cut the dovetails before gluing the carcass so the joints stay square.', 'The walnut boards need another pass on the jointer before glue-up.', 'A sharp chisel leaves a cleaner mortise than any router bit.', 'Sanded to 220 grit and wiped on a coat of oil finish.', 'The bandsaw blade drifts to the left; adjust the fence or replace the blade.', 'Dry-fit every tenon before the glue comes out.'] },
	{ name: 'kubernetes', tag: 'infra', nouns: ['pod', 'deployment', 'ingress', 'node pool', 'helm chart', 'namespace', 'config map', 'secret', 'rollout', 'autoscaler', 'service mesh', 'container image', 'liveness probe', 'persistent volume'], sentences: ['The deployment rolled back because the liveness probe failed on the new image.', 'Scale the node pool before the autoscaler hits its ceiling during peak traffic.', 'Helm values override the config map; keep the secrets in the vault instead.', 'The ingress controller needs the TLS certificate renewed every ninety days.', 'A pod stuck in CrashLoopBackOff usually means a missing environment variable.', 'Persistent volumes are not moved when a node is drained.'] },
	{ name: 'gardening', tag: 'garden', nouns: ['raised bed', 'compost', 'tomato seedling', 'drip line', 'mulch', 'trellis', 'soil pH', 'frost date', 'pruning', 'pollinator', 'cover crop', 'seed tray', 'irrigation timer', 'perennial'], sentences: ['Transplant the tomato seedlings after the last frost date for the area.', 'The raised beds drain faster, so the drip line runs twice a day in July.', 'Compost turned every two weeks breaks down before spring planting.', 'Mulch around the perennials keeps the soil cool and the weeds down.', 'The trellis needs taller stakes once the cucumbers start climbing.', 'Soil pH tested at 6.4, fine for most vegetables.'] },
	{ name: 'running', tag: 'fitness', nouns: ['tempo run', 'long run', 'cadence', 'heart rate zone', 'taper', 'interval', 'marathon', 'shoe rotation', 'recovery week', 'threshold pace', 'hill repeats', 'race day', 'split', 'warm-up'], sentences: ['Keep the long run in zone two and save the tempo effort for Thursday.', 'The taper starts three weeks out; cut mileage, not intensity.', 'Hill repeats build strength without the pounding of track intervals.', 'Rotate shoes so the foam recovers between runs.', 'Negative splits on race day mean the first half felt too easy.', 'A recovery week every fourth week keeps the legs fresh.'] },
	{ name: 'photography', tag: 'photo', nouns: ['aperture', 'shutter speed', 'ISO', 'prime lens', 'raw file', 'white balance', 'tripod', 'golden hour', 'histogram', 'focal length', 'bokeh', 'exposure compensation', 'lightroom catalog', 'print'], sentences: ['Shoot raw and fix the white balance later; the histogram tells the truth.', 'At golden hour the prime lens wide open gives the softest bokeh.', 'A tripod and a slow shutter speed smooth the water in the stream shots.', 'Keep ISO under 1600 on this body or the shadows fall apart.', 'The Lightroom catalog needs a backup before the next import.', 'Dial in minus one stop of exposure compensation for snow scenes.'] },
	{ name: 'cooking', tag: 'kitchen', nouns: ['sourdough starter', 'braise', 'cast iron', 'mise en place', 'stock', 'roux', 'sear', 'oven temperature', 'proof', 'marinade', 'knife', 'emulsion', 'deglaze', 'brine'], sentences: ['Feed the sourdough starter the night before so it doubles by morning.', 'Sear the meat in cast iron, then deglaze with stock for the braise.', 'A roux cooked to blond thickens without tasting of flour.', 'Brine the chicken for four hours and pat it dry before roasting.', 'Mise en place first; the stir fry moves too fast to chop mid-way.', 'The oven runs hot by fifteen degrees, so set it lower than the recipe says.'] },
	{ name: 'personal finance', tag: 'money', nouns: ['index fund', 'emergency fund', 'expense ratio', 'tax-advantaged account', 'rebalance', 'net worth', 'cash flow', 'mortgage rate', 'dividend', 'budget category', 'brokerage', 'contribution limit', 'insurance premium', 'refinance'], sentences: ['Rebalance once a year; the index funds drift toward equities otherwise.', 'The emergency fund covers six months of expenses in a high-yield account.', 'Max the tax-advantaged accounts before adding to the brokerage.', 'Expense ratios above half a percent eat the dividend over twenty years.', 'Track cash flow by budget category, not by account.', 'Refinance only if the mortgage rate drops a full point.'] },
	{ name: 'guitar', tag: 'music', nouns: ['chord progression', 'fretboard', 'capo', 'pentatonic scale', 'strumming pattern', 'barre chord', 'pickup', 'string gauge', 'metronome', 'fingerpicking', 'tuning', 'amp', 'pedalboard', 'practice log'], sentences: ['Practice the barre chords with a metronome at sixty beats per minute.', 'The capo on the second fret puts the song in a singable key.', 'Lighter string gauge makes bends easier but the tuning drifts.', 'Map the pentatonic scale across the whole fretboard, one position a week.', 'The pedalboard order matters: compression before overdrive, delay last.', 'Fingerpicking patterns feel slow until the thumb goes on autopilot.'] },
	{ name: 'spanish', tag: 'language', nouns: ['subjunctive', 'vocabulary deck', 'conjugation', 'tutor session', 'listening practice', 'flashcard', 'past tense', 'idiom', 'pronunciation', 'grammar drill', 'immersion', 'reading log', 'accent', 'verb table'], sentences: ['The subjunctive shows up after expressions of doubt and wish.', 'Review the vocabulary deck every morning before the tutor session.', 'Listening practice with podcasts at normal speed is still hard.', 'The preterite and the imperfect past tenses trip me up in stories.', 'Idioms rarely translate; learn them as whole phrases.', 'Rolling the r needs the tongue relaxed, not tense.'] },
	{ name: 'home renovation', tag: 'house', nouns: ['drywall', 'permit', 'contractor', 'subfloor', 'tile', 'load-bearing wall', 'electrical panel', 'quote', 'paint sample', 'baseboard', 'plumbing rough-in', 'inspection', 'cabinet', 'backsplash'], sentences: ['The permit for the bathroom needs the plumbing rough-in inspected first.', 'Get three contractor quotes before touching the load-bearing wall.', 'The subfloor has to be flat within a quarter inch before tile goes down.', 'Paint samples look different at night under the warm bulbs.', 'The electrical panel is full; a subpanel is cheaper than a replacement.', 'Baseboards go on after the floor, before the final paint coat.'] },
	{ name: 'machine learning', tag: 'ml', nouns: ['training run', 'learning rate', 'validation loss', 'embedding', 'tokenizer', 'fine-tune', 'checkpoint', 'batch size', 'overfitting', 'dataset split', 'inference latency', 'quantization', 'evaluation set', 'GPU memory'], sentences: ['The validation loss plateaued at epoch twelve; lower the learning rate.', 'Quantization to four bits halves inference latency with little quality loss.', 'Keep the evaluation set out of the fine-tune or the numbers lie.', 'Batch size is limited by GPU memory, not by the dataset.', 'Save a checkpoint every thousand steps so a crash costs minutes, not hours.', 'The tokenizer splits rare words badly; add them to the vocabulary.'] },
	{ name: 'cycling', tag: 'fitness', nouns: ['cassette', 'chainring', 'tubeless tire', 'bike fit', 'power meter', 'FTP test', 'gravel route', 'saddle height', 'derailleur', 'bottom bracket', 'brake pad', 'group ride', 'climb', 'cadence'], sentences: ['The FTP test came in at 245 watts after the winter trainer block.', 'Tubeless tires at lower pressure make the gravel route comfortable.', 'Index the rear derailleur after the new cassette goes on.', 'Saddle height up five millimeters fixed the knee pain.', 'The bottom bracket creak was a dry seat, not a bad bearing.', 'The group ride drops people on the second climb; eat before it.'] },
	{ name: 'writing', tag: 'writing', nouns: ['draft', 'outline', 'chapter', 'editor', 'word count', 'revision', 'query letter', 'beta reader', 'scene', 'point of view', 'deadline', 'manuscript', 'submission', 'style guide'], sentences: ['The second draft cuts the first chapter entirely; the story starts in chapter two.', 'Beta readers flagged the point of view shift in the middle scene.', 'A query letter is one page: hook, book, and bio.', 'Hit the word count daily, revise weekly.', 'The style guide wants numerals for everything over ten.', 'Submission deadlines for the anthology close at the end of the month.'] },
	{ name: 'astronomy', tag: 'hobby', nouns: ['telescope', 'eyepiece', 'light pollution', 'polar alignment', 'nebula', 'star tracker', 'dark site', 'collimation', 'planetary imaging', 'moon phase', 'stacking software', 'dew heater', 'aperture', 'star chart'], sentences: ['Collimate the telescope before every planetary imaging session.', 'The dark site is forty minutes away and worth it for the nebula shots.', 'Polar alignment within an arcminute keeps the star tracker trailing-free.', 'Stacking software pulls detail out of a hundred short exposures.', 'A dew heater on the corrector plate saves the night in autumn.', 'Check the moon phase; a full moon washes out everything faint.'] },
	{ name: 'product management', tag: 'work', nouns: ['roadmap', 'user interview', 'metric', 'launch checklist', 'stakeholder', 'spec', 'prioritization', 'release notes', 'onboarding flow', 'churn', 'feature flag', 'retrospective', 'OKR', 'customer feedback'], sentences: ['Three user interviews a week keep the roadmap honest.', 'The launch checklist includes release notes, support docs and the feature flag plan.', 'Churn rose after the onboarding flow change; roll it back behind a flag.', 'Stakeholders want the spec before the prioritization meeting.', 'OKRs are set quarterly; the metric review is weekly.', 'The retrospective found the handoff to support was the gap.'] },
	{ name: 'electronics', tag: 'maker', nouns: ['microcontroller', 'soldering iron', 'breadboard', 'firmware', 'voltage regulator', 'sensor', 'PCB', 'oscilloscope', 'I2C bus', 'battery pack', 'enclosure', 'schematic', 'bootloader', 'resistor'], sentences: ['The voltage regulator overheats above 500 milliamps; add a heatsink.', 'Pull-up resistors on the I2C bus fixed the dropped sensor readings.', 'Flash the bootloader once, then firmware updates go over USB.', 'Breadboard first, then order the PCB after the schematic is reviewed.', 'The oscilloscope showed ringing on the clock line; shorten the wire.', 'A 3D-printed enclosure needs vents near the battery pack.'] },
	{ name: 'sailing', tag: 'hobby', nouns: ['mainsail', 'jib', 'halyard', 'tide table', 'anchorage', 'reef', 'mooring', 'chart plotter', 'keel', 'winch', 'bilge pump', 'VHF radio', 'tack', 'knot'], sentences: ['Reef the mainsail early when the forecast calls for twenty knots.', 'Check the tide table before entering the shallow anchorage.', 'The halyard chafes at the masthead; replace it before the season.', 'The bilge pump float switch sticks; test it every launch.', 'A VHF radio check with the marina before leaving the mooring.', 'Tack before the shoal marked on the chart plotter.'] },
	{ name: 'nutrition', tag: 'health', nouns: ['protein target', 'meal prep', 'fiber', 'hydration', 'calorie deficit', 'macro split', 'supplement', 'blood work', 'fasting window', 'grocery list', 'sleep', 'caffeine', 'vitamin D', 'electrolyte'], sentences: ['Protein target is 150 grams a day; meal prep makes it reachable.', 'Blood work showed low vitamin D; supplementing through winter.', 'Caffeine after two in the afternoon wrecks sleep.', 'Electrolytes on long training days prevent the evening headache.', 'The fasting window closes at eight; no snacks after.', 'More fiber from the grocery list, fewer processed snacks.'] },
	{ name: 'rust programming', tag: 'code', nouns: ['borrow checker', 'lifetime', 'trait', 'cargo workspace', 'async runtime', 'enum', 'pattern match', 'crate', 'unsafe block', 'iterator', 'clippy lint', 'ownership', 'generic', 'error type'], sentences: ['The borrow checker complaint went away once the lifetime was explicit.', 'Split the cargo workspace into crates so compile times stay sane.', 'Model the states as an enum and pattern match exhaustively.', 'Clippy lints caught three needless clones in the iterator chain.', 'Keep unsafe blocks tiny and documented.', 'A custom error type with thiserror keeps the signatures readable.'] },
	{ name: 'travel', tag: 'travel', nouns: ['itinerary', 'flight', 'hostel', 'visa', 'packing list', 'train pass', 'layover', 'currency', 'travel insurance', 'museum', 'neighborhood', 'SIM card', 'jet lag', 'day trip'], sentences: ['The itinerary leaves two free days for whatever the neighborhood turns up.', 'Buy the train pass before arrival; it is cheaper abroad.', 'A local SIM card beats roaming for maps and translation.', 'Travel insurance needs to cover the hiking day trip.', 'Jet lag is worse eastbound; book a morning flight.', 'The museum is closed Mondays, swap it with the market day.'] },
	{ name: 'beekeeping', tag: 'hobby', nouns: ['hive', 'queen', 'brood frame', 'honey super', 'smoker', 'varroa mite', 'swarm', 'nectar flow', 'extractor', 'entrance reducer', 'apiary', 'wax foundation', 'inspection', 'winter cluster'], sentences: ['Inspect the brood frames every ten days during the nectar flow.', 'Varroa mite counts above three per hundred mean treat now.', 'Add a honey super when eight of ten frames are drawn.', 'The entrance reducer goes on before the first frost.', 'A swarm cell on the bottom bar means the hive is crowded.', 'The winter cluster needs forty pounds of stores.'] },
	{ name: 'data engineering', tag: 'infra', nouns: ['pipeline', 'warehouse', 'dbt model', 'schema migration', 'partition', 'backfill', 'orchestrator', 'data quality check', 'incremental load', 'lakehouse', 'CDC stream', 'dashboard', 'retention policy', 'parquet file'], sentences: ['The backfill reprocessed six months of partitions overnight.', 'dbt models run incrementally; a schema migration forces a full refresh.', 'Data quality checks block the dashboard refresh when row counts drop.', 'The CDC stream lags during the nightly warehouse compaction.', 'Parquet files partitioned by day keep the scans cheap.', 'The retention policy drops raw events after ninety days.'] },
	{ name: 'parenting', tag: 'family', nouns: ['bedtime routine', 'school pickup', 'pediatrician', 'nap schedule', 'playdate', 'chore chart', 'screen time', 'homework', 'birthday party', 'car seat', 'babysitter', 'summer camp', 'allowance', 'field trip'], sentences: ['The bedtime routine starts at seven: bath, book, lights out.', 'School pickup moves to three-fifteen on early-release Wednesdays.', 'Screen time is an hour on weekdays, more on rainy weekends.', 'The chore chart earns allowance on Sundays.', 'Summer camp registration opens in February and fills in a day.', 'The car seat switches to forward-facing at the next checkup.'] },
	{ name: 'climbing', tag: 'fitness', nouns: ['bouldering', 'crimp', 'belay', 'route grade', 'hangboard', 'crux', 'top rope', 'finger strength', 'chalk', 'dynamic move', 'project route', 'rest day', 'anchor', 'heel hook'], sentences: ['Hangboard twice a week builds the finger strength for the crimps.', 'The crux on the project route needs a heel hook, not a dyno.', 'Rest days matter more than extra sessions for tendon health.', 'Belay check before every top rope climb, every time.', 'Route grades at the new gym feel a full number softer.', 'Chalk up before the dynamic move or the hand slips.'] },
];

const FIRST = ['Priya', 'Marcus', 'Elena', 'Tomas', 'Aisha', 'Jonas', 'Mei', 'Rafael', 'Hannah', 'Kwame', 'Sofia', 'Daniel', 'Yuki', 'Omar', 'Lucia', 'Noah', 'Fatima', 'Leo', 'Ingrid', 'Mateo', 'Zara', 'Ethan', 'Nadia', 'Samuel', 'Chloe', 'Arjun', 'Greta', 'Ivan', 'Rosa', 'Felix'];
const LAST = ['Shah', 'Lee', 'Novak', 'Okafor', 'Schmidt', 'Tanaka', 'Moreau', 'Haddad', 'Lindqvist', 'Costa', 'Petrov', 'Nakamura', 'Byrne', 'Mensah', 'Rossi', 'Khan', 'Olsen', 'Duarte', 'Varga', 'Ibrahim'];
const ROLES = ['engineering manager', 'staff engineer', 'product designer', 'data analyst', 'contractor', 'account manager', 'technical writer', 'site reliability engineer', 'researcher', 'finance partner'];
const TEAMS = ['Platform', 'Growth', 'Payments', 'Mobile', 'Data', 'Support', 'Design', 'Security'];
const CITIES = ['Austin', 'Lisbon', 'Toronto', 'Berlin', 'Denver', 'Osaka', 'Dublin', 'Nairobi', 'Montreal', 'Seattle'];
const CODENAMES = ['Aurora', 'Basalt', 'Cinder', 'Dune', 'Ember', 'Fjord', 'Granite', 'Harbor', 'Ivory', 'Juniper', 'Kestrel', 'Lantern', 'Meridian', 'Nimbus', 'Orchid', 'Pike', 'Quarry', 'Rook', 'Saffron', 'Tundra', 'Umber', 'Vesper', 'Willow', 'Yarrow', 'Zephyr', 'Atlas', 'Beacon', 'Copper', 'Delta', 'Echo', 'Falcon', 'Glacier', 'Helix', 'Iris', 'Jade', 'Kite', 'Lumen', 'Mesa', 'Nova', 'Onyx', 'Prism', 'Quill', 'Ridge', 'Slate', 'Thistle', 'Ultra', 'Violet', 'Wren', 'Xenon', 'Yonder'];
const CODENAME2 = ['Trellis', 'Relay', 'Forge', 'Ledger', 'Compass', 'Bridge', 'Anvil', 'Signal', 'Garden', 'Harvest', 'Summit', 'Current', 'Orbit', 'Canvas', 'Vector', 'Lattice', 'Keel', 'Mantle', 'Pulse', 'Switch'];
const VENDORS = ['Northwind Supply', 'Cobalt Systems', 'Halvorsen Logistics', 'Redfern Analytics', 'Marigold Print', 'Tessera Cloud', 'Brightline Legal', 'Quarry Hardware', 'Lumen Studio', 'Pinecrest Security'];
const DEVICES = ['dishwasher', 'espresso machine', 'router', 'e-bike', 'standing desk', 'heat pump', 'laser printer', 'robot vacuum', 'monitor', 'chainsaw', 'water heater', 'treadmill'];
const DEVICE_BRANDS = ['Bosch', 'Breville', 'Netgear', 'Rad Power', 'Uplift', 'Mitsubishi', 'Brother', 'Roborock', 'Dell', 'Stihl', 'Rheem', 'NordicTrack'];
const BOOKS = ['Shape Up', 'Deep Work', 'The Mom Test', 'Thinking in Systems', 'Working in Public', 'The Design of Everyday Things', 'High Output Management', 'Range', 'Atomic Habits', 'The Goal', 'An Elegant Puzzle', 'Four Thousand Weeks', 'Ultralearning', 'Slow Productivity', 'Noise', 'The Phoenix Project', 'Accelerate', 'Debt', 'Seeing Like a State', 'Piranesi', 'The Overstory', 'Braiding Sweetgrass', 'How Buildings Learn', 'A Pattern Language'];
const AUTHORS = ['Ryan Singer', 'Cal Newport', 'Rob Fitzpatrick', 'Donella Meadows', 'Nadia Eghbal', 'Don Norman', 'Andy Grove', 'David Epstein', 'James Clear', 'Eliyahu Goldratt', 'Will Larson', 'Oliver Burkeman', 'Scott Young', 'Cal Newport', 'Daniel Kahneman', 'Gene Kim', 'Nicole Forsgren', 'David Graeber', 'James C. Scott', 'Susanna Clarke', 'Richard Powers', 'Robin Wall Kimmerer', 'Stewart Brand', 'Christopher Alexander'];
const PLANTS = ['fiddle-leaf fig', 'monstera', 'snake plant', 'basil', 'rosemary', 'orchid', 'pothos', 'lemon tree', 'bonsai', 'fern'];
const DISHES = ['sourdough loaf', 'braised short ribs', 'roast chicken', 'focaccia', 'lasagna', 'granola', 'banana bread', 'pizza dough', 'shakshuka', 'pulled pork'];
const LIFTS = ['deadlift', 'back squat', 'bench press', 'overhead press', 'front squat', 'weighted pull-up'];
const SERVICES = ['Fastmail', '1Password', 'Backblaze', 'Figma', 'Notion', 'Adobe Lightroom', 'Strava', 'Spotify', 'GitHub Copilot', 'Tailscale', 'Hey', 'Kagi', 'Readwise', 'Zwift'];
const CARS = ['Subaru Outback', 'Honda Civic', 'Toyota Tacoma', 'Mazda 3', 'Ford Transit', 'Volvo XC60'];

// ---------- dates ----------
const START = Date.UTC(2024, 0, 8); // Monday
const DAYS = Math.max(120, Math.min(900, Math.round(N / 6)));
function dateAt(day) {
	const d = new Date(START + day * 86400000);
	return d.toISOString().slice(0, 10);
}
function longDate(iso) {
	const d = new Date(iso + 'T00:00:00Z');
	return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}
function weekday(iso) {
	return new Date(iso + 'T00:00:00Z').getUTCDay();
}

// ---------- entities ----------
const notes = new Map(); // path -> { path, name, kind, domain, frontmatter, sections: [], links: Set, day }
function addNote(path, note) {
	if (notes.has(path)) return notes.get(path);
	notes.set(path, { path, name: path.slice(path.lastIndexOf('/') + 1, -3), links: new Set(), sections: [], frontmatter: {}, ...note });
	return notes.get(path);
}
const link = (from, to) => {
	if (from.path !== to.path) from.links.add(to.path);
};

const daily = Math.min(DAYS, Math.round(N * 0.2));
const rest = N - daily;
const counts = {
	daily,
	people: Math.max(8, Math.round(rest * 0.06)),
	projects: Math.max(6, Math.round(rest * 0.1)),
	areas: Math.max(4, Math.round(rest * 0.03)),
	meetings: Math.round(rest * 0.25),
	reading: Math.round(rest * 0.12),
	reference: Math.round(rest * 0.14),
	inbox: 0,
};
counts.inbox = Math.max(10, N - Object.values(counts).reduce((a, b) => a + b, 0));

const people = [];
const usedPeople = new Set();
while (people.length < counts.people) {
	let name = `${pick(FIRST)} ${pick(LAST)}`;
	if (usedPeople.has(name)) {
		if (usedPeople.size < FIRST.length * LAST.length * 0.6) continue;
		name = `${name} ${pick(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'J', 'K'])}.`;
		if (usedPeople.has(name)) name = `${name.slice(0, -2)} ${people.length}.`;
	}
	usedPeople.add(name);
	const domain = pick(DOMAINS);
	const n = addNote(`People/${name}.md`, { kind: 'person', domain, role: pick(ROLES), team: pick(TEAMS), city: pick(CITIES) });
	n.frontmatter = { type: 'person', role: n.role, team: n.team, tags: ['person', n.team.toLowerCase()] };
	people.push(n);
}

const projects = [];
const usedProj = new Set();
while (projects.length < counts.projects) {
	let name = `${pick(CODENAMES)} ${pick(CODENAME2)}`;
	if (usedProj.has(name)) {
		if (usedProj.size < CODENAMES.length * CODENAME2.length * 0.6) continue;
		name = `${name} ${['II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'][ri(9)]}`;
		if (usedProj.has(name)) name = `${name} ${projects.length}`;
	}
	usedProj.add(name);
	const domain = pick(DOMAINS);
	const archived = chance(0.25);
	const folder = archived ? 'Archive/Projects' : 'Projects';
	const owner = pick(people);
	const n = addNote(`${folder}/${name}.md`, { kind: 'project', domain, owner, archived, members: sample(people, 2 + ri(4)), startDay: ri(DAYS) });
	n.frontmatter = { type: 'project', status: archived ? 'archived' : pick(['active', 'active', 'planning', 'on-hold']), owner: `[[${owner.name}]]`, tags: ['project', domain.tag] };
	link(n, owner);
	for (const m of n.members) link(n, m);
	projects.push(n);
}
const activeProjects = projects.filter((p) => !p.archived);
for (const p of people) {
	p.projects = projects.filter((pr) => pr.owner === p || pr.members.includes(p));
	for (const pr of p.projects) link(p, pr);
}

const areas = [];
for (let i = 0; i < counts.areas; i++) {
	const domain = DOMAINS[i % DOMAINS.length];
	const title = domain.name.replace(/\b\w/g, (c) => c.toUpperCase());
	const n = addNote(`Areas/${title}${i >= DOMAINS.length ? ' ' + (Math.floor(i / DOMAINS.length) + 1) : ''}.md`, { kind: 'area', domain });
	n.frontmatter = { type: 'area', tags: ['area', domain.tag] };
	areas.push(n);
}

const meetings = [];
for (let i = 0; i < counts.meetings; i++) {
	const project = pick(projects);
	const day = Math.min(DAYS - 1, project.startDay + ri(120));
	const date = dateAt(day);
	const type = pick(['Standup', 'Planning', 'Review', 'Sync', 'Retro', 'Kickoff']);
	const n = addNote(`Meetings/${date} ${project.name} ${type}.md`, { kind: 'meeting', domain: project.domain, project, day, attendees: sample(project.members.concat(project.owner), 2 + ri(3)), type });
	n.frontmatter = { type: 'meeting', date, project: `[[${project.name}]]`, tags: ['meeting', project.domain.tag] };
	link(n, project);
	for (const a of n.attendees) link(n, a);
	meetings.push(n);
}

const readings = [];
for (let i = 0; i < counts.reading; i++) {
	const bi = ri(BOOKS.length);
	const title = i < BOOKS.length ? BOOKS[bi] : `${BOOKS[bi]} notes ${i}`;
	const path = `Reading/${title.replace(/[\\/:*?"<>|]/g, '')}.md`;
	if (notes.has(path)) {
		i--;
		if (readings.length >= BOOKS.length * 50) break;
		continue;
	}
	const n = addNote(path, { kind: 'reading', domain: pick(DOMAINS), book: BOOKS[bi], author: AUTHORS[bi], day: ri(DAYS) });
	n.frontmatter = { type: 'book', author: n.author, status: pick(['reading', 'finished', 'finished', 'abandoned']), tags: ['reading', n.domain.tag] };
	readings.push(n);
}

const references = [];
for (let i = 0; i < counts.reference; i++) {
	const domain = pick(DOMAINS);
	const topic = pick(domain.nouns);
	const title = `${topic.replace(/\b\w/g, (c) => c.toUpperCase())} ${pick(['Guide', 'Checklist', 'Notes', 'How-to', 'Reference', 'Setup'])}${i > 300 ? ' ' + i : ''}`;
	let path = `Reference/${domain.name.replace(/\b\w/g, (c) => c.toUpperCase())}/${title}.md`;
	if (notes.has(path)) path = path.replace(/\.md$/, ` ${i}.md`);
	const n = addNote(path, { kind: 'reference', domain, long: chance(0.2), day: ri(DAYS) });
	n.frontmatter = { type: 'reference', tags: ['reference', domain.tag] };
	references.push(n);
}

const inbox = [];
for (let i = 0; i < counts.inbox; i++) {
	const domain = pick(DOMAINS);
	const n = addNote(`Inbox/${pick(['Idea', 'Note', 'Todo', 'Question', 'Link', 'Snippet'])} ${i + 1}.md`, { kind: 'inbox', domain, day: ri(DAYS) });
	inbox.push(n);
}

const dailies = [];
const dailyDays = sample([...Array(DAYS).keys()], counts.daily).sort((a, b) => a - b);
for (const day of dailyDays) {
	const date = dateAt(day);
	const n = addNote(`Daily/${date.slice(0, 4)}/${date}.md`, { kind: 'daily', domain: pick(DOMAINS), day, date });
	n.frontmatter = { type: 'daily', date, tags: ['daily'] };
	dailies.push(n);
}

// ---------- graph: clustered links plus hubs ----------
const byDomain = new Map();
for (const n of notes.values()) {
	if (!byDomain.has(n.domain)) byDomain.set(n.domain, []);
	byDomain.get(n.domain).push(n);
}
const all = [...notes.values()];
const hubs = [...projects, ...areas, ...people];
function addClusterLinks(n, count) {
	const cluster = byDomain.get(n.domain) ?? [];
	for (let i = 0; i < count; i++) {
		const r = rnd();
		const target = r < 0.55 ? pick(cluster) : r < 0.85 ? pick(hubs) : pick(all);
		if (target && target !== n) link(n, target);
	}
}
for (const n of all) {
	const base = { project: 4, person: 1, area: 6, meeting: 2, reading: 2, reference: 3, inbox: 1, daily: 3 }[n.kind] ?? 2;
	addClusterLinks(n, base + ri(3));
}
// daily notes link to notes "touched" that day (nearby meetings/readings/inbox by day)
const dated = all.filter((n) => n.day !== undefined && n.kind !== 'daily');
for (const d of dailies) {
	const near = dated.filter((n) => Math.abs(n.day - d.day) <= 2);
	for (const n of sample(near, 1 + ri(3))) link(d, n);
}
// area notes act as index pages
for (const a of areas) {
	for (const n of sample(byDomain.get(a.domain) ?? [], 8 + ri(12))) link(a, n);
}

// ---------- planted facts and questions ----------
const questions = [];
const plantedHosts = new Set();
function fresh(cands) {
	const c = cands.filter((n) => !plantedHosts.has(n.path));
	if (c.length === 0) return null;
	const n = pick(c);
	plantedHosts.add(n.path);
	return n;
}
function money(min, max) {
	return (Math.round((min + rnd() * (max - min)) / 100) * 100).toLocaleString('en-US');
}
let qid = 0;
function ask(kind, question, answers, extra = {}) {
	questions.push({ id: `q${++qid}`, kind, question, answers, ...extra });
}

const FACT_PLANTERS = [
	// project budget (keyword / paraphrase / unnamed / multihop)
	() => {
		const p = fresh(activeProjects);
		if (!p) return;
		const total = money(20000, 90000);
		const spentN = Math.round(rnd() * 0.8 * Number(total.replace(/,/g, '')) / 100) * 100;
		const rem = (Number(total.replace(/,/g, '')) - spentN).toLocaleString('en-US');
		p.planted = (p.planted ?? []).concat([`## Budget\n\nTotal approved: $${total}. Spent to date: $${spentN.toLocaleString('en-US')}. Remaining: $${rem}. Budget owner: [[${p.owner.name}]].`]);
		ask('keyword', `How much budget is remaining for ${p.name}?`, [p.path], { answer: `$${rem}` });
		ask('paraphrase', `What funds are still unspent on the ${p.name} initiative?`, [p.path], { answer: `$${rem}` });
		ask('unnamed', `Which ${p.domain.name} project has about $${rem} left to spend?`, [p.path], { answer: p.name });
		ask('multihop', `How much money is left on the project that ${p.owner.name} owns?`, [p.path], { via: [p.owner.path], answer: `$${rem}`, note: p.owner.projects.filter((x) => x.owner === p.owner).length > 1 ? 'owner owns several projects' : undefined });
	},
	// launch date
	() => {
		const p = fresh(activeProjects);
		if (!p) return;
		const date = dateAt(Math.min(DAYS - 1, p.startDay + 60 + ri(120)));
		p.planted = (p.planted ?? []).concat([`Launch date: ${longDate(date)}. The go/no-go review is one week before.`]);
		ask('keyword', `What is the launch date for ${p.name}?`, [p.path], { answer: longDate(date) });
		ask('paraphrase', `When does ${p.name} go live?`, [p.path], { answer: longDate(date) });
		ask('unnamed', `Which project ships on ${longDate(date)}?`, [p.path], { answer: p.name });
		ask('multihop', `When does the ${p.domain.name} project owned by ${p.owner.name} go live?`, [p.path], { via: [p.owner.path], answer: longDate(date) });
	},
	// vendor
	() => {
		const p = fresh(projects);
		if (!p) return;
		const vendor = pick(VENDORS);
		const date = dateAt(ri(DAYS));
		p.planted = (p.planted ?? []).concat([`Vendor: ${vendor}. The contract renews on ${longDate(date)}; cancellation needs 60 days notice.`]);
		ask('keyword', `Who is the vendor for ${p.name} and when does the contract renew?`, [p.path], { answer: `${vendor}, ${longDate(date)}` });
		ask('paraphrase', `Which supplier does ${p.name} rely on, and when is that agreement extended?`, [p.path], { answer: `${vendor}, ${longDate(date)}` });
		ask('unnamed', `Which project has a supplier agreement with ${vendor}?`, [p.path], { answer: p.name });
		{
			const m = meetings.find((x) => x.project === p);
			if (m) ask('multihop', `Which vendor does the project discussed in the ${m.name} meeting use?`, [p.path], { via: [m.path], answer: vendor });
		}
	},
	// top risk
	() => {
		const p = fresh(activeProjects);
		if (!p) return;
		const risk = pick(['the single supplier for the enclosure parts', 'losing the only engineer who knows the billing code', 'the certification audit slipping past the launch', 'customer data migration taking longer than the freeze window', 'the pricing page copy not being ready', 'a dependency on an unreleased platform API']);
		const owner = pick(p.members);
		p.planted = (p.planted ?? []).concat([`## Risks\n\n- Top risk: ${risk} (owner: [[${owner.name}]]).\n- Mitigation reviewed at every ${pick(['Review', 'Planning'])} meeting.`]);
		ask('keyword', `What is the top risk on ${p.name}?`, [p.path], { answer: risk });
		ask('paraphrase', `What is the biggest threat to ${p.name} succeeding?`, [p.path], { answer: risk });
		ask('multihop', `Who owns the top risk on the project that ${p.owner.name} owns?`, [p.path], { via: [p.owner.path], answer: owner.name });
	},
	// meeting decision
	() => {
		const m = fresh(meetings);
		if (!m) return;
		const decision = pick(['move the beta to the second week of the month', 'drop the Android build from the first release', 'switch the vendor for the printed materials', 'freeze the schema until the migration finishes', 'hire a contractor for the documentation', 'cut the onboarding survey to three questions']);
		m.planted = (m.planted ?? []).concat([`## Decisions\n\n- Decided to ${decision}.`]);
		ask('keyword', `What was decided at the ${m.project.name} ${m.type.toLowerCase()} on ${longDate(dateAt(m.day))}?`, [m.path], { answer: decision });
		ask('paraphrase', `What did the team agree on in the ${m.project.name} meeting held ${longDate(dateAt(m.day))}?`, [m.path], { answer: decision });
		ask('unnamed', `In which meeting did we decide to ${decision}?`, [m.path], { answer: m.name });
		ask('multihop', `What did ${m.project.owner.name}'s project team decide at its ${m.type.toLowerCase()} on ${longDate(dateAt(m.day))}?`, [m.path], { via: [m.project.owner.path, m.project.path], answer: decision });
	},
	// person role / city
	() => {
		const p = fresh(people);
		if (!p) return;
		p.planted = (p.planted ?? []).concat([`Role: ${p.role}. Team: ${p.team}. Based in ${p.city}; working hours overlap with ours until early afternoon.`]);
		ask('keyword', `What is ${p.name}'s role and team?`, [p.path], { answer: `${p.role}, ${p.team}` });
		ask('paraphrase', `What does ${p.name} do and which group are they part of?`, [p.path], { answer: `${p.role}, ${p.team}` });
		ask('paraphrase', `Which city does ${p.name} work from?`, [p.path], { answer: p.city });
		if (p.projects[0]) ask('multihop', `Where is the owner of ${p.projects.find((x) => x.owner === p)?.name ?? p.projects[0].name} based?`, [p.path], { via: [p.projects.find((x) => x.owner === p)?.path ?? p.projects[0].path], answer: p.city });
	},
	// reading takeaway / author
	() => {
		const r = fresh(readings);
		if (!r) return;
		const takeaway = pick(['appetite, not estimates, should bound the work', 'shallow work expands to fill the calendar', 'ask about past behaviour, never about hypothetical interest', 'stocks and flows explain most surprising system behaviour', 'maintenance is the invisible majority of open source', 'affordances tell people what an object can do', 'output is the sum of what your team and the teams you influence produce', 'sampling widely beats specializing early', 'tiny habits compound because identity shifts first', 'the bottleneck sets the pace of the whole system']);
		r.planted = (r.planted ?? []).concat([`## Key takeaway\n\n${takeaway.charAt(0).toUpperCase() + takeaway.slice(1)}. Author: ${r.author}.`]);
		ask('keyword', `What is the key takeaway from ${r.name}?`, [r.path], { answer: takeaway });
		ask('paraphrase', `What is the main lesson of the ${r.name} notes?`, [r.path], { answer: takeaway });
		ask('keyword', `Who wrote ${r.name}?`, [r.path], { answer: r.author });
	},
	// reference command
	() => {
		const r = fresh(references);
		if (!r) return;
		const task = pick(['rotate the ingress certificate', 'rebuild the lightroom previews', 'reindex the warehouse partitions', 'flash the firmware', 'resync the vocabulary deck', 'export the training checkpoint', 'calibrate the power meter', 'regenerate the dbt docs']);
		const cmd = `${pick(['make', 'npm run', 'cargo', 'kubectl', 'just', 'poetry run'])} ${task.split(' ')[0]}-${task.split(' ').slice(-1)[0]} --${pick(['force', 'all', 'verbose', 'dry-run'])}`;
		r.planted = (r.planted ?? []).concat([`## Procedure\n\nTo ${task}, run \`${cmd}\` from the repo root and wait for the green check.`]);
		ask('keyword', `What command do I run to ${task}?`, [r.path], { answer: cmd });
		ask('paraphrase', `How do I ${task.replace('rotate', 'renew').replace('rebuild', 'regenerate').replace('reindex', 'rebuild the index for').replace('flash', 'install').replace('resync', 'refresh').replace('export', 'save').replace('calibrate', 'recalibrate').replace('regenerate', 'refresh')}?`, [r.path], { answer: cmd });
	},
	// daily decision
	() => {
		const d = fresh(dailies);
		if (!d) return;
		const who = pick(people);
		const decision = pick(['cancel the gym membership and run outside instead', 'move the retrospective to Fridays', 'replace the kitchen faucet myself', 'sell the old camera body', 'switch the team to the new on-call rotation', 'take the train instead of flying for the conference']);
		d.planted = (d.planted ?? []).concat([`Decided to ${decision} after talking with [[${who.name}]].`]);
		link(d, who);
		ask('keyword', `What did I decide on ${longDate(d.date)}?`, [d.path], { answer: decision });
		ask('paraphrase', `What conclusion did I reach on ${longDate(d.date)} after the chat with ${who.name}?`, [d.path], { answer: decision });
		ask('unnamed', `On which day did I decide to ${decision}?`, [d.path], { answer: longDate(d.date) });
	},
	// recipe temperature (reference or inbox)
	() => {
		const r = fresh(references.concat(inbox));
		if (!r) return;
		const dish = pick(DISHES);
		const temp = 325 + 25 * ri(8);
		const min = 15 + 5 * ri(12);
		r.planted = (r.planted ?? []).concat([`## ${dish.charAt(0).toUpperCase() + dish.slice(1)}\n\nOven temperature: ${temp}°F for ${min} minutes, then rest ten minutes before slicing.`]);
		ask('keyword', `What oven temperature does the ${dish} recipe use?`, [r.path], { answer: `${temp}°F` });
		ask('paraphrase', `How hot should the oven be for the ${dish}, and for how long?`, [r.path], { answer: `${temp}°F, ${min} minutes` });
	},
	// device warranty / serial
	() => {
		const r = fresh(references.concat(inbox, dailies));
		if (!r) return;
		const di = ri(DEVICES.length);
		const device = DEVICES[di];
		const brand = DEVICE_BRANDS[di];
		const serial = `${brand.slice(0, 2).toUpperCase()}${100000 + ri(900000)}`;
		const date = dateAt(ri(DAYS));
		r.planted = (r.planted ?? []).concat([`${brand} ${device}: serial number ${serial}, warranty expires ${longDate(date)}. Receipt is in the email archive.`]);
		ask('keyword', `What is the serial number of the ${brand} ${device}?`, [r.path], { answer: serial });
		ask('paraphrase', `Until when is the ${device} still covered by its guarantee?`, [r.path], { answer: longDate(date) });
	},
	// plant watering
	() => {
		const r = fresh(inbox.concat(references));
		if (!r) return;
		const plant = pick(PLANTS);
		const n = 3 + ri(10);
		r.planted = (r.planted ?? []).concat([`Water the ${plant} every ${n} days; less in winter. Bright indirect light.`]);
		ask('keyword', `How often should I water the ${plant}?`, [r.path], { answer: `every ${n} days` });
		ask('paraphrase', `What is the watering interval for the ${plant}?`, [r.path], { answer: `every ${n} days` });
	},
	// subscription cost
	() => {
		const r = fresh(inbox.concat(references, dailies));
		if (!r) return;
		const svc = pick(SERVICES);
		const price = 30 + 10 * ri(20);
		const date = dateAt(ri(DAYS));
		r.planted = (r.planted ?? []).concat([`${svc} subscription renews ${longDate(date)} at $${price}/year on the shared card.`]);
		ask('keyword', `How much does the ${svc} subscription cost?`, [r.path], { answer: `$${price}/year` });
		ask('paraphrase', `What is the yearly fee for ${svc} and when is it charged?`, [r.path], { answer: `$${price}/year, ${longDate(date)}` });
	},
	// lift PR
	() => {
		const r = fresh(dailies.concat(inbox));
		if (!r) return;
		const lift = pick(LIFTS);
		const w = 95 + 5 * ri(60);
		r.planted = (r.planted ?? []).concat([`New ${lift} PR: ${w} lb. Felt heavy but clean.`]);
		ask('keyword', `What is my ${lift} PR?`, [r.path], { answer: `${w} lb` });
		ask('paraphrase', `What is the heaviest ${lift} I have done?`, [r.path], { answer: `${w} lb` });
	},
	// car oil change
	() => {
		const r = fresh(inbox.concat(dailies, references));
		if (!r) return;
		const car = pick(CARS);
		const miles = (40 + ri(120)) * 1000 + 500 * ri(2);
		r.planted = (r.planted ?? []).concat([`${car}: next oil change due at ${miles.toLocaleString('en-US')} miles; tires rotated at the same visit.`]);
		ask('keyword', `When is the next oil change for the ${car}?`, [r.path], { answer: `${miles.toLocaleString('en-US')} miles` });
		ask('paraphrase', `At what mileage does the ${car} need its oil swapped?`, [r.path], { answer: `${miles.toLocaleString('en-US')} miles` });
	},
	// milestone via meeting action item (multihop through project)
	() => {
		const p = fresh(activeProjects);
		if (!p) return;
		const ms = pick(['Beta', 'Design freeze', 'Security review', 'GA', 'Pilot', 'Data migration']);
		const date = dateAt(Math.min(DAYS - 1, p.startDay + 20 + ri(100)));
		p.planted = (p.planted ?? []).concat([`## Milestones\n\n- ${ms}: ${longDate(date)}\n- Launch readiness review two weeks later`]);
		ask('keyword', `When is the ${ms} milestone for ${p.name}?`, [p.path], { answer: longDate(date) });
		ask('multihop', `When is the ${ms} milestone for the ${p.domain.name} project that ${p.owner.name} owns?`, [p.path], { via: [p.owner.path], answer: longDate(date) });
	},
];

const plantRounds = N >= 5000 ? 3 : 2;
for (let round = 0; round < plantRounds; round++) for (const plant of FACT_PLANTERS) plant();

// ---------- rendering ----------
function para(domain, sentences = 3) {
	const out = [];
	const pool = shuffle(domain.sentences);
	for (let i = 0; i < sentences; i++) {
		if (chance(0.6) && pool.length) out.push(pool.pop());
		else out.push(`${pick(['Need to', 'Remember to', 'Still have to', 'Worth trying to', 'Decided to'])} ${pick(['check', 'replace', 'measure', 'review', 'document', 'clean up', 'order', 'compare'])} the ${pick(domain.nouns)} before the ${pick(domain.nouns)} ${pick(['again', 'next week', 'on Friday', 'this weekend', 'after the trip'])}.`);
	}
	return out.join(' ');
}
function linkList(n, k) {
	const targets = sample([...n.links], k).map((p) => `[[${notes.get(p).name}]]`);
	return targets;
}
function yaml(fm) {
	const lines = ['---'];
	for (const [k, v] of Object.entries(fm)) {
		if (Array.isArray(v)) lines.push(`${k}: [${v.join(', ')}]`);
		else lines.push(`${k}: ${typeof v === 'string' && /[:#[\]]/.test(v) && !v.startsWith('[[') ? JSON.stringify(v) : v}`);
	}
	lines.push('---', '');
	return lines.join('\n');
}
function inlineLinks(n, text) {
	// sprinkle a few links into the running text
	const targets = linkList(n, 2);
	return targets.length ? `${text} See ${targets.join(' and ')}.` : text;
}
function render(n) {
	const d = n.domain;
	const parts = [yaml(n.frontmatter)];
	const planted = n.planted ?? [];
	switch (n.kind) {
		case 'project':
			parts.push(`# ${n.name}\n`, `## Overview\n\n${inlineLinks(n, para(d, 4))}\n\n${para(d, 3)}\n`, `Owner: [[${n.owner.name}]]. Team: ${n.members.map((m) => `[[${m.name}]]`).join(', ')}.\n`, `## Scope\n\n- ${para(d, 1)}\n- ${para(d, 1)}\n- ${para(d, 1)}\n`);
			for (const s of planted) parts.push(`${s}\n`);
			if (!planted.some((s) => s.startsWith('## Risks'))) parts.push(`## Risks\n\n- ${para(d, 1)}\n- ${para(d, 1)}\n`);
			parts.push(`## Open questions\n\n- ${para(d, 1)}\n- ${para(d, 1)}\n`, `## Related\n\n${linkList(n, 6).map((l) => `- ${l}`).join('\n')}\n`);
			break;
		case 'person':
			parts.push(`# ${n.name}\n`);
			for (const s of planted) parts.push(`${s}\n`);
			if (planted.length === 0) parts.push(`Role: ${n.role}. Team: ${n.team}.\n`);
			parts.push(`## Working with ${n.name.split(' ')[0]}\n\n${para(d, 2)}\n`, `## Projects\n\n${n.projects.map((p) => `- [[${p.name}]]`).join('\n') || '- (none yet)'}\n`, `## Notes\n\n${linkList(n, 3).map((l) => `- ${l}`).join('\n')}\n`);
			break;
		case 'meeting':
			parts.push(`# ${n.name}\n`, `Project: [[${n.project.name}]]. Attendees: ${n.attendees.map((a) => `[[${a.name}]]`).join(', ')}.\n`, `## Agenda\n\n- ${para(d, 1)}\n- ${para(d, 1)}\n`, `## Notes\n\n${inlineLinks(n, para(d, 3 + ri(4)))}\n\n${para(d, 2 + ri(4))}\n`);
			for (const s of planted) parts.push(`${s}\n`);
			if (!planted.some((s) => s.startsWith('## Decisions')) && chance(0.6)) parts.push(`## Decisions\n\n- ${para(d, 1)}\n`);
			parts.push(`## Action items\n\n- [ ] [[${pick(n.attendees).name}]] to ${pick(['write up', 'review', 'prototype', 'schedule', 'measure'])} the ${pick(d.nouns)} by ${longDate(dateAt(Math.min(DAYS - 1, n.day + 7)))}\n- [${chance(0.5) ? 'x' : ' '}] ${para(d, 1)}\n`);
			break;
		case 'reading':
			parts.push(`# ${n.name}\n`, `Author: ${n.author}.\n`, `## Summary\n\n${para(d, 4 + ri(4))}\n\n${para(d, 3 + ri(4))}\n`, `## Highlights\n\n- ${para(d, 1)}\n- ${para(d, 1)}\n- ${para(d, 1)}\n`);
			for (const s of planted) parts.push(`${s}\n`);
			parts.push(`## Related\n\n${linkList(n, 3).map((l) => `- ${l}`).join('\n')}\n`);
			break;
		case 'reference': {
			parts.push(`# ${n.name}\n`, `${inlineLinks(n, para(d, 3))}\n`);
			const sections = n.long ? 10 + ri(14) : 3 + ri(4);
			for (let i = 0; i < sections; i++) parts.push(`## ${pick(d.nouns).replace(/\b\w/g, (c) => c.toUpperCase())}\n\n${para(d, 3 + ri(5))}\n`);
			for (const s of planted) parts.push(`${s}\n`);
			parts.push(`## See also\n\n${linkList(n, 4).map((l) => `- ${l}`).join('\n')}\n`);
			break;
		}
		case 'area':
			parts.push(`# ${n.name}\n`, `${para(d, 2)}\n`, `## Index\n\n${linkList(n, 20).map((l) => `- ${l}`).join('\n')}\n`);
			for (const s of planted) parts.push(`${s}\n`);
			break;
		case 'inbox':
			parts.push(`${para(d, 1 + ri(3))}${n.links.size ? ` ${linkList(n, 1).join('')}` : ''}\n`);
			for (const s of planted) parts.push(`\n${s}\n`);
			if (chance(0.3)) parts.push(`\n#${d.tag} #inbox\n`);
			break;
		case 'daily':
			parts.push(`# ${n.date}\n`, `${para(d, 2 + ri(3))}\n`);
			for (const s of planted) parts.push(`\n${s}\n`);
			parts.push(`\n## Log\n\n- ${linkList(n, 3).map((l) => `touched ${l}`).join('\n- ')}\n- [ ] ${para(d, 1)}\n- [x] ${para(d, 1)}\n`);
			break;
	}
	return parts.join('\n');
}

// ---------- write ----------
const vaultDir = join(outdir, 'vault');
rmSync(vaultDir, { recursive: true, force: true });
mkdirSync(vaultDir, { recursive: true });
let bytes = 0;
let links = 0;
const kinds = {};
for (const n of notes.values()) {
	const content = render(n);
	const full = join(vaultDir, n.path);
	mkdirSync(dirname(full), { recursive: true });
	writeFileSync(full, content);
	bytes += Buffer.byteLength(content);
	links += n.links.size;
	kinds[n.kind] = (kinds[n.kind] ?? 0) + 1;
}
mkdirSync(join(vaultDir, '.obsidian'), { recursive: true });
writeFileSync(join(vaultDir, '.obsidian', 'app.json'), '{}');
writeFileSync(join(outdir, 'questions.json'), JSON.stringify(questions, null, 1));
writeFileSync(join(outdir, 'stats.json'), JSON.stringify({ notes: notes.size, bytes, links, kinds, questions: questions.length, byKind: questions.reduce((a, q) => ((a[q.kind] = (a[q.kind] ?? 0) + 1), a), {}) }, null, 1));
console.log(JSON.stringify({ notes: notes.size, kb: Math.round(bytes / 1024), avgBytes: Math.round(bytes / notes.size), links, kinds, questions: questions.length }));
