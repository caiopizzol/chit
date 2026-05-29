import { describe, expect, test } from "bun:test";
import type { Run } from "./engine.ts";
import { RunStore } from "./run-store.ts";

const HOUR = 60 * 60 * 1000;

// The store only reads runId and records[].status, so a minimal shape suffices.
function fakeRun(runId: string, opts: { running?: boolean } = {}): Run {
	return {
		runId,
		records: { s: { stepId: "s", kind: "call", status: opts.running ? "running" : "done" } },
	} as unknown as Run;
}

describe("RunStore idle eviction", () => {
	test("retains a run within the idle TTL", () => {
		const s = new RunStore(HOUR);
		s.add(fakeRun("a"), 0);
		expect(s.sweep(30 * 60 * 1000)).toEqual([]);
		expect(s.size).toBe(1);
	});

	test("evicts an idle run past the TTL, from both maps", () => {
		const s = new RunStore(HOUR);
		s.add(fakeRun("a"), 0);
		expect(s.sweep(2 * HOUR)).toEqual(["a"]);
		expect(s.size).toBe(0);
		expect(s.get("a", 2 * HOUR)).toBeUndefined();
		// timestamp deleted too: a later sweep doesn't re-report it
		expect(s.sweep(3 * HOUR)).toEqual([]);
	});

	test("never evicts a run with a running step, even when long idle", () => {
		const s = new RunStore(HOUR);
		s.add(fakeRun("a", { running: true }), 0);
		expect(s.sweep(5 * HOUR)).toEqual([]);
		expect(s.size).toBe(1);
	});

	test("get() refreshes the idle timer (touch on lookup)", () => {
		const s = new RunStore(HOUR);
		s.add(fakeRun("a"), 0);
		s.get("a", 50 * 60 * 1000); // touched at 50min
		expect(s.sweep(90 * 60 * 1000)).toEqual([]); // idle only 40min
	});

	test("touch() refreshes without fetching (long step settling)", () => {
		const s = new RunStore(HOUR);
		s.add(fakeRun("a"), 0);
		// step ran ~2h; its lookup-touch at t0 is stale, but the settle-touch
		// refreshes so a sweep right after it finishes doesn't evict it.
		s.touch("a", 2 * HOUR);
		expect(s.sweep(2 * HOUR + 30 * 60 * 1000)).toEqual([]);
		s.get("a", 2 * HOUR + 30 * 60 * 1000);
		// and once it goes idle past the TTL, it is evicted
		expect(s.sweep(2 * HOUR + 30 * 60 * 1000 + 2 * HOUR)).toEqual(["a"]);
	});

	test("touch() on an unknown run is a no-op", () => {
		const s = new RunStore(HOUR);
		s.touch("ghost", 0);
		expect(s.size).toBe(0);
	});
});
