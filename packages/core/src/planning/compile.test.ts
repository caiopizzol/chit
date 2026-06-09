import { describe, expect, test } from "bun:test";
import { parseConfig } from "../config/parse.ts";
import type { NormalizedProfile } from "../config/types.ts";
import { compileBatchDraft, compilePlanDraft } from "./compile.ts";
import { DraftError, parseDraft } from "./parse.ts";
import type { PlannerDraft } from "./types.ts";

// The compilers turn a validated draft into chit's existing execution shapes,
// resolving the selected profile through the closed menu and injecting its vetted
// defaults. These tests pin the contract: profile resolution, defaults injection
// without mutation, and the strategy-specific rejections (code deps in a batch, etc.).

// A realistic profile menu: the built-in default, a "deep" profile that pins a manifest
// and converge defaults (maxIterations is meaningful for a plan), and a "batch-deep"
// profile fit for a batch (no maxIterations, which a batch task cannot carry).
const profiles = parseConfig({
	profiles: {
		deep: { manifestPath: "/vetted/deep-converge.json", maxIterations: 9, callTimeoutMs: 800000 },
		"batch-deep": { manifestPath: "/vetted/batch-converge.json", callTimeoutMs: 700000 },
	},
}).profiles;

function planDraft(steps: PlannerDraft["steps"]): PlannerDraft {
	return parseDraft({ schema: 1, strategy: "plan", title: "Plan", steps });
}
function batchDraft(steps: PlannerDraft["steps"]): PlannerDraft {
	return parseDraft({ schema: 1, strategy: "batch", title: "Batch", steps });
}

describe("compilePlanDraft", () => {
	test("code dependencies become plan dependsOn", () => {
		const plan = compilePlanDraft(
			planDraft([
				{ id: "schema", title: "Schema", body: "table" },
				{ id: "api", title: "API", body: "endpoints", codeDependsOn: ["schema"] },
			]),
			profiles,
		);
		expect(plan.schema).toBe(1);
		expect(plan.cleanup).toBe("after_apply");
		expect(plan.steps[1]?.dependsOn).toEqual(["schema"]);
	});

	test("order-only dependencies fold into dependsOn (plan flows the prior diff forward)", () => {
		const plan = compilePlanDraft(
			planDraft([
				{ id: "a", title: "A", body: "a" },
				{ id: "b", title: "B", body: "b", orderDependsOn: ["a"] },
			]),
			profiles,
		);
		expect(plan.steps[1]?.dependsOn).toEqual(["a"]);
	});

	test("profile defaults (manifestPath, maxIterations, callTimeoutMs) are injected", () => {
		const plan = compilePlanDraft(
			planDraft([{ id: "a", title: "A", body: "a", profileId: "deep" }]),
			profiles,
		);
		const step = plan.steps[0];
		expect(step?.manifestPath).toBe("/vetted/deep-converge.json");
		expect(step?.maxIterations).toBe(9);
		expect(step?.callTimeoutMs).toBe(800000);
	});

	test("a draft override beats the profile default (closest wins)", () => {
		const plan = compilePlanDraft(
			planDraft([{ id: "a", title: "A", body: "a", profileId: "deep", maxIterations: 3 }]),
			profiles,
		);
		expect(plan.steps[0]?.maxIterations).toBe(3);
		expect(plan.steps[0]?.callTimeoutMs).toBe(800000); // profile default still applies
	});

	test("the default profile injects no manifestPath (bundled default converge)", () => {
		const plan = compilePlanDraft(planDraft([{ id: "a", title: "A", body: "a" }]), profiles);
		expect(plan.steps[0]?.manifestPath).toBeUndefined();
		expect(plan.steps[0]?.maxIterations).toBeUndefined();
	});

	test("an unknown profile id is rejected", () => {
		expect(() =>
			compilePlanDraft(
				planDraft([{ id: "a", title: "A", body: "a", profileId: "ghost" }]),
				profiles,
			),
		).toThrow(/unknown execution profile "ghost"/);
	});

	test("batch-only fields are rejected in a plan draft", () => {
		expect(() =>
			compilePlanDraft(
				planDraft([{ id: "a", title: "A", body: "a", claimedPaths: ["src/**"] }]),
				profiles,
			),
		).toThrow(/batch-only/);
	});

	test("the wrong strategy is rejected", () => {
		expect(() =>
			compilePlanDraft(
				batchDraft([{ id: "a", title: "A", body: "a", allowPathOverlap: true }]),
				profiles,
			),
		).toThrow(/requires strategy "plan"/);
	});

	test("compiling does not mutate the profile registry or the input draft", () => {
		const draft = planDraft([{ id: "a", title: "A", body: "a", profileId: "deep" }]);
		const draftSnapshot = JSON.stringify(draft);
		const profileSnapshot = JSON.stringify(profiles.deep);
		compilePlanDraft(draft, profiles);
		expect(JSON.stringify(draft)).toBe(draftSnapshot);
		expect(JSON.stringify(profiles.deep)).toBe(profileSnapshot);
		// The injected manifestPath is the profile's value, not a shared reference that
		// later mutation could leak through.
		const isolated: Record<string, NormalizedProfile> = { ...profiles };
		expect(isolated.deep?.manifestPath).toBe("/vetted/deep-converge.json");
	});
});

describe("compileBatchDraft", () => {
	test("order-only dependencies become batch dependencies", () => {
		const tasks = compileBatchDraft(
			batchDraft([
				{ id: "a", title: "A", body: "a", claimedPaths: ["src/a/**"] },
				{ id: "b", title: "B", body: "b", claimedPaths: ["src/b/**"], orderDependsOn: ["a"] },
			]),
			profiles,
		);
		expect(tasks[1]?.dependencies).toEqual(["a"]);
		expect(tasks[0]?.dependencies).toBeUndefined();
	});

	test("claimedPaths and profile defaults pass through", () => {
		const tasks = compileBatchDraft(
			batchDraft([
				{ id: "a", title: "A", body: "a", profileId: "batch-deep", claimedPaths: ["src/**"] },
			]),
			profiles,
		);
		expect(tasks[0]?.claimedPaths).toEqual(["src/**"]);
		expect(tasks[0]?.manifestPath).toBe("/vetted/batch-converge.json");
		expect(tasks[0]?.callTimeoutMs).toBe(700000);
	});

	test("claimedPaths are canonicalized through the shared normalizer", () => {
		const tasks = compileBatchDraft(
			batchDraft([{ id: "a", title: "A", body: "a", claimedPaths: ["./src//x.ts", "lib/**"] }]),
			profiles,
		);
		expect(tasks[0]?.claimedPaths).toEqual(["src/x.ts", "lib/**"]);
	});

	test("a traversal / absolute / whitespace-only claim is rejected", () => {
		expect(() =>
			compileBatchDraft(
				batchDraft([{ id: "a", title: "A", body: "a", claimedPaths: ["../secret"] }]),
				profiles,
			),
		).toThrow(/\.\./);
		expect(() =>
			compileBatchDraft(
				batchDraft([{ id: "a", title: "A", body: "a", claimedPaths: ["/etc/passwd"] }]),
				profiles,
			),
		).toThrow(/repo-relative/);
		expect(() =>
			compileBatchDraft(
				batchDraft([{ id: "a", title: "A", body: "a", claimedPaths: ["   "] }]),
				profiles,
			),
		).toThrow(/empty/);
	});

	test("a profile carrying maxIterations is rejected for a batch (no slot to honor it)", () => {
		expect(() =>
			compileBatchDraft(
				batchDraft([
					{ id: "a", title: "A", body: "a", profileId: "deep", claimedPaths: ["src/**"] },
				]),
				profiles,
			),
		).toThrow(/maxIterations/);
	});

	test("code dependencies are rejected with a clear error", () => {
		expect(() =>
			compileBatchDraft(
				batchDraft([
					{ id: "a", title: "A", body: "a", claimedPaths: ["src/a/**"] },
					{
						id: "b",
						title: "B",
						body: "b",
						claimedPaths: ["src/b/**"],
						codeDependsOn: ["a"],
					},
				]),
				profiles,
			),
		).toThrow(/code dependencies are not allowed in a batch draft/);
	});

	test("a missing claimedPaths is rejected unless allowPathOverlap is set", () => {
		expect(() =>
			compileBatchDraft(batchDraft([{ id: "a", title: "A", body: "a" }]), profiles),
		).toThrow(/claimedPaths.*required/);

		const tasks = compileBatchDraft(
			batchDraft([{ id: "a", title: "A", body: "a", allowPathOverlap: true }]),
			profiles,
		);
		expect(tasks[0]?.allowPathOverlap).toBe(true);
		expect(tasks[0]?.claimedPaths).toBeUndefined();
	});

	test("maxIterations is rejected in a batch draft (budget comes from the manifest)", () => {
		expect(() =>
			compileBatchDraft(
				batchDraft([
					{ id: "a", title: "A", body: "a", claimedPaths: ["src/**"], maxIterations: 5 },
				]),
				profiles,
			),
		).toThrow(/not allowed in a batch draft/);
	});

	test("an unknown profile id is rejected", () => {
		expect(() =>
			compileBatchDraft(
				batchDraft([
					{ id: "a", title: "A", body: "a", claimedPaths: ["src/**"], profileId: "ghost" },
				]),
				profiles,
			),
		).toThrow(/unknown execution profile "ghost"/);
	});

	test("the wrong strategy is rejected", () => {
		expect(() =>
			compileBatchDraft(planDraft([{ id: "a", title: "A", body: "a" }]), profiles),
		).toThrow(/requires strategy "batch"/);
	});
});

describe("draft cannot synthesize a manifestPath", () => {
	test("manifestPath is not an accepted step field (parse rejects it)", () => {
		expect(() =>
			parseDraft({
				schema: 1,
				strategy: "plan",
				title: "t",
				steps: [{ id: "a", title: "A", body: "a", manifestPath: "/evil.json" }],
			}),
		).toThrow(DraftError);
	});

	test("a compiled plan's manifestPath comes only from the vetted profile", () => {
		// Same step, two profiles: the manifestPath tracks the profile, never the draft.
		const withDefault = compilePlanDraft(planDraft([{ id: "a", title: "A", body: "a" }]), profiles);
		const withDeep = compilePlanDraft(
			planDraft([{ id: "a", title: "A", body: "a", profileId: "deep" }]),
			profiles,
		);
		expect(withDefault.steps[0]?.manifestPath).toBeUndefined();
		expect(withDeep.steps[0]?.manifestPath).toBe("/vetted/deep-converge.json");
	});
});
