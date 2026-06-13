import { describe, expect, test } from "bun:test";
import { parseManifest } from "./manifest.ts";
import type { ResolvedRoutine } from "./routine.ts";
import type { RunReceipt } from "./run.ts";
import { formatInspect, formatRoutineList, formatTrace } from "./views.ts";

function routineFrom(raw: unknown, extra: Partial<ResolvedRoutine> = {}): ResolvedRoutine {
	const manifest = parseManifest(raw, "m.json");
	return {
		id: (raw as { id: string }).id,
		description: (raw as { description?: string }).description,
		manifestPath: "examples/m.json",
		manifestAbs: "/abs/examples/m.json",
		manifest,
		digest: `sha256:${"a".repeat(64)}`,
		...extra,
	};
}

const ONE_SHOT = {
	id: "feature-griller",
	policy: "one-shot",
	description: "Question a feature idea.",
	inputs: { idea: { type: "string" }, context: { type: "string", required: false, description: "background" } },
	participants: { griller: { agent: "claude", instructions: "Read-only.", filesystem: "read-only" } },
	steps: [
		{ id: "grill", call: "griller", prompt: "p" },
		{ id: "out", format: "f" },
	],
	output: "out",
};

const CONVERGE = {
	id: "impl-review",
	policy: "converge",
	description: "Implement and review.",
	inputs: { task: { type: "string" } },
	participants: {
		impl: { agent: "codex", instructions: "Implement.", filesystem: "read-write" },
		rev: { agent: "claude", instructions: "Review.", filesystem: "read-only" },
	},
	loop: { implementer: "impl", reviewer: "rev" },
	checks: [{ command: "bun", args: ["test"] }],
	maxIterations: 3,
};

describe("formatRoutineList", () => {
	test("lists id, policy, and description", () => {
		const out = formatRoutineList([
			{ id: "feature-griller", policy: "one-shot", description: "Question an idea." },
			{ id: "impl-review", policy: "converge" },
		]);
		expect(out).toContain("feature-griller");
		expect(out).toContain("one-shot");
		expect(out).toContain("Question an idea.");
		expect(out).toContain("impl-review");
		expect(out).toContain("converge");
	});

	test("explains the empty case", () => {
		expect(formatRoutineList([])).toMatch(/No routines configured/);
	});
});

describe("formatInspect", () => {
	test("one-shot: shows inputs, participants, steps, and binding", () => {
		const out = formatInspect(routineFrom(ONE_SHOT));
		expect(out).toContain("feature-griller  (one-shot)");
		expect(out).toContain("idea");
		expect(out).toContain("required");
		expect(out).toContain("context");
		expect(out).toContain("optional");
		expect(out).toContain("griller");
		expect(out).toContain("filesystem: read-only");
		expect(out).toContain("call griller");
		expect(out).toContain("output: out");
		expect(out).toContain("manifest: examples/m.json");
		expect(out).toContain("sha256:aaaaaaaaaaaa");
	});

	test("converge: shows loop refs, checks, and the inspect-only note", () => {
		const out = formatInspect(routineFrom(CONVERGE));
		expect(out).toContain("impl-review  (converge)");
		expect(out).toContain("implementer=impl");
		expect(out).toContain("reviewer=rev");
		expect(out).toContain("bun test");
		expect(out).toContain("max iterations: 3");
		expect(out).toMatch(/converge execution is not wired/);
	});

	test("converge: a config default overrides the manifest's max iterations in the view", () => {
		const out = formatInspect(routineFrom(CONVERGE, { defaults: { maxIterations: 9 } }));
		expect(out).toContain("max iterations: 9");
	});
});

describe("formatTrace", () => {
	const base: RunReceipt = {
		runId: "run-1",
		routineId: "feature-griller",
		policy: "one-shot",
		digest: `sha256:${"b".repeat(64)}`,
		inputs: { idea: "dark mode" },
		startedAt: 0,
		finishedAt: 900,
		elapsedMs: 900,
		status: "completed",
		steps: [
			{ id: "grill", kind: "call", participant: "griller", agent: "claude", status: "ok", elapsedMs: 880 },
			{ id: "out", kind: "format", status: "ok", elapsedMs: 2 },
		],
		output: "SECRET REPORT BODY",
	};

	test("completed: shows status, steps, and summarizes output without the body", () => {
		const out = formatTrace(base);
		expect(out).toContain("run-1  feature-griller  completed");
		expect(out).toContain("call griller");
		expect(out).toContain("900ms");
		expect(out).not.toContain("SECRET REPORT BODY");
		expect(out).toContain(`${"SECRET REPORT BODY".length} chars`);
	});

	test("failed: shows the error and no output line", () => {
		const out = formatTrace({ ...base, status: "failed", output: undefined, error: "model unavailable" });
		expect(out).toContain("failed");
		expect(out).toContain("error:    model unavailable");
		expect(out).not.toMatch(/output:/);
	});
});
