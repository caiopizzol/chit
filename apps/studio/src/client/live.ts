// Pure, clock-free helpers for the live monitor. Selection identity, row
// flattening, age formatting, the selected-run detail shaping (ages, agent
// blocks, iteration label, phase timeline), and the snapshot diff that feeds
// the console all live here so they can be unit-tested without React or a polling timer. The
// hook (useLive) owns the network, the timer, and the wall-clock stamp; this
// module only transforms data it is handed.

import type { LiveActivity, LiveActivityRow, LiveEventKind } from "../server/types.ts";
import type { LiveCancelOutcome } from "./api.ts";

// Stable identity for a live row across polls. The source tag is part of the
// key because a foreground iteration and a background job can carry the same
// runId yet are distinct rows in the rail and the selection.
export function rowKey(row: LiveActivityRow): string {
	return `${row.source}:${row.runId}`;
}

// Flatten the two source arrays into one ordered list (foreground first). The
// rail still renders the two groups separately; this is the addressable index
// behind selection and diffing.
export function flattenRows(activity: LiveActivity): LiveActivityRow[] {
	return [...activity.foreground, ...activity.background];
}

// Compact human age from a millisecond span. Ages the host could not derive
// against its clock arrive undefined and render as a calm placeholder, never a
// fabricated zero.
export function formatAge(ms: number | undefined): string {
	if (ms === undefined || !Number.isFinite(ms) || ms < 0) return "-";
	const s = Math.round(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ${s % 60}s`;
	const h = Math.floor(m / 60);
	return `${h}h ${m % 60}m`;
}

// The single legible phase line for a row. Foreground rows carry `phase`;
// background rows lead with the lifecycle `display` (running / stale / queued)
// and append `phase` when present, so a background phase transition is visible
// even while the display state holds.
export function phaseLabel(row: LiveActivityRow): string {
	if (row.source === "foreground") return row.phase;
	return row.phase ? `${row.display} · ${row.phase}` : row.display;
}

// The concise phase the operator sees in the rail and detail header. Background
// records keep `display` and `phase` separate; when a phase exists, it is the
// useful live signal and `running` is just duplicated lifecycle context.
export function concisePhase(row: LiveActivityRow): string {
	if (row.source === "foreground") return row.phase;
	return row.phase ?? row.display;
}

// --- Selected-run detail shaping (pure helpers) ---

// The phase string the role mapping reads. Foreground rows always carry `phase`;
// a background row may only have the lifecycle `display` (queued / running), so
// it stands in when no phase is reported.
function normalizedPhase(row: LiveActivityRow): string {
	const phase = row.source === "background" ? (row.phase ?? row.display) : row.phase;
	return phase.toLowerCase();
}

// Which participant role the current phase belongs to. Drives the rail summary
// dot and which agent block lights up (and carries the phase timing) in the
// detail. Phases outside the implement/review/check vocabulary -- queued,
// cancelling -- map to "other": no block claims them.
export function activeRole(row: LiveActivityRow): "implementer" | "reviewer" | "checks" | "other" {
	const phase = normalizedPhase(row);
	if (phase.includes("implement") || phase.includes("plan")) return "implementer";
	if (phase.includes("review")) return "reviewer";
	if (phase.includes("check")) return "checks";
	return "other";
}

// Which role a participant key stands for. The wire shape allows arbitrary keys
// and the hosts use abbreviated ones (`impl`, `rev` -- see the foreground
// registry and server fixtures), so this matches on stems shared by the short
// and long spellings rather than the full role names.
function participantRole(key: string): "implementer" | "reviewer" | "checks" | "other" {
	const k = key.toLowerCase();
	if (k.includes("impl") || k.includes("plan")) return "implementer";
	if (k.includes("rev")) return "reviewer";
	if (k.includes("check")) return "checks";
	return "other";
}

// One participant block of the selected run, ready to draw: the safe
// agent+adapter pair, whether the current phase lights it up, and -- on the live
// block only -- the formatted current-phase elapsed. Carrying the phase timing on
// the block that is executing replaces the separate PHASE metric row, so the
// operator reads "who is running, and for how long" in one place.
export interface AgentBlockView {
	role: string;
	agentId: string;
	adapter: string;
	live: boolean;
	phaseElapsed?: string;
	// Set only when the live block's phase has consumed enough of its call-timeout
	// budget to warrant the warm tint (budgetWarmth). Never set on idle blocks.
	warm?: boolean;
	// The safe model identity from the participant snapshot, when the host carried
	// it: the formatted "model · effort" label answering which model is running.
	// Absent when the snapshot reported no model (foreground rows, older records).
	model?: string;
}

// The compact model line for an agent block: the model id, with reasoningEffort
// appended when present. Undefined when no model is known, so the block omits the
// line rather than drawing an empty one.
export function modelLabel(p: { model?: string; reasoningEffort?: string }): string | undefined {
	if (!p.model) return undefined;
	return p.reasoningEffort ? `${p.model} · ${p.reasoningEffort}` : p.model;
}

export function agentBlockViews(row: LiveActivityRow): AgentBlockView[] {
	const entries = row.participants ? Object.entries(row.participants) : [];
	// An "other" phase (queued, cancelling) claims no block: matching it against
	// participantRole's "other" would light unrelated blocks.
	const active = activeRole(row);
	const views: AgentBlockView[] = entries.map(([role, p]) => ({
		role,
		agentId: p.agentId,
		adapter: p.adapter,
		live: active !== "other" && participantRole(role) === active,
		...(modelLabel(p) !== undefined && { model: modelLabel(p) }),
	}));
	if (active === "checks" && !views.some((v) => v.live)) {
		views.push({
			role: "checks",
			agentId: "chit",
			adapter: "required checks",
			live: true,
		});
	}
	const live = views.find((v) => v.live);
	if (live) {
		if (row.phaseElapsedMs !== undefined) live.phaseElapsed = formatAge(row.phaseElapsedMs);
		// callTimeoutMs bounds an adapter call, so the warm treatment only applies
		// to the implementer/reviewer blocks -- a long checks phase is not a budget
		// signal.
		if (
			(active === "implementer" || active === "reviewer") &&
			budgetWarmth(row.phaseElapsedMs, row.callTimeoutMs) === "warm"
		) {
			live.warm = true;
		}
	}
	return views;
}

// The formatted current-phase elapsed for the detail head, present only when no
// agent block carries it (no participants reported, or a phase no block claims).
// The fallback keeps the phase timing visible for every row without ever drawing
// it twice.
export function headPhaseElapsed(row: LiveActivityRow): string | undefined {
	if (row.phaseElapsedMs === undefined) return undefined;
	if (agentBlockViews(row).some((v) => v.live)) return undefined;
	return formatAge(row.phaseElapsedMs);
}

// --- Execution topology shaping (pure helpers) ---

// Shorten a content digest for a calm chip: keep the algorithm prefix (e.g.
// "sha256:") and clip the hex to a short, still-recognizable head. A digest with
// no prefix is clipped whole; one already short enough is returned untouched. The
// full digest is never needed in the rail -- this is a glance, not a verifier.
const DIGEST_HEX_HEAD = 10;

export function shortDigest(digest: string): string {
	const trimmed = digest.trim();
	const colon = trimmed.indexOf(":");
	if (colon >= 0) {
		const prefix = trimmed.slice(0, colon + 1);
		const hex = trimmed.slice(colon + 1);
		return hex.length > DIGEST_HEX_HEAD ? `${prefix}${hex.slice(0, DIGEST_HEX_HEAD)}…` : trimmed;
	}
	return trimmed.length > DIGEST_HEX_HEAD ? `${trimmed.slice(0, DIGEST_HEX_HEAD)}…` : trimmed;
}

// The last path segment of a manifest path, for a compact chip. The full path
// rides the chip's title (LiveTower) so nothing is hidden; this is just the calm
// label. A path with no separator returns unchanged.
export function manifestName(path: string): string {
	const parts = path.split("/").filter((s) => s.length > 0);
	return parts.length > 0 ? (parts[parts.length - 1] as string) : path;
}

// One identity block of the selected run's execution topology: the approved
// recipe or the bound manifest, drawn as a block that wires INTO the
// implementer/reviewer/checks agent chain so the detail reads as execution
// wiring rather than a separate identity strip. `value` is the compact display
// (recipe id / manifest name); `detail` is a quiet secondary line (recipe origin
// layer / shortened content digest). `title`/`detailTitle` carry the full path
// and full digest for a hover, so nothing legible is hidden while the block stays
// compact. Privacy: built only from LiveExecutionIdentity (recipe id/origin,
// manifest path, content digest) -- never manifest contents, prompts, config, or env.
export interface IdentityBlockView {
	kind: "recipe" | "manifest";
	label: string;
	value: string;
	// The unabbreviated value, when the display value is a shortened form (the
	// manifest path behind its last segment). Absent when value is already complete.
	title?: string;
	// A quiet secondary line: the recipe origin layer, or the manifest content
	// digest. Absent when there is no second fact to carry.
	detail?: string;
	// The unabbreviated detail, when detail is a shortened form (the full digest
	// behind shortDigest). Absent otherwise.
	detailTitle?: string;
}

// The execution-identity blocks for a row, ordered recipe then manifest, empty
// when the row carries no execution identity (foreground rows, direct background
// runs with no recipe/manifest binding, older servers) so the topology shows just
// the agent blocks. The recipe origin and the content digest ride their block as
// the quiet detail line, keeping the topology to one block per execution entity.
export function identityBlockViews(row: LiveActivityRow): IdentityBlockView[] {
	if (row.source !== "background" || !row.execution) return [];
	const ex = row.execution;
	const blocks: IdentityBlockView[] = [];
	if (ex.recipe) {
		blocks.push({
			kind: "recipe",
			label: "recipe",
			value: ex.recipe.id,
			...(ex.recipe.origin && { detail: ex.recipe.origin }),
		});
	}
	if (ex.manifestPath || ex.manifestDigest) {
		const block: IdentityBlockView = ex.manifestPath
			? {
					kind: "manifest",
					label: "manifest",
					value: manifestName(ex.manifestPath),
					title: ex.manifestPath,
				}
			: // Digest-only binding (no path): the digest IS the block's value, so it is
				// not repeated as a detail below.
				{
					kind: "manifest",
					label: "manifest",
					value: shortDigest(ex.manifestDigest as string),
					title: ex.manifestDigest,
				};
		// The content digest rides the manifest block as its secondary line when a
		// path already names the block, identifying the bytes the path was bound to
		// with the full digest on hover.
		if (ex.manifestPath && ex.manifestDigest) {
			block.detail = shortDigest(ex.manifestDigest);
			block.detailTitle = ex.manifestDigest;
		}
		blocks.push(block);
	}
	return blocks;
}

// A compact iteration label from the structured counters the hosts now report
// (iteration / maxIterations, plus iterationsCompleted for background loops).
// Never parses statusLine: a row without structured counters (a one-shot
// background run, an older server) yields no label rather than a fabricated one.
export function iterationLabel(row: LiveActivityRow): string | undefined {
	if (row.iteration !== undefined) {
		return row.maxIterations !== undefined
			? `iter ${row.iteration}/${row.maxIterations}`
			: `iter ${row.iteration}`;
	}
	if (row.source === "background" && row.iterationsCompleted !== undefined) {
		return `${row.iterationsCompleted} done`;
	}
	return undefined;
}

// One drawable entry of the foreground current-iteration phase timeline:
// completed phases in order plus at most one trailing active entry, each with
// its formatted duration. Empty when the row carries no timeline (background
// rows, older servers, the pre-phase spin-up) so the detail renders nothing.
export interface PhaseTimelineEntry {
	// Stable render identity. The timeline is append-only within an iteration
	// (entries never reorder), so position+name is a sound key even when a phase
	// name repeats.
	key: string;
	phase: string;
	elapsed: string;
	active: boolean;
}

export function phaseTimeline(row: LiveActivityRow): PhaseTimelineEntry[] {
	if (row.source !== "foreground" || !row.phases) return [];
	return row.phases.map((p, i) => ({
		key: `${i}-${p.phase}`,
		phase: p.phase,
		elapsed: formatAge(p.elapsedMs),
		active: p.status === "active",
	}));
}

// One drawable line of the selected run's recent-event tail: a formatted age
// plus the host-built privacy-safe label, ready to render verbatim.
export interface EventTailEntry {
	// Stable render identity. The tail is append-only on the wire (the host
	// evicts from the front only past its 50-entry cap -- MAX_LIVE_EVENTS), so
	// the absolute wire position plus the kind is a sound key even when a label
	// repeats; an entry keeps its key as newer events append.
	key: string;
	age: string;
	label: string;
	kind: LiveEventKind;
}

// How many tail entries the detail draws. The wire tail is already bounded
// host-side; this is the smaller "what is it doing right now" slice -- the
// newest few lines, not a transcript.
export const EVENT_TAIL_DRAW_LIMIT = 8;

// The bounded drawable tail for a row, oldest first (the wire order), so the
// section reads top-to-bottom toward the newest event. Empty when the row
// carries no tail (background one-shots before their first event, older
// servers) so the detail renders nothing rather than an empty frame.
export function eventTail(row: LiveActivityRow): EventTailEntry[] {
	const events = row.recentEvents ?? [];
	const start = Math.max(0, events.length - EVENT_TAIL_DRAW_LIMIT);
	return events.slice(start).map((e, i) => ({
		key: `${start + i}-${e.kind}`,
		age: formatAge(e.ageMs),
		label: e.label,
		kind: e.kind,
	}));
}

// Budget-relative warmth for the current phase: "warm" once the phase has
// consumed 70% or more of the per-call timeout that bounds it. When either
// number is missing or invalid the budget is unknown, and the safe answer is no
// treatment at all -- never a guess.
export function budgetWarmth(
	phaseElapsedMs: number | undefined,
	callTimeoutMs: number | undefined,
): "warm" | undefined {
	if (phaseElapsedMs === undefined || !Number.isFinite(phaseElapsedMs) || phaseElapsedMs < 0) {
		return undefined;
	}
	if (callTimeoutMs === undefined || !Number.isFinite(callTimeoutMs) || callTimeoutMs <= 0) {
		return undefined;
	}
	return phaseElapsedMs / callTimeoutMs >= 0.7 ? "warm" : undefined;
}

// Age metrics shown for the selected run, kept timing-oriented: total elapsed
// for both sources, plus the worker heartbeat for background rows (the liveness
// signal a durable job actually has). The foreground last-activity age tracked
// the phase timing closely enough to be redundant, and the current-phase
// elapsed lives on the active agent block (agentBlockViews) instead of a
// separate PHASE metric.
export function detailAges(row: LiveActivityRow): Array<[string, number | undefined]> {
	if (row.source === "foreground") return [["elapsed", row.elapsedMs]];
	return [
		["elapsed", row.elapsedMs],
		["heartbeat", row.lastHeartbeatAgeMs],
	];
}

// Which body the live overlay should render. "grid" is the normal live view.
// When no rows are live we keep the console visible IF it holds entries,
// so the final transition (the "disappeared" line the operator came to see)
// stays readable until the next reopen clears the session; with no prior
// activity there is nothing to keep, so the overlay stays calm and minimal.
export type LiveBody = "empty" | "empty-with-console" | "grid";

export function liveBody(activity: LiveActivity, logCount: number): LiveBody {
	if (flattenRows(activity).length > 0) return "grid";
	return logCount > 0 ? "empty-with-console" : "empty";
}

// --- Selected-run actions (pure helpers) ---

// Whether the selected run offers a real Cancel action. Only background jobs do:
// the CLI host owns JobStore and can signal a background worker. A foreground row
// is a cross-process mirror Studio does not control, so it gets the copy-only
// strip and no cancel button (the server would refuse a foreground cancel anyway).
export function cancelAvailable(row: LiveActivityRow): boolean {
	return row.source === "background";
}

// A background cancel intent that is already in flight: the worker is winding down
// (phase `cancelling`). The action is shown disabled rather than re-fired, so the
// operator sees the intent landed without spamming duplicate requests.
export function cancelPending(row: LiveActivityRow): boolean {
	return row.source === "background" && row.phase === "cancelling";
}

// The compact, calm feedback line for a cancel outcome. No stack traces or raw
// bodies in the rail: a requested cancel that signaled a live worker vs. one that
// only persisted intent (no live worker) read differently, a finished run reports
// its state, and failures collapse to a short status note.
export function cancelMessage(outcome: LiveCancelOutcome): string {
	switch (outcome.kind) {
		case "requested":
			return outcome.signaled ? "cancel requested" : "cancel requested · no live worker";
		case "already-finished":
			return `already ${outcome.state}`;
		case "not-found":
			return "run no longer live";
		case "error":
			return `cancel failed · ${outcome.status}`;
	}
}

// One console line derived from a transition between snapshots, before the hook
// stamps it with a time and a key.
export interface LiveTransition {
	runId: string;
	source: "foreground" | "background";
	text: string;
}

// Console-worthy transitions between two live snapshots. Pure and clock-free.
// We log only meaningful state changes -- a row appearing, disappearing, or
// changing its phase/display -- and deliberately NOT every heartbeat-age tick,
// which updates on each poll and would bury the real signal. A null `prev`
// (first poll, or the first poll after the monitor reopens) establishes a
// silent baseline so opening the panel never spams the console with the set of
// runs that were already alive.
export function diffActivity(prev: LiveActivity | null, next: LiveActivity): LiveTransition[] {
	const out: LiveTransition[] = [];
	if (prev === null) return out;
	const prevByKey = new Map(flattenRows(prev).map((r) => [rowKey(r), r]));
	const nextRows = flattenRows(next);
	const nextKeys = new Set(nextRows.map(rowKey));
	for (const row of nextRows) {
		const before = prevByKey.get(rowKey(row));
		if (!before) {
			out.push({ runId: row.runId, source: row.source, text: `appeared · ${phaseLabel(row)}` });
			continue;
		}
		const a = phaseLabel(before);
		const b = phaseLabel(row);
		if (a !== b) out.push({ runId: row.runId, source: row.source, text: `${a} → ${b}` });
	}
	for (const row of flattenRows(prev)) {
		if (!nextKeys.has(rowKey(row))) {
			out.push({ runId: row.runId, source: row.source, text: "disappeared" });
		}
	}
	return out;
}
