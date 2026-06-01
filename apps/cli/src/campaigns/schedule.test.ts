import { describe, expect, test } from "bun:test";
import { deriveCampaignStatus, isStartable, selectRunnable } from "./schedule.ts";
import type { Campaign, CampaignStatus, CampaignTask, TaskStatus } from "./types.ts";

function task(id: string, over: Partial<CampaignTask> = {}): CampaignTask {
	return {
		id,
		title: id,
		body: "",
		status: "pending",
		dependencies: [],
		claimedPaths: [],
		...over,
	};
}

function campaign(tasks: CampaignTask[], maxParallel = 2): Campaign {
	return {
		schema: 1,
		id: "c",
		repo: "/repo",
		baseBranch: "main",
		baseSha: "sha",
		maxParallel,
		createdAt: "t",
		updatedAt: "t",
		status: "running",
		tasks,
	};
}

describe("selectRunnable", () => {
	test("schedules only dependency-free tasks (a task with an unsatisfied dep waits)", () => {
		const c = campaign([
			task("a"),
			task("b", { dependencies: ["a"] }), // a is pending, not merged -> b waits
		]);
		expect(selectRunnable(c).map((t) => t.id)).toEqual(["a"]);
	});

	test("a dependent task becomes runnable once its dependency is merged", () => {
		const c = campaign([task("a", { status: "merged" }), task("b", { dependencies: ["a"] })]);
		expect(selectRunnable(c).map((t) => t.id)).toEqual(["b"]);
	});

	test("refuses to co-schedule two tasks whose path claims overlap", () => {
		const c = campaign(
			[
				task("a", { claimedPaths: ["apps/cli/src/audit/**"] }),
				task("b", { claimedPaths: ["apps/cli/src/audit/store.ts"] }),
			],
			2,
		);
		// Both are pending and dependency-free, but their claims overlap: only one runs.
		expect(selectRunnable(c)).toHaveLength(1);
		expect(selectRunnable(c)[0]?.id).toBe("a");
	});

	test("does not start a task overlapping an already-active task", () => {
		const c = campaign([
			task("a", { status: "running", claimedPaths: ["apps/cli/src/audit/**"] }),
			task("b", { claimedPaths: ["apps/cli/src/audit/store.ts"] }),
		]);
		expect(selectRunnable(c)).toEqual([]);
	});

	test("honors the parallel cap, counting active tasks against it", () => {
		const c = campaign([task("a", { status: "running" }), task("b"), task("c")], 2);
		// One slot free (2 cap - 1 active); only one of b/c is selected.
		expect(selectRunnable(c).map((t) => t.id)).toEqual(["b"]);
	});

	test("returns nothing when all slots are occupied", () => {
		const c = campaign([task("a", { status: "running" }), task("b", { status: "running" })], 2);
		expect(selectRunnable(c)).toEqual([]);
	});
});

describe("isStartable", () => {
	test("pending with satisfied deps is startable; pending with unsatisfied deps is not", () => {
		const c = campaign([task("a"), task("b", { dependencies: ["a"] })]);
		const [a, b] = c.tasks;
		if (!a || !b) throw new Error("expected two tasks");
		expect(isStartable(a, c)).toBe(true);
		expect(isStartable(b, c)).toBe(false);
	});
});

describe("deriveCampaignStatus", () => {
	const cases: Array<{ name: string; statuses: TaskStatus[]; expected: CampaignStatus }> = [
		{
			name: "all review_ready -> ready_for_review (chit done, merge still pending)",
			statuses: ["review_ready", "review_ready"],
			expected: "ready_for_review",
		},
		{ name: "all merged -> complete", statuses: ["merged", "merged"], expected: "complete" },
		{ name: "one running -> running", statuses: ["running", "review_ready"], expected: "running" },
		{ name: "a startable pending -> running", statuses: ["pending"], expected: "running" },
		{ name: "a failed task -> failed", statuses: ["failed", "review_ready"], expected: "failed" },
		{
			name: "a blocked task with no work left -> needs_human",
			statuses: ["blocked", "review_ready"],
			expected: "needs_human",
		},
		{ name: "needs_human task -> needs_human", statuses: ["needs_human"], expected: "needs_human" },
	];
	for (const { name, statuses, expected } of cases) {
		test(name, () => {
			const c = campaign(statuses.map((s, i) => task(`t${i}`, { status: s })));
			expect(deriveCampaignStatus(c)).toBe(expected);
		});
	}

	test("a pending task blocked by an unsatisfied dependency is needs_human, not running", () => {
		// b depends on a, and a is blocked (will never satisfy in v0): no startable work.
		const c = campaign([task("a", { status: "blocked" }), task("b", { dependencies: ["a"] })]);
		expect(deriveCampaignStatus(c)).toBe("needs_human");
	});
});
