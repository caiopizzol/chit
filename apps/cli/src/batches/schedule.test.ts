import { describe, expect, test } from "bun:test";
import { deriveBatchStatus, isBlocked, selectRunnable } from "./schedule.ts";
import type { Batch, BatchTask, TaskStatus } from "./types.ts";

function task(id: string, over: Partial<BatchTask> = {}): BatchTask {
	return {
		id,
		title: id,
		body: "b",
		status: "pending",
		dependencies: [],
		claimedPaths: [`${id}/**`],
		...over,
	};
}

function batch(tasks: BatchTask[], maxParallel = 2): Batch {
	return {
		schema: 1,
		id: "c",
		repo: "/repo",
		repoKey: "k",
		baseBranch: "main",
		baseSha: "abc",
		maxParallel,
		status: "running",
		tasks,
		createdAt: "t",
		updatedAt: "t",
	};
}

describe("selectRunnable", () => {
	test("launches independent pending tasks up to the parallel cap", () => {
		const c = batch([task("a"), task("b"), task("c")], 2);
		expect(selectRunnable(c).map((t) => t.id)).toEqual(["a", "b"]);
	});

	test("respects free slots given already-active tasks", () => {
		const c = batch([task("a", { status: "running" }), task("b"), task("c")], 2);
		expect(selectRunnable(c).map((t) => t.id)).toEqual(["b"]);
	});

	test("does not launch a task whose dependency is not yet review_ready", () => {
		const c = batch([task("a", { status: "running" }), task("b", { dependencies: ["a"] })], 2);
		expect(selectRunnable(c).map((t) => t.id)).toEqual([]);
		const c2 = batch(
			[task("a", { status: "review_ready" }), task("b", { dependencies: ["a"] })],
			2,
		);
		expect(selectRunnable(c2).map((t) => t.id)).toEqual(["b"]);
	});

	test("serializes claim-overlapping tasks into separate waves", () => {
		const c = batch(
			[task("a", { claimedPaths: ["shared/**"] }), task("b", { claimedPaths: ["shared/x.ts"] })],
			2,
		);
		// both pending, slots free, but claims overlap -> only one launches now
		expect(selectRunnable(c).map((t) => t.id)).toEqual(["a"]);
	});

	test("an allowPathOverlap task runs alone (overlaps everything)", () => {
		const c = batch([task("a", { claimedPaths: [], allowPathOverlap: true }), task("b")], 2);
		expect(selectRunnable(c).map((t) => t.id)).toEqual(["a"]);
	});
});

describe("isBlocked", () => {
	test("pending task with a failed dependency is blocked", () => {
		const c = batch([task("a", { status: "failed" }), task("b", { dependencies: ["a"] })]);
		expect(isBlocked(c.tasks[1] as BatchTask, c)).toBe(true);
	});
	test("pending task with a healthy dependency is not blocked", () => {
		const c = batch([task("a", { status: "running" }), task("b", { dependencies: ["a"] })]);
		expect(isBlocked(c.tasks[1] as BatchTask, c)).toBe(false);
	});
	test("pending task with a needs_attention dependency is blocked (only review_ready satisfies)", () => {
		const c = batch([task("a", { status: "needs_attention" }), task("b", { dependencies: ["a"] })]);
		expect(isBlocked(c.tasks[1] as BatchTask, c)).toBe(true);
	});
});

describe("deriveBatchStatus", () => {
	const states = (...ss: TaskStatus[]) => batch(ss.map((s, i) => task(`t${i}`, { status: s })));

	test("running when work is active or startable", () => {
		expect(deriveBatchStatus(states("running", "pending"))).toBe("running");
		expect(deriveBatchStatus(states("pending"))).toBe("running"); // startable
	});
	test("ready_for_review when all terminal with a review_ready", () => {
		expect(deriveBatchStatus(states("review_ready", "review_ready"))).toBe("ready_for_review");
	});
	test("failed when a task failed and nothing else moves", () => {
		expect(deriveBatchStatus(states("failed"))).toBe("failed");
	});
	test("a failed task outranks a review_ready sibling: mixed -> needs_human (verdict integrity)", () => {
		// THE regression: a failed task must not be masked by a review_ready sibling. The
		// headline must never read "ready" while a task is unresolved; mixed terminal states
		// are needs_human so the operator decides what to do with the failure, while clean
		// review_ready siblings stay reviewable per-task.
		expect(deriveBatchStatus(states("failed", "review_ready"))).toBe("needs_human");
		expect(deriveBatchStatus(states("review_ready", "failed"))).toBe("needs_human"); // order-independent
		expect(deriveBatchStatus(states("failed", "needs_attention", "review_ready"))).toBe(
			"needs_human",
		);
	});
	test("needs_human when a pending task is stuck behind a failed dep", () => {
		const c = batch([task("a", { status: "failed" }), task("b", { dependencies: ["a"] })]);
		expect(deriveBatchStatus(c)).toBe("needs_human");
	});
	test("needs_attention outranks review_ready/failed for the headline", () => {
		// A terminal task needing a human decision is not "ready"; it makes the batch
		// need a human even alongside a clean review_ready sibling (verdict integrity).
		expect(deriveBatchStatus(states("needs_attention"))).toBe("needs_human");
		expect(deriveBatchStatus(states("review_ready", "needs_attention"))).toBe("needs_human");
		expect(deriveBatchStatus(states("needs_attention", "failed"))).toBe("needs_human");
	});
	test("all-cancelled is ready_for_review (terminal, none failed/review_ready)", () => {
		expect(deriveBatchStatus(states("cancelled", "cancelled"))).toBe("ready_for_review");
	});
});
