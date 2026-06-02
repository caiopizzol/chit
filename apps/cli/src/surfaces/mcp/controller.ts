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
		const fg = this.store.find(runId, now);
		if (fg) return { mode: "foreground", run: fg };
		// A malformed run_id makes JobStore.get throw (its path guard rejects
		// traversal/unsafe ids); treat that as not-found so resolve never throws and
		// the caller reports a clean "unknown run_id" instead of leaking a store error.
		let job: ReturnType<JobStore["get"]>;
		try {
			job = this.jobs.get(runId);
		} catch {
			return undefined;
		}
		if (job) return { mode: "background", job };
		return undefined;
	}

	// Typed foreground getters for the stepwise/converge tool handlers, which act
	// only on their own kind. The store's kind-specific lookups touch ONLY that
	// kind's slot, so a chit_run_next called with a loop's id finds nothing and
	// refreshes nothing (and vice versa).
	getOneShot(runId: string, now: number): Run | undefined {
		return this.store.getOneShot(runId, now);
	}

	getLoop(runId: string, now: number): ConvergeSession | undefined {
		return this.store.getLoop(runId, now);
	}

	// Refresh a foreground run's idle timer after its unit settles. Kind-specific
	// so a same-id loop and one-shot never refresh each other (per-kind isolation).
	touchOneShot(runId: string, now: number): void {
		this.store.touchOneShot(runId, now);
	}

	touchLoop(runId: string, now: number): void {
		this.store.touchLoop(runId, now);
	}

	// Evict idle foreground runs (opportunistic, on start). Kind-specific so a
	// one-shot start sweeps only one-shot runs and a converge start only loops,
	// matching the old separate stores. Returns evicted ids.
	sweepOneShot(now: number): string[] {
		return this.store.sweepOneShot(now);
	}

	sweepLoops(now: number): string[] {
		return this.store.sweepLoops(now);
	}

	// All foreground runs (for the status overview), read-only.
	foregroundRuns(): ControlledRun[] {
		return this.store.list();
	}
}

export { runIdOf };
