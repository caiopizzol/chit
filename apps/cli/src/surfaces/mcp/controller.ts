import type { JobStore } from "../../jobs/store.ts";
import type { JobRecord } from "../../jobs/types.ts";
import { type ControlledRun, type ControllerStore, runIdOf } from "./controller-store.ts";
import type { ConvergeSession } from "./converge-engine.ts";
import type { Run } from "./engine.ts";

// The unified run controller. ONE public id — run_id — resolves to a run wherever
// it lives: a foreground run supervised by this MCP session (held in the merged
// ControllerStore: a one-shot DAG Run or a loop ConvergeSession), or a durable
// background run that survives a reconnect (a JobRecord in the JobStore, keyed by
// run_id == jobId). The controller speaks ONLY run_id: it never accepts or
// returns a loopId or jobId as the caller's handle. Internal identifiers (the
// loop-log key, the job's audit refs) live behind run_id. This is the seam the
// old tools adapt INTO (their legacy loop_id/job_id value is passed as run_id),
// and the seam the unified chit_start/next/cancel/trace/status are built on.

// Where a run_id resolves and how durable it is. "foreground" = supervised by
// this server process (in-memory; a fresh server has none). "background" =
// durable across reconnect.
export type ResolvedRun =
	| { mode: "foreground"; run: ControlledRun }
	| { mode: "background"; job: JobRecord };

export class RunController {
	constructor(
		private readonly store: ControllerStore,
		private readonly jobs: JobStore,
	) {}

	// --- foreground registration (the old chit_run_start / chit_converge_start) ---

	registerOneShot(run: Run, now: number): string {
		this.store.add({ kind: "one-shot", run }, now);
		return run.runId;
	}

	registerLoop(session: ConvergeSession, now: number): string {
		this.store.add({ kind: "loop", session }, now);
		return session.loopId;
	}

	// --- run_id resolution (the heart of the contract) ---

	// Resolve a run_id to its live representation, checking the foreground store
	// first (supervised this session), then the durable JobStore (background,
	// keyed by run_id == jobId). Undefined if no run by this id exists anywhere —
	// which, for a foreground id, includes "this is a fresh server that never saw
	// it" (foreground runs are not durable, by design).
	resolve(runId: string, now: number): ResolvedRun | undefined {
		const fg = this.store.get(runId, now);
		if (fg) return { mode: "foreground", run: fg };
		const job = this.jobs.get(runId);
		if (job) return { mode: "background", job };
		return undefined;
	}

	// Typed foreground getters for the stepwise/converge tool handlers, which act
	// only on their own kind. Return undefined for an absent id OR an id of the
	// other kind (a chit_run_step on a loop run_id is not a one-shot run).
	getOneShot(runId: string, now: number): Run | undefined {
		const c = this.store.get(runId, now);
		return c?.kind === "one-shot" ? c.run : undefined;
	}

	getLoop(runId: string, now: number): ConvergeSession | undefined {
		const c = this.store.get(runId, now);
		return c?.kind === "loop" ? c.session : undefined;
	}

	// Refresh a foreground run's idle timer (after a step/iteration settles).
	touch(runId: string, now: number): void {
		this.store.touch(runId, now);
	}

	// Evict idle foreground runs (opportunistic, on start). Returns evicted ids.
	sweep(now: number): string[] {
		return this.store.sweep(now);
	}

	// All foreground runs (for the status overview), read-only.
	foregroundRuns(): ControlledRun[] {
		return this.store.list();
	}
}

export { runIdOf };
