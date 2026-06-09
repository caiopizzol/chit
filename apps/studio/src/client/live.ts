// Pure, clock-free helpers for the live monitor. Selection identity, row
// flattening, age formatting, the selected-run detail shaping (ages, agent
// blocks, iteration hint), and the snapshot diff that feeds the console all
// live here so they can be unit-tested without React or a polling timer. The
// hook (useLive) owns the network, the timer, and the wall-clock stamp; this
// module only transforms data it is handed.

import type { LiveActivity, LiveActivityRow } from "../server/types.ts";
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
	}));
	if (active === "checks" && !views.some((v) => v.live)) {
		views.push({
			role: "checks",
			agentId: "chit",
			adapter: "required checks",
			live: true,
		});
	}
	if (row.phaseElapsedMs !== undefined) {
		const live = views.find((v) => v.live);
		if (live) live.phaseElapsed = formatAge(row.phaseElapsedMs);
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

// A compact iteration hint derived from the statusLine every chit surface
// already composes ("iteration N · ..."). Parsing the existing line keeps the
// wire type unchanged; a statusLine without an iteration count (a one-shot
// background run) yields no hint rather than a fabricated one.
export function iterationHint(row: LiveActivityRow): string | undefined {
	const m = /\biteration (\d+)\b/.exec(row.statusLine);
	return m ? `iter ${m[1]}` : undefined;
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
