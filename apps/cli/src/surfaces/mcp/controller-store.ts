import type { ConvergeSession } from "./converge-engine.ts";
import type { Run } from "./engine.ts";

// The merged in-memory store of FOREGROUND runs. It replaces the separate
// RunStore + ConvergeStore (the same shape with different "is busy" predicates)
// with ONE class, ONE idle-eviction sweep, and ONE list for the status overview.
// Background runs are NOT held here (they live durably in the JobStore, keyed by
// run_id == jobId, and survive a reconnect). This is where "foreground means this
// MCP session is supervising it" is realized: a fresh server starts empty.
//
// Entries are kept in KIND-SEGREGATED slots (one-shot vs loop) rather than a
// single run_id-keyed map. Stage 3 is a pure refactor: the legacy chit_run_* and
// chit_converge_* tools still take separate run_id / loop_id params, and the old
// two-store world let the SAME id exist as both a run and a loop. Segregating by
// kind preserves that exactly (no silent overwrite) and keeps a wrong-kind lookup
// from touching the other kind's idle timer. The unified surface (Stage 4)
// collapses to one id space, where chit_start generates the id and that quirk
// cannot arise.
//
// Eviction mirrors the old stores: IDLE-based, opportunistic (swept on each
// start), never evicting a run with in-flight work (a running step, or a loop
// iteration in flight). `now` is injected to keep the logic pure/testable.

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

interface Entry {
	c: ControlledRun;
	touched: number;
}

export class ControllerStore {
	// Two slots keyed by id, so a one-shot run and a loop with the same id coexist
	// (as in the old two stores) and a lookup only ever touches its own kind.
	private readonly oneShot = new Map<string, Entry>();
	private readonly loops = new Map<string, Entry>();

	constructor(private readonly ttlMs: number = ONE_HOUR_MS) {}

	private slot(kind: ControlledRun["kind"]): Map<string, Entry> {
		return kind === "one-shot" ? this.oneShot : this.loops;
	}

	add(c: ControlledRun, now: number): void {
		this.slot(c.kind).set(runIdOf(c), { c, touched: now });
	}

	// Kind-specific lookups: touch ONLY the matching kind's entry, so e.g. a
	// chit_run_next called with a loop's id finds nothing and refreshes nothing.
	getOneShot(runId: string, now: number): Run | undefined {
		const e = this.oneShot.get(runId);
		if (!e) return undefined;
		e.touched = now;
		return e.c.kind === "one-shot" ? e.c.run : undefined;
	}

	getLoop(runId: string, now: number): ConvergeSession | undefined {
		const e = this.loops.get(runId);
		if (!e) return undefined;
		e.touched = now;
		return e.c.kind === "loop" ? e.c.session : undefined;
	}

	// Resolve by id across kinds (for the unified run_id contract), touching the
	// found entry. One-shot wins a same-id tie; a tie only arises from the legacy
	// dual-id quirk and disappears under the unified surface.
	find(runId: string, now: number): ControlledRun | undefined {
		const o = this.oneShot.get(runId);
		if (o) {
			o.touched = now;
			return o.c;
		}
		const l = this.loops.get(runId);
		if (l) {
			l.touched = now;
			return l.c;
		}
		return undefined;
	}

	// Refresh a one-shot run's idle timer without fetching (after a step settles).
	// Kind-specific so it never touches a same-id loop (per-kind isolation, as the
	// old separate RunStore.touch did).
	touchOneShot(runId: string, now: number): void {
		const e = this.oneShot.get(runId);
		if (e) e.touched = now;
	}

	// Refresh a loop's idle timer without fetching (after an iteration settles).
	touchLoop(runId: string, now: number): void {
		const e = this.loops.get(runId);
		if (e) e.touched = now;
	}

	// All current foreground runs (both kinds), for the status overview and sweep.
	// Read-only: status enumerates through this WITHOUT touching idle timers.
	list(): ControlledRun[] {
		return [...this.oneShot.values(), ...this.loops.values()].map((e) => e.c);
	}

	// Evict idle, non-busy runs. Kind-specific so chit_run_start sweeps only
	// one-shot runs and chit_converge_start only loops, matching the old separate
	// RunStore / ConvergeStore (a one-shot start never evicts an idle loop, and
	// vice versa).
	sweepOneShot(now: number): string[] {
		return this.sweepSlot(this.oneShot, now);
	}

	sweepLoops(now: number): string[] {
		return this.sweepSlot(this.loops, now);
	}

	private sweepSlot(slot: Map<string, Entry>, now: number): string[] {
		const evicted: string[] = [];
		for (const [id, e] of slot) {
			if (now - e.touched <= this.ttlMs) continue;
			if (isBusy(e.c)) continue;
			slot.delete(id);
			evicted.push(id);
		}
		return evicted;
	}

	get size(): number {
		return this.oneShot.size + this.loops.size;
	}
}
