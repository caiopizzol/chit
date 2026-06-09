import { describe, expect, test } from "bun:test";
import type { NormalizedProfile } from "../config/types.ts";
import { DEFAULT_PROFILE_ID } from "../config/types.ts";
import { bindDraftApprovalBase, compileDraftArtifact, draftApprovalPayload } from "./approval.ts";
import { parseDraft } from "./parse.ts";

// The closed profile menu the artifact compiles against: the built-in default plus a
// vetted profile that injects a manifest path, so the hashed artifact carries a value the
// draft itself can never name.
const PROFILES: Record<string, NormalizedProfile> = {
	[DEFAULT_PROFILE_ID]: { id: DEFAULT_PROFILE_ID, builtIn: true },
	careful: {
		id: "careful",
		builtIn: false,
		manifestPath: "/vetted/careful.json",
		callTimeoutMs: 60000,
	},
};

const PLAN_DRAFT = {
	schema: 1 as const,
	strategy: "plan" as const,
	title: "Wire the feature",
	steps: [
		{ id: "scaffold", title: "Scaffold", body: "Create the module" },
		{
			id: "impl",
			title: "Implement",
			body: "Do the work",
			profileId: "careful",
			codeDependsOn: ["scaffold"],
		},
	],
};

const BATCH_DRAFT = {
	schema: 1 as const,
	strategy: "batch" as const,
	title: "Touch two areas",
	steps: [
		{ id: "api", title: "API", body: "edit api", claimedPaths: ["src/api/"] },
		{
			id: "web",
			title: "Web",
			body: "edit web",
			claimedPaths: ["src/web.ts"],
			orderDependsOn: ["api"],
		},
	],
};

const BASE = { ref: "HEAD", sha: "abc123" };

describe("compileDraftArtifact", () => {
	test("a plan draft compiles to the exact plan the launch runs", () => {
		const artifact = compileDraftArtifact(parseDraft(PLAN_DRAFT), PROFILES);
		expect(artifact.strategy).toBe("plan");
		if (artifact.strategy !== "plan") throw new Error("expected plan");
		expect(artifact.plan.steps.map((s) => s.id)).toEqual(["scaffold", "impl"]);
		// The profile's manifestPath is folded into the compiled step, so the hash binds it.
		expect(artifact.plan.steps[1]?.manifestPath).toBe("/vetted/careful.json");
	});

	test("a batch draft compiles to the exact task list the launch runs", () => {
		const artifact = compileDraftArtifact(parseDraft(BATCH_DRAFT), PROFILES);
		expect(artifact.strategy).toBe("batch");
		if (artifact.strategy !== "batch") throw new Error("expected batch");
		expect(artifact.batch.map((t) => t.id)).toEqual(["api", "web"]);
		expect(artifact.batch[1]?.dependencies).toEqual(["api"]);
	});

	test("an invalid draft is rejected here too (same compilers as launch)", () => {
		const bad = parseDraft({
			schema: 1,
			strategy: "plan",
			title: "Bad profile",
			steps: [{ id: "a", title: "A", body: "x", profileId: "ghost" }],
		});
		expect(() => compileDraftArtifact(bad, PROFILES)).toThrow(/unknown execution profile/);
	});
});

describe("canonicalApprovalPayload determinism", () => {
	test("key order in the source draft does not change the payload", () => {
		const a = draftApprovalPayload(parseDraft(PLAN_DRAFT), PROFILES, BASE).payload;
		// Same draft, every object's keys reversed: a different insertion order, identical value.
		const reordered = parseDraft({
			steps: [
				{ body: "Create the module", title: "Scaffold", id: "scaffold" },
				{
					codeDependsOn: ["scaffold"],
					profileId: "careful",
					body: "Do the work",
					title: "Implement",
					id: "impl",
				},
			],
			title: "Wire the feature",
			strategy: "plan",
			schema: 1,
		});
		const b = draftApprovalPayload(reordered, PROFILES, BASE).payload;
		expect(b).toBe(a);
	});

	test("a material change to the draft changes the payload", () => {
		const base = draftApprovalPayload(parseDraft(PLAN_DRAFT), PROFILES, BASE).payload;
		const changed = draftApprovalPayload(
			parseDraft({
				...PLAN_DRAFT,
				steps: [PLAN_DRAFT.steps[0], { ...PLAN_DRAFT.steps[1], body: "Do the work DIFFERENTLY" }],
			}),
			PROFILES,
			BASE,
		).payload;
		expect(changed).not.toBe(base);
	});

	test("a material change to the approved base changes the payload", () => {
		const draft = parseDraft(PLAN_DRAFT);
		const first = draftApprovalPayload(draft, PROFILES, { ref: "main", sha: "abc123" }).payload;
		const changedRef = draftApprovalPayload(draft, PROFILES, {
			ref: "release",
			sha: "abc123",
		}).payload;
		const changedSha = draftApprovalPayload(draft, PROFILES, {
			ref: "main",
			sha: "def456",
		}).payload;
		expect(changedRef).not.toBe(first);
		expect(changedSha).not.toBe(first);
	});

	test("plan and batch artifacts never collide", () => {
		const plan = draftApprovalPayload(parseDraft(PLAN_DRAFT), PROFILES, BASE);
		const batch = draftApprovalPayload(parseDraft(BATCH_DRAFT), PROFILES, BASE);
		expect(plan.strategy).toBe("plan");
		expect(batch.strategy).toBe("batch");
		expect(plan.payload).not.toBe(batch.payload);
	});

	test("the payload is valid canonical JSON of the artifact", () => {
		const { artifact, payload } = draftApprovalPayload(parseDraft(BATCH_DRAFT), PROFILES, BASE);
		expect(JSON.parse(payload)).toEqual(JSON.parse(JSON.stringify(artifact)));
	});

	test("binding a compiled artifact adds the approved base without mutating the compiled shape", () => {
		const compiled = compileDraftArtifact(parseDraft(BATCH_DRAFT), PROFILES);
		const approval = bindDraftApprovalBase(compiled, BASE);
		expect(approval).toMatchObject({ strategy: "batch", base: BASE });
		expect(compiled).not.toHaveProperty("base");
	});
});
