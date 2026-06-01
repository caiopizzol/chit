import type { Run } from "./engine.ts";

// Holds active MCP runs plus an idle-eviction policy. Lives apart from server.ts
// so the sweep is unit-testable without booting the stdio server (importing
// server.ts runs its top-level server.connect). The in-memory run map would
// otherwise grow without bound (every chit_run_start adds; nothing removed).
//
// Eviction is IDLE-based, not age-based: a run is touched on create, on every
// successful lookup, and again after a step settles (a multi-minute step's
// lookup-touch is stale by the time it finishes). sweep() drops only runs idle
// past the TTL that have NO still-running step — so a long in-flight run is
// never evicted out from under chit_run_cancel/chit_run_next/chit_run_trace. Sweeping is
// opportunistic (called on chit_run_start), so memory is bounded by future starts,
// not wall-clock alone. `now` is passed in to keep the logic pure/testable.

const ONE_HOUR_MS = 60 * 60 * 1000;

export class RunStore {
	private readonly runs = new Map<string, Run>();
	private readonly lastTouched = new Map<string, number>();

	constructor(private readonly ttlMs: number = ONE_HOUR_MS) {}

	add(run: Run, now: number): void {
		this.runs.set(run.runId, run);
		this.lastTouched.set(run.runId, now);
	}

	// Fetch a run and refresh its idle timer. Undefined if absent (or evicted).
	get(runId: string, now: number): Run | undefined {
		const run = this.runs.get(runId);
		if (run) this.lastTouched.set(runId, now);
		return run;
	}

	// Refresh the idle timer without fetching — used after a step settles, so a
	// long-running step that finishes just past the TTL is not swept immediately.
	touch(runId: string, now: number): void {
		if (this.runs.has(runId)) this.lastTouched.set(runId, now);
	}

	// All current runs, in insertion (creation) order. Read-only: chit_status
	// enumerates live runs through this WITHOUT touching idle timers, so a status
	// poll never keeps a run alive (that would defeat idle eviction).
	list(): Run[] {
		return [...this.runs.values()];
	}

	// Evict runs idle longer than the TTL that have no running step. Returns the
	// evicted run ids. Deletes from both maps so no timestamp leaks.
	sweep(now: number): string[] {
		const evicted: string[] = [];
		for (const [runId, run] of this.runs) {
			const idleMs = now - (this.lastTouched.get(runId) ?? now);
			if (idleMs <= this.ttlMs) continue;
			const hasRunningStep = Object.values(run.records).some((r) => r.status === "running");
			if (hasRunningStep) continue;
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
