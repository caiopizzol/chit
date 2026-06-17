// The canonical run-state read model. ps, status, and wait all read a run's
// state through HERE, so the machine contract is defined once instead of each
// command scraping receipts and live entries its own way.
//
// State is derived only from durable evidence already on disk: the receipt (a
// finished run), the live registry entry + process aliveness (an active run),
// and the lifecycle events (ready/failed). The events are progress (human text),
// ready, failed, and done -- so the phase distinguishes "accepted its origin and
// is working" (ready) from "still starting", but never guesses a per-step position
// from the human progress lines. The terminal `done` event mirrors the receipt for a
// follower of the event stream; this read model takes the receipt as authoritative, so
// it does not read `done`.

import { type RunEvent, readRunEvents } from "./events.ts";
import { type LiveProcess, type LiveRun, loadLiveRun, realLiveProcess } from "./live.ts";
import { type AnyReceipt, type PatchStatus, patchStatus, tryLoadReceipt } from "./store.ts";

// The union of every receipt's terminal status.
export type ReceiptStatus = AnyReceipt["status"];

// The lifecycle phase, derived from structured signals only:
//   starting   registered, process alive, has not signalled `ready` yet
//   running    registered, process alive, `ready` seen (origin accepted, working)
//   finished   a receipt exists (terminal); `status` carries the outcome
//   orphaned   no receipt, but the run's process is gone (crashed/force-killed)
export type RunPhase = "starting" | "running" | "finished" | "orphaned";

export interface RunState {
	runId: string;
	// Absent only for an unknown id surfaced by `wait` (no live entry, no receipt).
	routineId?: string;
	phase: RunPhase;
	// True once nothing more will change: a receipt was written, or the process is gone.
	done: boolean;
	startedAt: number;
	// finished: the receipt's exact elapsed. live/orphaned: now - startedAt.
	elapsedMs: number;
	// Present iff a receipt exists.
	status?: ReceiptStatus;
	// The exit code `chit wait` would return for this run. Present iff done.
	exitCode?: number;
	scope?: string;
	// Present iff a receipt exists.
	digest?: string;
	// Present iff a live entry is known (active or orphaned).
	pid?: number;
	cwd?: string;
	// A sandboxed run's pinned origin commit.
	baseCommit?: string;
	// A finished sandboxed run's stored-patch lifecycle (omitted when there is no patch).
	patch?: PatchStatus;
	// Set once Chit recorded applying this run's patch to the tree.
	applied?: boolean;
	applyError?: string;
	// Failure detail: a failed/cancelled receipt's error, a startup failure, or an orphan note.
	error?: string;
}

function sawReady(events: RunEvent[]): boolean {
	return events.some((e) => e.kind === "ready");
}

function startupError(events: RunEvent[]): string | undefined {
	for (const e of events) if (e.kind === "failed") return e.error;
	return undefined;
}

// The exit code a terminal run resolves to (what `chit wait` returns). Cancelled is 130;
// a converged-but-could-not-apply run is a failure; otherwise the per-policy success status.
export function receiptExitCode(receipt: AnyReceipt): number {
	if (receipt.status === "cancelled") return 130;
	if ("applyError" in receipt && receipt.applyError !== undefined) return 1;
	if (receipt.policy === "converge") return receipt.status === "converged" ? 0 : 1;
	return receipt.status === "completed" ? 0 : 1;
}

// State for an active run, built from its live entry and events. Used directly by `ps`
// (which already holds the live entries) and by readRunState's live branch.
export function liveRunState(run: LiveRun, events: RunEvent[], now: number): RunState {
	return {
		runId: run.runId,
		routineId: run.routineId,
		phase: sawReady(events) ? "running" : "starting",
		done: false,
		startedAt: run.startedAt,
		elapsedMs: now - run.startedAt,
		pid: run.pid,
		cwd: run.cwd,
	};
}

function finishedRunState(receipt: AnyReceipt, patch: PatchStatus): RunState {
	const baseCommit = "baseCommit" in receipt ? receipt.baseCommit : undefined;
	const appliedAt = "appliedAt" in receipt ? receipt.appliedAt : undefined;
	const applyError = "applyError" in receipt ? receipt.applyError : undefined;
	const error = "error" in receipt ? receipt.error : undefined;
	return {
		runId: receipt.runId,
		routineId: receipt.routineId,
		phase: "finished",
		done: true,
		status: receipt.status,
		exitCode: receiptExitCode(receipt),
		startedAt: receipt.startedAt,
		elapsedMs: receipt.elapsedMs,
		...(receipt.scope !== undefined && { scope: receipt.scope }),
		digest: receipt.digest,
		...(baseCommit !== undefined && { baseCommit }),
		// "none" is the no-patch case (not a sandboxed run, or it produced nothing) -- omit it.
		...(patch !== "none" && { patch }),
		...(appliedAt !== undefined && { applied: true }),
		...(applyError !== undefined && { applyError }),
		...(error !== undefined && { error }),
	};
}

// Build finished state from a receipt already in hand, computing its patch status. `wait` holds
// the receipt it polled for and must always emit one final state, so it uses this directly.
export async function finishedStateFromReceipt(cwd: string, receipt: AnyReceipt): Promise<RunState> {
	const baseCommit = "baseCommit" in receipt ? receipt.baseCommit : undefined;
	const appliedAt = "appliedAt" in receipt ? receipt.appliedAt : undefined;
	return finishedRunState(receipt, await patchStatus(cwd, receipt.runId, baseCommit, appliedAt));
}

function orphanedRunState(run: LiveRun, events: RunEvent[], now: number): RunState {
	return {
		runId: run.runId,
		routineId: run.routineId,
		phase: "orphaned",
		done: true,
		exitCode: 1,
		startedAt: run.startedAt,
		elapsedMs: now - run.startedAt,
		pid: run.pid,
		cwd: run.cwd,
		error: startupError(events) ?? "the run process exited without writing a receipt",
	};
}

// Read one run's canonical state. A receipt (terminal) wins over a live entry; an alive
// process with no receipt is starting/running; a dead process with no receipt is orphaned.
// Returns undefined for an unknown id (no receipt and no live entry).
export async function readRunState(
	cwd: string,
	runId: string,
	opts: { now: number; process?: LiveProcess },
): Promise<RunState | undefined> {
	const proc = opts.process ?? realLiveProcess;
	const receipt = tryLoadReceipt(cwd, runId);
	if (receipt !== undefined) return finishedStateFromReceipt(cwd, receipt);
	const live = loadLiveRun(cwd, runId);
	if (live !== undefined) {
		const events = readRunEvents(cwd, runId);
		return proc.isAlive(live.pid) ? liveRunState(live, events, opts.now) : orphanedRunState(live, events, opts.now);
	}
	return undefined;
}
