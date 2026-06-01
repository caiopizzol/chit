import { describe, expect, test } from "bun:test";
import {
	deriveClaims,
	extractDependencies,
	findClaimOverlaps,
	type IssueInput,
	pathsOverlap,
	planTasks,
	tasksClaimsOverlap,
} from "./plan.ts";

describe("deriveClaims (title only)", () => {
	test("maps the MCP keyword to the mcp surface subtree", () => {
		expect(deriveClaims("Add MCP audit tools")).toContain("apps/cli/src/surfaces/mcp/**");
	});

	test("a converge issue claims the converge files", () => {
		expect(deriveClaims("Improve converge driver")).toEqual([
			"apps/cli/src/cli/converge.test.ts",
			"apps/cli/src/cli/converge.ts",
		]);
	});

	test("an MCP+converge issue accumulates both keyword claim sets", () => {
		const claims = deriveClaims("Add MCP-native converge loop tools");
		expect(claims).toContain("apps/cli/src/surfaces/mcp/**");
		expect(claims).toContain("apps/cli/src/cli/converge.ts");
	});

	test("a docs issue claims docs paths", () => {
		const claims = deriveClaims("Finish v0 docs");
		expect(claims).toContain("README.md");
		expect(claims).toContain("notes/**");
	});

	test("returns empty when the title has no keyword", () => {
		expect(deriveClaims("Rework the billing flow")).toEqual([]);
	});

	test("ignores keywords that appear only in the body (title-only matching)", () => {
		// A distribution issue whose title has no keyword: a body mention of MCP
		// must NOT pull in mcp claims. (The planner is what reads the body; here we
		// just confirm deriveClaims keys off the title it is given.)
		expect(deriveClaims("Decide Chit distribution and install path")).toEqual([]);
	});
});

describe("extractDependencies", () => {
	test("reads a single 'depends on #N'", () => {
		expect(extractDependencies("This depends on #3 to land first.")).toEqual([3]);
	});

	test("reads a comma list and 'blocked by'", () => {
		expect(extractDependencies("Blocked by #3, #9 and #12.")).toEqual([3, 9, 12]);
	});

	test("dedupes repeats", () => {
		expect(extractDependencies("depends on #3. also depends on #3")).toEqual([3]);
	});

	test("ignores bare issue references that are not dependency phrases", () => {
		expect(extractDependencies("See #42 for context.")).toEqual([]);
	});
});

describe("pathsOverlap", () => {
	test("equal claims overlap", () => {
		expect(pathsOverlap("README.md", "README.md")).toBe(true);
	});

	test("a subtree overlaps a file under it", () => {
		expect(pathsOverlap("apps/cli/src/audit/**", "apps/cli/src/audit/store.ts")).toBe(true);
	});

	test("two subtrees where one nests in the other overlap", () => {
		expect(pathsOverlap("apps/cli/**", "apps/cli/src/audit/**")).toBe(true);
	});

	test("disjoint paths do not overlap", () => {
		expect(pathsOverlap("apps/cli/src/cli/converge.ts", "apps/cli/src/surfaces/mcp/**")).toBe(
			false,
		);
	});

	test("a shared prefix that is not a directory boundary does not overlap", () => {
		// "audit" is a prefix string of "audit-extra" but not a path-segment parent.
		expect(pathsOverlap("apps/cli/src/audit/**", "apps/cli/src/audit-extra.ts")).toBe(false);
	});
});

describe("planTasks", () => {
	const issues: IssueInput[] = [
		{ number: 8, title: "Finish v0 docs", body: "launch positioning" },
		{ number: 3, title: "Add MCP-native converge loop tools", body: "core converge work" },
	];

	test("classifies title-claimable, dependency-free issues as pending", () => {
		const tasks = planTasks(issues);
		expect(tasks.map((t) => t.id)).toEqual(["issue-8", "issue-3"]);
		expect(tasks.every((t) => t.status === "pending")).toBe(true);
	});

	test("a title with no keyword is needs_human even if the body mentions areas", () => {
		// Real case: #9's title has no keyword; its body mentions MCP/docs. Body is
		// ignored, so it does not silently claim mcp/docs — it asks for a human.
		const tasks = planTasks([
			{
				number: 9,
				title: "Decide Chit distribution",
				body: "make MCP the primary interface; update docs",
			},
		]);
		expect(tasks[0]?.status).toBe("needs_human");
		expect(tasks[0]?.claimedPaths).toEqual([]);
		expect(tasks[0]?.error).toMatch(/--claim issue-9=/);
	});

	test("an explicit --claim classifies an otherwise needs_human task as pending", () => {
		const tasks = planTasks(
			[{ number: 9, title: "Decide Chit distribution", body: "no title keyword" }],
			{ "issue-9": ["README.md", "apps/site/content/docs/**"] },
		);
		expect(tasks[0]?.status).toBe("pending");
		expect(tasks[0]?.claimedPaths).toEqual(["README.md", "apps/site/content/docs/**"]);
	});

	test("an explicit --claim overrides the heuristic claims", () => {
		const tasks = planTasks(
			[{ number: 3, title: "Add MCP-native converge loop tools", body: "" }],
			{ "issue-3": ["apps/cli/src/surfaces/mcp/server.ts"] },
		);
		expect(tasks[0]?.claimedPaths).toEqual(["apps/cli/src/surfaces/mcp/server.ts"]);
	});

	test("marks an unclassifiable issue needs_human with a reason", () => {
		const tasks = planTasks([{ number: 5, title: "Rework billing", body: "no keywords" }]);
		expect(tasks[0]?.status).toBe("needs_human");
		expect(tasks[0]?.error).toMatch(/no path claims/);
	});

	test("resolves an in-campaign dependency to a task id", () => {
		const withDep: IssueInput[] = [
			{ number: 9, title: "docs", body: "readme" },
			{ number: 8, title: "docs follow-up", body: "more docs. depends on #9" },
		];
		const tasks = planTasks(withDep);
		const t8 = tasks.find((t) => t.id === "issue-8");
		expect(t8?.dependencies).toEqual(["issue-9"]);
		expect(t8?.status).toBe("pending");
	});

	test("marks a task needs_human when it depends on an out-of-campaign issue", () => {
		const tasks = planTasks([{ number: 8, title: "docs", body: "readme. depends on #3" }]);
		expect(tasks[0]?.status).toBe("needs_human");
		expect(tasks[0]?.error).toMatch(/not in this campaign: #3/);
	});
});

describe("findClaimOverlaps", () => {
	test("reports the overlapping pair", () => {
		// Two issues that both touch the audit area.
		const tasks = planTasks([
			{ number: 7, title: "MCP audit tools", body: "audit surface" },
			{ number: 11, title: "audit retention", body: "audit store" },
		]);
		const overlaps = findClaimOverlaps(tasks);
		expect(overlaps).toEqual([{ a: "issue-7", b: "issue-11" }]);
	});

	test("no overlap between disjoint claims", () => {
		const tasks = planTasks([
			{ number: 9, title: "docs", body: "readme" },
			{ number: 3, title: "converge", body: "driver" },
		]);
		expect(findClaimOverlaps(tasks)).toEqual([]);
		const [a, b] = tasks;
		if (!a || !b) throw new Error("expected two tasks");
		expect(tasksClaimsOverlap(a, b)).toBe(false);
	});
});
