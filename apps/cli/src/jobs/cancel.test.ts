// Unit tests for the shared intent-first background-cancel helper used by
// chit_cancel, the batch engine, and the Studio host-injected cancel action. The
// invariants under test: a live job is stamped with cancelRequestedAt (running
// also gets phase `cancelling`) BEFORE any signal; a terminal job is reported
// terminal and gets no cancel fields; a missing job is reported missing; a
// worker with no live process group is not signaled.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requestJobCancel } from "./cancel.ts";
import { JobStore } from "./store.ts";
import type { JobRecord, LoopJobRecord } from "./types.ts";

function loopJob(over: Partial<LoopJobRecord> = {}): LoopJobRecord {
	return {
		policy: "loop",
		runId: "bg-1",
		loopId: "bg-1",
		repoKey: "k",
		cwd: "/repo",
		scope: "sc",
		task: "t",
		maxIterations: 3,
		allowUnenforced: false,
		iterationsCompleted: 0,
		auditRefs: [],
		state: "running",
		createdAt: new Date().toISOString(),
		...over,
	};
}

function withStore(fn: (store: JobStore) => void): void {
	const dir = mkdtempSync(join(tmpdir(), "chit-cancel-"));
	try {
		fn(new JobStore(dir));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

describe("requestJobCancel", () => {
	test("a running job is stamped with cancelRequestedAt and phase cancelling (no live worker -> not signaled)", () => {
		withStore((store) => {
			store.create(loopJob({ state: "running" }));
			const r = requestJobCancel(store, "bg-1");
			expect(r).toEqual({ status: "requested", state: "running", signaled: false });
			const after = store.get("bg-1");
			expect(after?.cancelRequestedAt).toBeDefined();
			expect(after?.phase).toBe("cancelling");
		});
	});

	test("a queued job persists the intent but gets no cancelling phase (no worker yet)", () => {
		withStore((store) => {
			store.create(loopJob({ state: "queued" }));
			const r = requestJobCancel(store, "bg-1");
			expect(r).toEqual({ status: "requested", state: "queued", signaled: false });
			const after = store.get("bg-1");
			expect(after?.cancelRequestedAt).toBeDefined();
			expect(after?.phase).toBeUndefined();
		});
	});

	test("a terminal job is reported terminal and gets no cancel fields", () => {
		withStore((store) => {
			for (const state of ["completed", "cancelled", "failed"] as const) {
				const runId = `term-${state}`;
				store.create(loopJob({ runId, loopId: runId, state, endedAt: new Date().toISOString() }));
				const r = requestJobCancel(store, runId);
				expect(r).toEqual({ status: "terminal", state });
				// The locked-record decision must never stamp a finished run.
				expect(store.get(runId)?.cancelRequestedAt).toBeUndefined();
			}
		});
	});

	test("a missing job is reported missing", () => {
		withStore((store) => {
			expect(requestJobCancel(store, "ghost")).toEqual({ status: "missing" });
		});
	});

	test("never throws for the common outcomes (missing / terminal / live)", () => {
		withStore((store) => {
			store.create(loopJob({ runId: "live", loopId: "live", state: "running" }) as JobRecord);
			expect(() => requestJobCancel(store, "live")).not.toThrow();
			expect(() => requestJobCancel(store, "absent")).not.toThrow();
		});
	});
});
