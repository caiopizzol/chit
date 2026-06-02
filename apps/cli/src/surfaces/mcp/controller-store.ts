import type { ConvergeSession } from "./converge-engine.ts";
import type { Run } from "./engine.ts";

// The merged in-memory store of FOREGROUND runs, keyed by the one public id:
// run_id. It replaces the separate RunStore + ConvergeStore (which were the same
// shape with different "is busy" predicates). A foreground run is either a
// one-shot DAG run (the old stepwise Run) or a loop run (a ConvergeSession);
// background runs are NOT held here (they live durably in the JobStore, keyed by
// run_id == jobId, and survive a reconnect). This is where "foreground means this
// MCP session is supervising it" is realized: a fresh server starts empty.
//
// Eviction mirrors the old stores exactly: IDLE-based, opportunistic (swept on
// each start), never evicting a run with in-flight work (a running step, or a
// loop iteration in flight). `now` is injected to keep the logic pure/testable.

export type ControlledRun =
	| { kind: "one-shot"; run: Run }
	| { kind: "loop"; session: ConvergeSession };

// The public run id for a controlled run. one-shot keys on the Run's id; loop
// keys on the ConvergeSession's loop id. Both ARE the run_id at the public layer
// (loopId is internal naming that predates the unified contract).
export function runIdOf(c: ControlledRun): string {
	return c.kind === "one-shot" ? c.run.runId : c.session.loopId;
}

// Whether a controlled run has work in flight, so the sweep never evicts it out
// from under an in-progress step/iteration.
function isBusy(c: ControlledRun): boolean {
	return c.kind === "one-shot"
		? Object.values(c.run.records).some((r) => r.status === "running")
		: c.session.active !== undefined;
}

const ONE_HOUR_MS = 60 * 60 * 1000;

export class ControllerStore {
	private readonly runs = new Map<string, ControlledRun>();
	private readonly lastTouched = new Map<string, number>();

	constructor(private readonly ttlMs: number = ONE_HOUR_MS) {}

	add(c: ControlledRun, now: number): void {
		const id = runIdOf(c);
		this.runs.set(id, c);
		this.lastTouched.set(id, now);
	}

	// Fetch a controlled run and refresh its idle timer. Undefined if absent.
	get(runId: string, now: number): ControlledRun | undefined {
		const c = this.runs.get(runId);
		if (c) this.lastTouched.set(runId, now);
		return c;
	}

	// Refresh the idle timer without fetching — used after a step/iteration
	// settles, so a long unit that finishes just past the TTL is not swept
	// immediately.
	touch(runId: string, now: number): void {
		if (this.runs.has(runId)) this.lastTouched.set(runId, now);
	}

	// All current foreground runs, in insertion order. Read-only: status
	// enumerates through this WITHOUT touching idle timers, so a status poll never
	// keeps a run alive (that would defeat idle eviction).
	list(): ControlledRun[] {
		return [...this.runs.values()];
	}

	// Evict runs idle longer than the TTL that have no in-flight work. Returns the
	// evicted run ids. Deletes from both maps so no timestamp leaks.
	sweep(now: number): string[] {
		const evicted: string[] = [];
		for (const [runId, c] of this.runs) {
			const idleMs = now - (this.lastTouched.get(runId) ?? now);
			if (idleMs <= this.ttlMs) continue;
			if (isBusy(c)) continue;
			this.runs.delete(runId);
			this.lastTouched.delete(runId);
			evicted.push(runId);
		}
		return evicted;
	}

	get size(): number {
		return this.runs.size;
	}
}
