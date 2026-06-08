// Pure, clock-free helpers for the live monitor. Selection identity, row
// flattening, age formatting, and the snapshot diff that feeds the console all
// live here so they can be unit-tested without React or a polling timer. The
// hook (useLive) owns the network, the timer, and the wall-clock stamp; this
// module only transforms data it is handed.

import type { LiveActivity, LiveActivityRow } from "../server/types.ts";

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
