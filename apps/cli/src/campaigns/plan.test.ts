import { describe, expect, test } from "bun:test";
import { tasksClaimsOverlap } from "./overlap.ts";
import {
	normalizeClaim,
	PlanError,
	planTasks,
	resolveManifestPath,
	type TaskInput,
} from "./plan.ts";
import type { CampaignTask } from "./types.ts";

function input(over: Partial<TaskInput> = {}): TaskInput {
	return { id: "t1", title: "T", body: "do a thing", claimedPaths: ["a/**"], ...over };
}

describe("planTasks", () => {
	test("produces pending tasks from a valid graph", () => {
		const tasks = planTasks([
			input({ id: "a", claimedPaths: ["x/**"] }),
			input({ id: "b", claimedPaths: ["y/**"], dependencies: ["a"] }),
		]);
		expect(tasks.map((t) => t.id)).toEqual(["a", "b"]);
		expect(tasks.every((t) => t.status === "pending")).toBe(true);
		expect(tasks[1]?.dependencies).toEqual(["a"]);
	});

	test("rejects an empty campaign", () => {
		expect(() => planTasks([])).toThrow(/at least one task/);
	});

	test("rejects an unsafe or duplicate task id", () => {
		expect(() => planTasks([input({ id: "../evil" })])).toThrow(/invalid task id/);
		expect(() => planTasks([input({ id: "a" }), input({ id: "a" })])).toThrow(/duplicate task id/);
	});

	test("rejects a missing title or body", () => {
		expect(() => planTasks([input({ title: "" })])).toThrow(/title is required/);
		expect(() => planTasks([input({ body: "  " })])).toThrow(/body is required/);
	});

	test("requires claimedPaths unless allowPathOverlap", () => {
		expect(() => planTasks([input({ claimedPaths: [] })])).toThrow(/claimedPaths is required/);
		const ok = planTasks([input({ claimedPaths: [], allowPathOverlap: true })]);
		expect(ok[0]?.allowPathOverlap).toBe(true);
	});

	test("rejects an unknown or self dependency", () => {
		expect(() => planTasks([input({ id: "a", dependencies: ["ghost"] })])).toThrow(
			/depends on unknown task/,
		);
		expect(() => planTasks([input({ id: "a", dependencies: ["a"] })])).toThrow(/depends on itself/);
	});

	test("detects a dependency cycle", () => {
		expect(() =>
			planTasks([input({ id: "a", dependencies: ["b"] }), input({ id: "b", dependencies: ["a"] })]),
		).toThrow(PlanError);
		expect(() =>
			planTasks([input({ id: "a", dependencies: ["b"] }), input({ id: "b", dependencies: ["a"] })]),
		).toThrow(/cycle/);
	});

	test("carries through manifestPath and allowPathOverlap", () => {
		const [t] = planTasks([input({ manifestPath: "/m.json" })]);
		expect(t?.manifestPath).toBe("/m.json");
	});
});

describe("normalizeClaim", () => {
	test("collapses ./ and // and preserves subtree markers", () => {
		expect(normalizeClaim("./src//x.ts", "t")).toBe("src/x.ts");
		expect(normalizeClaim("src/**", "t")).toBe("src/**");
		expect(normalizeClaim("src//", "t")).toBe("src/");
		expect(normalizeClaim("a/./b/**", "t")).toBe("a/b/**");
	});
	test("rejects absolute paths and .. traversal and empties", () => {
		expect(() => normalizeClaim("/etc/passwd", "t")).toThrow(/repo-relative/);
		expect(() => normalizeClaim("../escape", "t")).toThrow(/\.\./);
		expect(() => normalizeClaim("  ", "t")).toThrow(/empty/);
		expect(() => normalizeClaim("./", "t")).toThrow(/empty/);
	});

	test("planTasks normalizes claims so ./ and raw forms overlap", () => {
		const [a, b] = planTasks([
			{ id: "a", title: "A", body: "x", claimedPaths: ["src/**"] },
			{ id: "b", title: "B", body: "y", claimedPaths: ["./src/file.ts"] },
		]);
		expect(a?.claimedPaths).toEqual(["src/**"]);
		expect(b?.claimedPaths).toEqual(["src/file.ts"]);
		// after normalization the overlap is detected (would have slipped past on raw strings)
		expect(tasksClaimsOverlap(a as CampaignTask, b as CampaignTask)).toBe(true);
	});
});

describe("resolveManifestPath", () => {
	const task = (over: Partial<CampaignTask> = {}): CampaignTask => ({
		id: "t",
		title: "T",
		body: "b",
		status: "pending",
		dependencies: [],
		claimedPaths: ["a/**"],
		...over,
	});
	test("task override wins over campaign default", () => {
		expect(resolveManifestPath(task({ manifestPath: "/task.json" }), "/camp.json")).toBe(
			"/task.json",
		);
	});
	test("falls back to campaign default, then undefined", () => {
		expect(resolveManifestPath(task(), "/camp.json")).toBe("/camp.json");
		expect(resolveManifestPath(task(), undefined)).toBeUndefined();
	});
});
