import { describe, expect, test } from "bun:test";
import type { NormalizedProfile } from "../config/types.ts";
import { DEFAULT_PROFILE_ID } from "../config/types.ts";
import { parseDraft } from "./parse.ts";
import { previewDraft } from "./preview.ts";

// The closed profile menu the preview resolves against: the built-in default plus a vetted
// profile that names a manifest and a per-call timeout, so the preview can report a
// non-default profile's effective knobs.
const PROFILES: Record<string, NormalizedProfile> = {
	[DEFAULT_PROFILE_ID]: { id: DEFAULT_PROFILE_ID, builtIn: true },
	careful: {
		id: "careful",
		builtIn: false,
		manifestPath: "/vetted/careful.json",
		callTimeoutMs: 60000,
	},
};

describe("previewDraft (plan)", () => {
	test("summarizes the compiled plan shape without launching anything", () => {
		const draft = parseDraft({
			schema: 1,
			strategy: "plan",
			title: "Wire the feature",
			steps: [
				{ id: "scaffold", title: "Scaffold", body: "  Create the   module.\nWith care.  " },
				{
					id: "impl",
					title: "Implement",
					body: "Do the work",
					profileId: "careful",
					codeDependsOn: ["scaffold"],
					maxIterations: 5,
					requiredChecks: [{ command: "bun", args: ["test"] }],
				},
			],
		});

		const preview = previewDraft(draft, PROFILES);
		expect(preview.strategy).toBe("plan");
		expect(preview.title).toBe("Wire the feature");
		expect(preview.stepCount).toBe(2);
		expect(preview.status).toBe("preview_ready");
		expect(preview.batch).toBeUndefined();

		const [scaffold, impl] = preview.plan?.steps ?? [];
		expect(scaffold).toMatchObject({
			id: "scaffold",
			dependsOn: [],
			profileId: DEFAULT_PROFILE_ID,
			usesDefaultProfile: true,
			hasManifestPath: false,
			requiredCheckCount: 0,
		});
		// Multi-line / padded bodies collapse to a single trimmed line.
		expect(scaffold?.bodyPreview).toBe("Create the module. With care.");
		expect(impl).toMatchObject({
			id: "impl",
			dependsOn: ["scaffold"],
			profileId: "careful",
			usesDefaultProfile: false,
			hasManifestPath: true,
			maxIterations: 5,
			callTimeoutMs: 60000,
			requiredCheckCount: 1,
		});
	});

	test("caps a long body with ASCII dots", () => {
		const long = "x".repeat(500);
		const draft = parseDraft({
			schema: 1,
			strategy: "plan",
			title: "Long",
			steps: [{ id: "a", title: "A", body: long }],
		});
		const preview = previewDraft(draft, PROFILES);
		const body = preview.plan?.steps[0]?.bodyPreview ?? "";
		expect(body.length).toBe(140);
		expect(body.endsWith("...")).toBe(true);
	});
});

describe("previewDraft (batch)", () => {
	test("summarizes order-only deps and normalized claims", () => {
		const draft = parseDraft({
			schema: 1,
			strategy: "batch",
			title: "Touch two areas",
			steps: [
				{ id: "api", title: "API", body: "edit api", claimedPaths: ["./src/api/"] },
				{
					id: "web",
					title: "Web",
					body: "edit web",
					claimedPaths: ["src/web/page.ts"],
					orderDependsOn: ["api"],
				},
			],
		});

		const preview = previewDraft(draft, PROFILES);
		expect(preview.strategy).toBe("batch");
		expect(preview.plan).toBeUndefined();

		const [api, web] = preview.batch?.tasks ?? [];
		expect(api).toMatchObject({
			id: "api",
			dependencies: [],
			claimedPaths: ["src/api/"], // normalized: leading ./ stripped, subtree slash preserved
			allowPathOverlap: false,
		});
		expect(web).toMatchObject({
			id: "web",
			dependencies: ["api"],
			claimedPaths: ["src/web/page.ts"],
		});
	});
});

describe("previewDraft surfaces compile-time rejections", () => {
	test("unknown profile id is rejected before a preview is built", () => {
		const draft = parseDraft({
			schema: 1,
			strategy: "plan",
			title: "Bad profile",
			steps: [{ id: "a", title: "A", body: "x", profileId: "ghost" }],
		});
		expect(() => previewDraft(draft, PROFILES)).toThrow(/unknown execution profile "ghost"/);
	});

	test("a batch draft with code dependencies is rejected", () => {
		const draft = parseDraft({
			schema: 1,
			strategy: "batch",
			title: "Bad batch",
			steps: [
				{ id: "a", title: "A", body: "x", claimedPaths: ["src/a"] },
				{ id: "b", title: "B", body: "y", claimedPaths: ["src/b"], codeDependsOn: ["a"] },
			],
		});
		expect(() => previewDraft(draft, PROFILES)).toThrow(/code dependencies are not allowed/);
	});
});
