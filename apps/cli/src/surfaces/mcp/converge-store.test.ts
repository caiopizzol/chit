import { describe, expect, test } from "bun:test";
import type { ConvergeSession } from "./converge-engine.ts";
import { ConvergeStore } from "./converge-store.ts";

// The store only reads loopId and active; the rest is filler for the type.
function fakeSession(loopId: string, active = false): ConvergeSession {
	return {
		loopId,
		scope: "s",
		cwd: "/tmp/x",
		task: "t",
		maxIterations: 3,
		execute: async () => ({ ok: true, output: "", outputs: {}, trace: [] }),
		iteration: 0,
		priorReview: "",
		auditRefs: [],
		startedAtMs: 0,
		...(active && { active: new AbortController() }),
	};
}

describe("ConvergeStore", () => {
	test("add then get returns the session and refreshes its idle timer", () => {
		const store = new ConvergeStore(1000);
		store.add(fakeSession("L1"), 0);
		expect(store.get("L1", 500)?.loopId).toBe("L1");
		// The get at 500 refreshed the timer, so a sweep at 1400 (idle 900 <= ttl)
		// must not evict it.
		expect(store.sweep(1400)).toEqual([]);
		expect(store.size).toBe(1);
	});

	test("get returns undefined for an unknown loop", () => {
		const store = new ConvergeStore();
		expect(store.get("nope", 0)).toBeUndefined();
	});

	test("sweep evicts only sessions idle past the TTL", () => {
		const store = new ConvergeStore(1000);
		store.add(fakeSession("old"), 0);
		store.add(fakeSession("fresh"), 900);
		const evicted = store.sweep(1500); // old idle 1500 > ttl; fresh idle 600 <= ttl
		expect(evicted).toEqual(["old"]);
		expect(store.get("fresh", 1500)?.loopId).toBe("fresh");
	});

	test("sweep never evicts a session with an in-flight iteration", () => {
		const store = new ConvergeStore(1000);
		store.add(fakeSession("running", true), 0);
		expect(store.sweep(10_000)).toEqual([]); // idle long past ttl, but active
		expect(store.size).toBe(1);
	});

	test("touch refreshes the idle timer without fetching", () => {
		const store = new ConvergeStore(1000);
		store.add(fakeSession("L1"), 0);
		store.touch("L1", 900);
		expect(store.sweep(1400)).toEqual([]); // idle 500 <= ttl
		store.touch("missing", 900); // no-op for an unknown id
		expect(store.size).toBe(1);
	});
});
