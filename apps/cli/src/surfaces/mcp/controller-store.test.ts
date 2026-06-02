import { describe, expect, test } from "bun:test";
import { type ControlledRun, ControllerStore } from "./controller-store.ts";
import type { ConvergeSession } from "./converge-engine.ts";
import type { Run } from "./engine.ts";

const HOUR = 60 * 60 * 1000;

// The merged store reads only the busy predicate inputs: a one-shot run's
// records[].status, and a loop session's `active`. Minimal casts suffice. This
// ports the idle-eviction coverage from the old RunStore + ConvergeStore tests
// onto the single store, exercising BOTH kinds' "busy" predicates.
function oneShot(runId: string, opts: { running?: boolean } = {}): ControlledRun {
	return {
		kind: "one-shot",
		run: {
			runId,
			records: { s: { stepId: "s", kind: "call", status: opts.running ? "running" : "done" } },
		} as unknown as Run,
	};
}
function loop(loopId: string, opts: { active?: boolean } = {}): ControlledRun {
	return {
		kind: "loop",
		session: {
			loopId,
			...(opts.active && { active: new AbortController() }),
		} as unknown as ConvergeSession,
	};
}

describe("ControllerStore idle eviction (merged run + converge)", () => {
	test("sweepOneShot retains a run within the idle TTL", () => {
		const s = new ControllerStore(HOUR);
		s.add(oneShot("a"), 0);
		expect(s.sweepOneShot(30 * 60 * 1000)).toEqual([]);
		expect(s.size).toBe(1);
	});

	test("sweepOneShot evicts an idle run past the TTL, from both maps", () => {
		const s = new ControllerStore(HOUR);
		s.add(oneShot("a"), 0);
		expect(s.sweepOneShot(2 * HOUR)).toEqual(["a"]);
		expect(s.size).toBe(0);
		expect(s.find("a", 2 * HOUR)).toBeUndefined();
		expect(s.sweepOneShot(3 * HOUR)).toEqual([]); // timestamp deleted too
	});

	test("never evicts a one-shot run with a running step, even when long idle", () => {
		const s = new ControllerStore(HOUR);
		s.add(oneShot("a", { running: true }), 0);
		expect(s.sweepOneShot(5 * HOUR)).toEqual([]);
		expect(s.size).toBe(1);
	});

	test("never evicts a loop with an in-flight iteration (session.active), even when long idle", () => {
		const s = new ControllerStore(HOUR);
		s.add(loop("l", { active: true }), 0);
		expect(s.sweepLoops(5 * HOUR)).toEqual([]);
		expect(s.size).toBe(1);
	});

	test("sweepLoops evicts an idle loop with no in-flight iteration", () => {
		const s = new ControllerStore(HOUR);
		s.add(loop("l"), 0);
		expect(s.sweepLoops(2 * HOUR)).toEqual(["l"]);
		expect(s.size).toBe(0);
	});

	test("sweep is per-kind: a one-shot sweep never evicts an idle loop, and vice versa", () => {
		const s = new ControllerStore(HOUR);
		s.add(oneShot("run-idle"), 0);
		s.add(loop("loop-idle"), 0);
		// chit_run_start's sweep touches only one-shot runs...
		expect(s.sweepOneShot(2 * HOUR)).toEqual(["run-idle"]);
		expect(s.size).toBe(1); // the idle loop survives (size doesn't touch)
		// ...and chit_converge_start's sweep touches only loops.
		expect(s.sweepLoops(2 * HOUR)).toEqual(["loop-idle"]);
		expect(s.size).toBe(0);
	});

	test("getOneShot refreshes the idle timer (touch on lookup)", () => {
		const s = new ControllerStore(HOUR);
		s.add(oneShot("a"), 0);
		s.getOneShot("a", 50 * 60 * 1000); // touched at 50min
		expect(s.sweepOneShot(90 * 60 * 1000)).toEqual([]); // idle only 40min
	});

	test("touchOneShot() refreshes without fetching (long unit settling)", () => {
		const s = new ControllerStore(HOUR);
		s.add(oneShot("a"), 0);
		s.touchOneShot("a", 2 * HOUR);
		expect(s.sweepOneShot(2 * HOUR + 30 * 60 * 1000)).toEqual([]);
		s.touchOneShot("a", 2 * HOUR + 30 * 60 * 1000);
		expect(s.sweepOneShot(2 * HOUR + 30 * 60 * 1000 + 2 * HOUR)).toEqual(["a"]);
	});

	test("touchOneShot() on an unknown run is a no-op", () => {
		const s = new ControllerStore(HOUR);
		s.touchOneShot("ghost", 0);
		expect(s.size).toBe(0);
	});

	test("touchOneShot on a shared id does not refresh the same-id loop", () => {
		const s = new ControllerStore(HOUR);
		s.add(oneShot("same"), 0);
		s.add(loop("same"), 0);
		s.touchOneShot("same", 90 * 60 * 1000); // refreshes ONLY the one-shot
		// The loop (last touched at 0) is past TTL; the one-shot (touched at 90m) is not.
		expect(s.sweepLoops(2 * HOUR)).toEqual(["same"]);
		expect(s.sweepOneShot(2 * HOUR)).toEqual([]);
		expect(s.getOneShot("same", 2 * HOUR)?.runId).toBe("same");
	});

	test("touchLoop on a shared id does not refresh the same-id one-shot", () => {
		const s = new ControllerStore(HOUR);
		s.add(oneShot("same"), 0);
		s.add(loop("same"), 0);
		s.touchLoop("same", 90 * 60 * 1000); // refreshes ONLY the loop
		expect(s.sweepOneShot(2 * HOUR)).toEqual(["same"]); // the one-shot evicts
		expect(s.sweepLoops(2 * HOUR)).toEqual([]); // the loop survives
		expect(s.getLoop("same", 2 * HOUR)?.loopId).toBe("same");
	});

	test("a one-shot run and a loop with the SAME id coexist (no silent overwrite)", () => {
		// The legacy tools take separate run_id / loop_id, and the old two stores
		// let the same id be both. Kind-segregated slots preserve that.
		const s = new ControllerStore(HOUR);
		s.add(oneShot("same"), 0);
		s.add(loop("same"), 0);
		expect(s.size).toBe(2);
		expect(s.getOneShot("same", 0)?.runId).toBe("same");
		expect(s.getLoop("same", 0)?.loopId).toBe("same");
	});

	test("a wrong-kind lookup finds nothing and refreshes nothing", () => {
		// chit_run_next called with a LOOP's id must not keep that loop alive.
		const s = new ControllerStore(HOUR);
		s.add(loop("l"), 0);
		expect(s.getOneShot("l", 50 * 60 * 1000)).toBeUndefined(); // wrong kind
		// The loop's idle timer was NOT refreshed by the wrong-kind lookup, so it
		// still evicts on schedule.
		expect(s.sweepLoops(2 * HOUR)).toEqual(["l"]);
	});
});
