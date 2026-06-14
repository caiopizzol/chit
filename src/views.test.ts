import { describe, expect, test } from "bun:test";
import type { ConvergeReceipt } from "./converge.ts";
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
	description: "Implement and review.",
	inputs: { task: { type: "string" } },
	participants: {
		builder: { agent: "codex", instructions: "Implement.", filesystem: "read-write" },
		critic: { agent: "claude", instructions: "Review.", filesystem: "read-only" },
	},
	steps: [
		{ id: "build", call: "builder", prompt: "{{ inputs.task }}" },
		{ id: "critique", call: "critic", prompt: "{{ steps.build.output }}" },
		{ id: "verify", check: [{ command: "bun", args: ["test"] }] },
	],
	repeat: { until: "checks-pass", maxIterations: 3 },
};

const COMPOSE = {
	id: "feature-flow",
	description: "Grill then implement.",
	inputs: { idea: { type: "string" } },
	steps: [
		{ id: "grill", routine: "feature-griller", inputs: { idea: "{{ inputs.idea }}" } },
		{ id: "impl", routine: "impl-review", inputs: { task: "{{ steps.grill.output }}" } },
	],
};

describe("formatRoutineList", () => {
	test("lists id, kind, and description", () => {
		const out = formatRoutineList([
			{ id: "feature-griller", kind: "text", description: "Question an idea." },
			{ id: "impl-review", kind: "loop" },
		]);
		expect(out).toContain("feature-griller");
		expect(out).toContain("text");
		expect(out).toContain("Question an idea.");
		expect(out).toContain("impl-review");
		expect(out).toContain("loop");
	});

	test("explains the empty case", () => {
		expect(formatRoutineList([])).toMatch(/No routines configured/);
	});
});

describe("formatInspect", () => {
	test("text: shows inputs, participants, steps, and binding", () => {
		const out = formatInspect(routineFrom(ONE_SHOT));
		expect(out).toContain("feature-griller  (text)");
		expect(out).toContain("idea");
		expect(out).toContain("required");
		expect(out).toContain("context");
		expect(out).toContain("optional");
		expect(out).toContain("griller");
		expect(out).toContain("filesystem: read-only");
		expect(out).toContain("call griller");
		expect(out).toContain("output: out");
		expect(out).toContain("limits: per call 30m, whole run 120m"); // both bounds apply to an execution routine
		expect(out).toContain("manifest: examples/m.json");
		expect(out).toContain("sha256:aaaaaaaaaaaa");
	});

	test("loop: shows steps (including checks) and the live-sandbox note, no fixed roles", () => {
		const out = formatInspect(routineFrom(CONVERGE));
		expect(out).toContain("impl-review  (loop)");
		expect(out).toContain("call builder");
		expect(out).toContain("call critic");
		expect(out).toContain("check: bun test");
		expect(out).toContain("max 3 iterations");
		expect(out).toContain("limits: per call 30m, whole run 120m"); // sandboxed -> both bounds shown
		expect(out).toMatch(/git-worktree sandbox/);
		expect(out).not.toContain("implementer=");
	});

	test("converge: a config default overrides max iterations in the view", () => {
		const out = formatInspect(routineFrom(CONVERGE, { defaults: { maxIterations: 9 } }));
		expect(out).toContain("max 9 iterations");
	});

	test("shows each participant's agent binding (agent -> adapter[/model])", () => {
		const out = formatInspect(
			routineFrom(CONVERGE, { agents: { codex: { adapter: "codex" }, claude: { adapter: "claude", model: "sonnet" } } }),
		);
		expect(out).toContain("codex -> codex"); // builder's agent "codex" backed by the codex adapter
		expect(out).toContain("claude -> claude (sonnet)"); // critic's agent shows the non-default model
	});

	test("surfaces effective limits, including explicit overrides and a \"none\" opt-out", () => {
		const tight = formatInspect(routineFrom({ ...ONE_SHOT, limits: { callTimeoutMinutes: 45 } }));
		expect(tight).toContain("limits: per call 45m");

		const none = formatInspect(routineFrom({ ...CONVERGE, limits: { callTimeoutMinutes: "none", runTimeoutMinutes: "none" } }));
		expect(none).toContain("per call none");
		expect(none).toContain("whole run none");
	});

	test("composition: shows the whole-flow budget and no per-call bound", () => {
		const out = formatInspect(routineFrom(COMPOSE));
		expect(out).toContain("feature-flow  (composition)");
		expect(out).toContain("limits: whole run 120m");
		expect(out).not.toContain("per call"); // a composition makes no direct calls
	});
});

describe("formatTrace converge", () => {
	const receipt: ConvergeReceipt = {
		runId: "run-c",
		routineId: "impl-review",
		policy: "converge",
		digest: `sha256:${"c".repeat(64)}`,
		inputs: { task: "ship it" },
		maxIterations: 3,
		startedAt: 0,
		finishedAt: 50,
		elapsedMs: 50,
		status: "converged",
		iterations: [
			{
				n: 1,
				startedAt: 0,
				allChecksPassed: false,
				steps: [
					{ id: "build", kind: "call", participant: "builder", agent: "codex", status: "ok", startedAt: 0, elapsedMs: 10 },
					{ id: "verify", kind: "check", status: "failed", startedAt: 10, elapsedMs: 5, checks: [{ command: "bun test", ok: false, startedAt: 10, elapsedMs: 5 }] },
				],
			},
			{
				n: 2,
				startedAt: 15,
				allChecksPassed: true,
				steps: [
					{ id: "build", kind: "call", participant: "builder", agent: "codex", status: "ok", startedAt: 15, elapsedMs: 8 },
					{ id: "verify", kind: "check", status: "ok", startedAt: 23, elapsedMs: 4, checks: [{ command: "bun test", ok: true, startedAt: 23, elapsedMs: 4 }] },
				],
			},
		],
	};

	test("shows per-iteration steps and per-check results", () => {
		const out = formatTrace(receipt);
		expect(out).toContain("run-c  impl-review  converged");
		expect(out).toContain("iterations: 2 (max 3)");
		expect(out).toContain("iteration 1  +0ms  checks failed");
		expect(out).toContain("iteration 2  +15ms  checks passed"); // timeline: iteration start offset
		expect(out).toContain("+10ms"); // step-level offset (verify started 10ms into the run)
		expect(out).toContain("bun test:fail");
		expect(out).toContain("bun test:ok");
	});

	test("renders an apply failure on a converged-but-unapplied receipt", () => {
		const out = formatTrace({ ...receipt, applyError: "could not apply sandbox changes: conflict" } as ConvergeReceipt);
		expect(out).toContain("run-c  impl-review  converged"); // the run still converged
		expect(out).toContain("apply:    could not apply to your tree -- could not apply sandbox changes: conflict");
	});

	test("a legacy receipt without per-step timestamps renders without NaN", () => {
		// a receipt written before per-step startedAt existed (durable artifact on disk)
		const legacy = {
			runId: "old",
			routineId: "smoke",
			policy: "converge",
			digest: "sha256:old",
			inputs: {},
			maxIterations: 3,
			startedAt: 0,
			finishedAt: 100,
			elapsedMs: 100,
			status: "converged",
			iterations: [
				{
					n: 1,
					allChecksPassed: true,
					steps: [
						{ id: "build", kind: "call", participant: "b", status: "ok", elapsedMs: 80 },
						{ id: "verify", kind: "check", status: "ok", elapsedMs: 20, checks: [{ command: "grep x", ok: true, elapsedMs: 20 }] },
					],
				},
			],
		} as unknown as ConvergeReceipt;
		const out = formatTrace(legacy);
		expect(out).not.toContain("NaN");
		expect(out).toContain("iteration 1  checks passed"); // offset omitted, still readable
		expect(out).toContain("build"); // the step line renders (just without an offset)
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
			{ id: "grill", kind: "call", participant: "griller", agent: "claude", status: "ok", startedAt: 0, elapsedMs: 880 },
			{ id: "out", kind: "format", status: "ok", startedAt: 880, elapsedMs: 2 },
		],
		output: "SECRET REPORT BODY",
	};

	test("completed: shows status, steps, and summarizes output without the body", () => {
		const out = formatTrace(base);
		expect(out).toContain("run-1  feature-griller  completed");
		expect(out).toContain("call griller");
		expect(out).toContain("+880ms"); // timeline: the format step started 880ms into the run
		expect(out).toContain("900ms");
		expect(out).not.toContain("SECRET REPORT BODY");
		expect(out).toContain(`${"SECRET REPORT BODY".length} chars`);
	});

	test("shows the resolved adapter/model on a call step (audit of what ran)", () => {
		const withBinding: RunReceipt = {
			...base,
			steps: [{ id: "grill", kind: "call", participant: "griller", agent: "claude", adapter: "claude", model: "sonnet", status: "ok", startedAt: 0, elapsedMs: 5 }],
		};
		expect(formatTrace(withBinding)).toContain("call griller (claude:sonnet)");
	});

	test("failed: shows the error and no output line", () => {
		const out = formatTrace({ ...base, status: "failed", output: undefined, error: "model unavailable" });
		expect(out).toContain("failed");
		expect(out).toContain("error:    model unavailable");
		expect(out).not.toMatch(/output:/);
	});
});
