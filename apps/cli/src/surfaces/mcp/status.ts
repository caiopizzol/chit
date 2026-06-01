// chit_status assembly: the read-only operator overview that answers "what is
// live in this MCP server right now, and what should I do next?" plus a compact
// "what recently finished" from the durable audit store. chit's MCP-native
// analogue to a workflows progress view, with no UI.
//
// Two sources with different lifetimes, joined here and kept distinct in the
// output:
//   - active: the in-memory run/converge stores. Per-server-process and
//     session-scoped: a new MCP server (a new Claude Code session) starts empty,
//     and idle runs are evicted. This is the controllable, live control plane.
//   - recent: the durable audit store (~/.local/state/chit/audit), which spans
//     processes and sessions. This is history, not control.
//
// Pure and side-effect-free BY DESIGN: it does NOT sweep or touch the in-memory
// stores. Touching on a status poll would keep runs alive forever (defeating
// idle eviction); sweeping would make a read destructive. Eviction stays tied to
// chit_start / chit_converge_start, where it belongs. The active sections read
// only in-memory state (no disk), so they never throw; only `recent` touches
// disk, via listAudit, which is already robust to a corrupt or mid-write log.

import { listAudit, type RunSummary } from "../../audit/reader.ts";
import type { AuditStore } from "../../audit/store.ts";
import { type ConvergeStatus, describeConverge } from "./converge-engine.ts";
import type { ConvergeStore } from "./converge-store.ts";
import { isComplete, type Run, readySteps } from "./engine.ts";
import type { RunStore } from "./run-store.ts";

// A compact per-run line for the overview. Deliberately omits the (possibly
// large) final output and per-step detail: drill into one run with chit_trace,
// or chit_audit_show when audited (the run id IS the audit run id).
export interface RunStatusSummary {
	run_id: string;
	manifest: string;
	complete: boolean;
	// Step ids ready to run now; empty when the run is complete.
	ready: string[];
	// True when this run is being audited cleanly, so chit_audit_show <run_id>
	// has a transcript. Mirrors chit_next's audit pointer.
	audited: boolean;
}

export function summarizeRunForStatus(run: Run): RunStatusSummary {
	const complete = isComplete(run);
	return {
		run_id: run.runId,
		manifest: run.manifest.id,
		complete,
		ready: complete ? [] : readySteps(run),
		audited: run.recorder !== undefined && run.recorder.lastError === undefined,
	};
}

export interface ChitStatus {
	active: {
		runs: RunStatusSummary[];
		loops: ConvergeStatus[];
	};
	recent: RunSummary[];
}

// Newest-first by start time. Sorting by startedAtMs (always set on both Run and
// ConvergeSession) is the truthful recency order and is robust to a reused id:
// converge can restart a loop_id with `force`, but Map#set keeps the original
// insertion slot, so a plain reverse-of-insertion-order would misorder the
// restarted loop. A copy keeps the sort from mutating the store's own array.
function byNewest<T extends { startedAtMs: number }>(items: T[]): T[] {
	return [...items].sort((a, b) => b.startedAtMs - a.startedAtMs);
}

// Read the durable recent slice defensively. A recentLimit of 0 means "none"
// (the tool's documented value), so skip the audit read entirely rather than
// enumerate+read every run only to slice to []. Otherwise an audit I/O failure
// (e.g. an unreadable audit dir, where listRuns()'s readdir throws) must NOT mask
// the active control plane, which is chit_status's primary answer: degrade recent
// to [] and let the dedicated chit_audit_list surface the error. listAudit is
// already robust to a single corrupt/mid-write run log; this guards the
// enumeration around it. The guard lives here, not in listAudit, so `chit audit
// list` still reports the failure loudly.
function recentRuns(auditStore: AuditStore, recentLimit: number): RunSummary[] {
	if (recentLimit === 0) return [];
	try {
		return listAudit(auditStore, recentLimit);
	} catch {
		return [];
	}
}

// Assemble the overview. `recentLimit` caps the durable history slice (newest
// first; 0 omits it). Active runs and loops are returned newest-first, and each
// loop reuses the SAME control-plane view as chit_converge_status, so the
// overview and the per-loop tool never disagree.
export function buildStatus(
	runs: RunStore,
	convergeSessions: ConvergeStore,
	auditStore: AuditStore,
	recentLimit: number,
): ChitStatus {
	return {
		active: {
			runs: byNewest(runs.list()).map(summarizeRunForStatus),
			loops: byNewest(convergeSessions.list()).map(describeConverge),
		},
		recent: recentRuns(auditStore, recentLimit),
	};
}
