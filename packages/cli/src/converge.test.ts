import { describe, expect, test } from "bun:test";
import { type Adapter, fakeAdapter } from "./adapter.ts";
import { type CheckRunner, fakeCheckRunner } from "./check-runner.ts";
import {
	type ConvergeDeps,
	capDiffForPrompt,
	effectiveMaxIterations,
	MAX_DIFF_PROMPT_CHARS,
	runConverge,
} from "./converge.ts";
import { type Manifest, parseManifest } from "./manifest.ts";
import type { ResolvedRoutine } from "./routine.ts";

const CONVERGE = {
	id: "impl-review",
	inputs: { task: { type: "string" } },
	agents: {
		builder: { profile: "codex", instructions: "Build.", filesystem: "read-write" },
		critic: { profile: "claude", instructions: "Review.", filesystem: "read-only" },
	},
	steps: [
		{
			id: "build",
			call: "builder",
			prompt:
				"Task {{ inputs.task }} iter {{ iteration }} prevReview=[{{ steps.critique.output }}] fails=[{{ steps.verify.output }}]",
		},
		{ id: "critique", call: "critic", prompt: "Review {{ steps.build.output }}" },
		{ id: "verify", check: [{ command: "bun", args: ["test"] }] },
	],
	repeat: { until: "checks-pass", maxIterations: 3 },
};

function routineFrom(raw: unknown): ResolvedRoutine {
	const manifest = parseManifest(raw, "m.json");
	return {
		id: (raw as { id: string }).id,
		manifestPath: "m.json",
		manifestAbs: "/m.json",
		manifest,
		digest: "sha256:test",
	};
}

function deps(over: Partial<ConvergeDeps>): ConvergeDeps {
	let t = 0;
	return {
		adapter: fakeAdapter((req) => `${req.agent}|${req.prompt}`),
		checkRunner: fakeCheckRunner(),
		cwd: "/work",
		now: () => ++t,
		newRunId: () => "run-c",
		...over,
	};
}

describe("runConverge", () => {
	test("converges on the first iteration when checks pass", async () => {
		const r = await runConverge(routineFrom(CONVERGE), { task: "x" }, deps({ checkRunner: fakeCheckRunner() }));
		expect(r.status).toBe("converged");
		expect(r.iterations).toHaveLength(1);
		expect(r.iterations[0]?.allChecksPassed).toBe(true);
		expect(r.iterations[0]?.steps.map((s) => [s.id, s.kind, s.status])).toEqual([
			["build", "call", "ok"],
			["critique", "call", "ok"],
			["verify", "check", "ok"],
		]);
	});

	test("loops when checks fail, feeds the failure forward, and converges", async () => {
		// fail on the first check call (iteration 1), pass on the second (iteration 2)
		const checkRunner = fakeCheckRunner((_c, i) =>
			i === 0 ? { ok: false, exitCode: 1, output: "AssertionError: 2 != 3" } : { ok: true, exitCode: 0, output: "" },
		);
		const adapter = fakeAdapter((req) => `${req.agent}|${req.prompt}`);
		const r = await runConverge(routineFrom(CONVERGE), { task: "ship it" }, deps({ adapter, checkRunner }));

		expect(r.status).toBe("converged");
		expect(r.iterations).toHaveLength(2);
		expect(r.iterations[0]?.allChecksPassed).toBe(false);
		expect(r.iterations[0]?.steps[2]).toMatchObject({ id: "verify", status: "failed" });
		expect(r.iterations[1]?.allChecksPassed).toBe(true);

		// iteration 2's build (4th adapter call: build,critique,build,critique) saw the
		// fed-back failure AND the iteration number AND the prior critique.
		const iter2Build = adapter.calls[2];
		expect(iter2Build?.prompt).toContain("iter 2");
		expect(iter2Build?.prompt).toContain("AssertionError: 2 != 3");
		expect(iter2Build?.prompt).toContain("prevReview=[claude|Review");
	});

	test("on iteration 1 the cross-iteration refs render empty (pre-seeded)", async () => {
		const adapter = fakeAdapter((req) => `${req.agent}|${req.prompt}`);
		await runConverge(routineFrom(CONVERGE), { task: "x" }, deps({ adapter, checkRunner: fakeCheckRunner() }));
		expect(adapter.calls[0]?.prompt).toContain("prevReview=[]");
		expect(adapter.calls[0]?.prompt).toContain("fails=[]");
		expect(adapter.calls[0]?.prompt).toContain("iter 1");
	});

	test("does-not-converge when checks never pass, bounded by maxIterations", async () => {
		const checkRunner = fakeCheckRunner(() => ({ ok: false, exitCode: 1, output: "still failing" }));
		const r = await runConverge(
			routineFrom({ ...CONVERGE, repeat: { until: "checks-pass", maxIterations: 2 } }),
			{ task: "x" },
			deps({ checkRunner }),
		);
		expect(r.status).toBe("did-not-converge");
		expect(r.iterations).toHaveLength(2);
		expect(r.iterations.every((it) => !it.allChecksPassed)).toBe(true);
	});

	test("fails (not loops) when a participant call throws", async () => {
		const adapter: Adapter = {
			async call() {
				throw new Error("model unavailable");
			},
		};
		const r = await runConverge(routineFrom(CONVERGE), { task: "x" }, deps({ adapter }));
		expect(r.status).toBe("failed");
		expect(r.error).toMatch(/model unavailable/);
		expect(r.iterations).toHaveLength(1);
		expect(r.iterations[0]?.steps[0]).toMatchObject({ id: "build", status: "failed" });
	});

	test("carries scope and records the effective iteration cap", async () => {
		const r = await runConverge(routineFrom(CONVERGE), { task: "x" }, deps({}), { scope: "feat-x" });
		expect(r.scope).toBe("feat-x");
		expect(r.maxIterations).toBe(3);
	});

	test("hands each check the same per-call timeout a model call gets", async () => {
		const def = fakeCheckRunner();
		await runConverge(routineFrom(CONVERGE), { task: "x" }, deps({ checkRunner: def }));
		expect(def.calls[0]?.timeoutMs).toBe(30 * 60_000); // default per-call bound

		const none = fakeCheckRunner();
		await runConverge(
			routineFrom({ ...CONVERGE, limits: { callTimeoutMinutes: "none" } }),
			{ task: "x" },
			deps({ checkRunner: none }),
		);
		expect(none.calls[0]?.timeoutMs).toBeUndefined(); // "none" -> unbounded check
	});

	test("emits live progress: iteration headers and check results", async () => {
		const lines: string[] = [];
		const checkRunner = fakeCheckRunner((_c, i) =>
			i === 0 ? { ok: false, exitCode: 1, output: "x" } : { ok: true, exitCode: 0, output: "" },
		);
		await runConverge(
			routineFrom(CONVERGE),
			{ task: "x" },
			{ ...deps({ checkRunner }), onProgress: (l) => lines.push(l) },
		);
		expect(lines).toContain("iteration 1");
		expect(lines).toContain("iteration 2");
		expect(lines.some((l) => l.includes("call builder"))).toBe(true);
		expect(lines.some((l) => l.includes("check bun test → fail"))).toBe(true);
		expect(lines.some((l) => l.includes("check bun test → ok"))).toBe(true);
	});

	test("a pre-aborted signal cancels the run before any iteration", async () => {
		const controller = new AbortController();
		controller.abort();
		const r = await runConverge(routineFrom(CONVERGE), { task: "x" }, { ...deps({}), signal: controller.signal });
		expect(r.status).toBe("cancelled");
		expect(r.iterations).toHaveLength(0);
		expect(r.error).toBe("cancelled by operator");
	});

	test("a call interrupted by the signal cancels the run and records the active step", async () => {
		const controller = new AbortController();
		const adapter: Adapter = {
			async call() {
				controller.abort();
				throw new Error("claude call cancelled");
			},
		};
		const r = await runConverge(
			routineFrom(CONVERGE),
			{ task: "x" },
			{ ...deps({ adapter }), signal: controller.signal },
		);
		expect(r.status).toBe("cancelled");
		// the partial iteration is recorded so the timeline shows what was active
		expect(r.iterations).toHaveLength(1);
		expect(r.iterations[0]?.steps.at(-1)).toMatchObject({ id: "build", status: "cancelled" });
	});

	test("an aborted check (a flagged result, not a throw) still cancels the run", async () => {
		const controller = new AbortController();
		const checkRunner: CheckRunner = {
			async run() {
				controller.abort(); // mimic spawnCapture killing the check mid-run
				return { ok: false, exitCode: 130, output: "check cancelled" };
			},
		};
		const once = { ...CONVERGE, repeat: { until: "checks-pass", maxIterations: 1 } };
		const r = await runConverge(
			routineFrom(once),
			{ task: "x" },
			{ ...deps({ checkRunner }), signal: controller.signal },
		);
		expect(r.status).toBe("cancelled"); // not "did-not-converge"
		// the partial iteration is recorded; the active check shows as cancelled
		expect(r.iterations).toHaveLength(1);
		expect(r.iterations[0]?.steps.at(-1)).toMatchObject({ id: "verify", status: "cancelled" });
	});

	test("aborts before exhausting iterations when the wall-time budget is exceeded", async () => {
		// each clock read advances 1s; the budget is small enough to stop the loop
		// well before its 10-iteration cap, even though checks keep failing.
		let t = 0;
		const checkRunner = fakeCheckRunner(() => ({ ok: false, exitCode: 1, output: "still failing" }));
		const r = await runConverge(
			routineFrom({ ...CONVERGE, repeat: { until: "checks-pass", maxIterations: 10 } }),
			{ task: "x" },
			{
				...deps({ checkRunner }),
				now: () => (t += 1000),
				maxWallMs: 1500,
			},
		);
		expect(r.status).toBe("failed");
		expect(r.error).toMatch(/exceeded max wall-time/);
		expect(r.iterations.length).toBeLessThan(10);
	});
});

describe("diff prompt budget", () => {
	test("capDiffForPrompt passes small diffs through and bounds large ones", () => {
		expect(capDiffForPrompt("small diff")).toBe("small diff");
		const big = "y".repeat(MAX_DIFF_PROMPT_CHARS * 2);
		const capped = capDiffForPrompt(big);
		// the contract is a BOUNDED output (~limit + a short note), not merely shorter
		expect(capped.length).toBeLessThan(big.length);
		expect(capped.length).toBeLessThanOrEqual(MAX_DIFF_PROMPT_CHARS + 100);
		expect(capped).toMatch(/diff truncated for prompt budget/);
	});

	test("a large {{ diff }} reaches the model capped, not whole", async () => {
		const routine = routineFrom({
			...CONVERGE,
			steps: [
				{ id: "build", call: "builder", prompt: "diff:\n{{ diff }}" },
				{ id: "verify", check: [{ command: "bun", args: ["test"] }] },
			],
		});
		const huge = "x".repeat(MAX_DIFF_PROMPT_CHARS + 5000);
		const adapter = fakeAdapter((req) => req.prompt);
		await runConverge(routine, { task: "x" }, { ...deps({}), adapter, diffProvider: () => huge });
		const seen = adapter.calls[0]?.prompt ?? "";
		expect(seen.length).toBeLessThan(huge.length);
		expect(seen).toContain("diff truncated for prompt budget");
	});
});

describe("effectiveMaxIterations", () => {
	const m = (max?: number) =>
		parseManifest(
			{ ...CONVERGE, repeat: { until: "checks-pass", ...(max !== undefined && { maxIterations: max }) } },
			"m",
		) as Manifest;

	test("override beats manifest beats default, and clamps to the ceiling", () => {
		expect(effectiveMaxIterations(m(3))).toBe(3);
		expect(effectiveMaxIterations(m(3), 7)).toBe(7);
		const noMax = parseManifest({ ...CONVERGE, repeat: { until: "checks-pass" } }, "m") as Manifest;
		expect(effectiveMaxIterations(noMax)).toBe(5);
		expect(effectiveMaxIterations(m(3), 999)).toBe(20);
	});
});

describe("runConverge -- { step, equals } convergence (a user-authored /goal loop)", () => {
	// A check-less loop: a worker call + an evaluator call whose "yes" ends it. The evaluator's
	// verdict feeds the next worker iteration, exactly like a check's failure output does.
	const GOAL = {
		id: "goal-loop",
		inputs: { goal: { type: "string" } },
		agents: {
			worker: { profile: "worker", instructions: "Work toward the goal.", filesystem: "read-only" },
			judge: { profile: "judge", instructions: "Decide if the goal is met.", filesystem: "read-only" },
		},
		steps: [
			{
				id: "work",
				call: "worker",
				prompt: "Goal {{ inputs.goal }} iter {{ iteration }} prev=[{{ steps.done.output }}]",
			},
			{ id: "done", call: "judge", prompt: "Met? {{ steps.work.output }}" },
		],
		repeat: { until: { step: "done", equals: "yes" }, maxIterations: 4 },
		output: "work",
	};

	test("converges when the evaluator step's output equals the target; output is the work, not the verdict", async () => {
		const adapter = fakeAdapter((req) => (req.agent === "judge" ? "yes" : `draft(${req.prompt})`));
		const r = await runConverge(routineFrom(GOAL), { goal: "ship" }, deps({ adapter }));
		expect(r.status).toBe("converged");
		expect(r.iterations).toHaveLength(1);
		expect(r.iterations[0]?.allChecksPassed).toBe(true); // the generic "met the condition" verdict
		expect(r.until).toEqual({ step: "done", equals: "yes" });
		expect(r.output).toBe("draft(Goal ship iter 1 prev=[])"); // the worker's result, not "yes"
	});

	test("loops while the verdict is not the target, feeding it forward, then converges", async () => {
		// judge says "no" on iteration 1, "yes" on iteration 2
		let judged = 0;
		const adapter = fakeAdapter((req) =>
			req.agent === "judge" ? (judged++ === 0 ? "no" : "yes") : `draft(${req.prompt})`,
		);
		const r = await runConverge(routineFrom(GOAL), { goal: "ship" }, deps({ adapter }));
		expect(r.status).toBe("converged");
		expect(r.iterations).toHaveLength(2);
		// iteration 2's worker prompt saw iteration 1's "no" verdict fed forward
		expect(r.iterations[1]?.steps[0]?.id).toBe("work");
		const iter2WorkPrompt =
			adapter.calls.find((c) => c.agent === "worker" && c.prompt.includes("iter 2"))?.prompt ?? "";
		expect(iter2WorkPrompt).toContain("prev=[no]");
	});

	test("does-not-converge when the target verdict never appears within maxIterations", async () => {
		const adapter = fakeAdapter((req) => (req.agent === "judge" ? "no" : "draft"));
		const r = await runConverge(routineFrom(GOAL), { goal: "ship" }, deps({ adapter }));
		expect(r.status).toBe("did-not-converge");
		expect(r.iterations).toHaveLength(4); // ran to maxIterations
		expect(r.iterations.every((it) => it.allChecksPassed === false)).toBe(true);
	});

	test("the comparison is trimmed, so a verdict with surrounding whitespace still matches", async () => {
		const adapter = fakeAdapter((req) => (req.agent === "judge" ? "  yes\n" : "draft"));
		const r = await runConverge(routineFrom(GOAL), { goal: "ship" }, deps({ adapter }));
		expect(r.status).toBe("converged");
		expect(r.iterations).toHaveLength(1);
	});

	test("an exact, case-sensitive match: 'Yes.' does not satisfy equals 'yes'", async () => {
		const adapter = fakeAdapter((req) => (req.agent === "judge" ? "Yes." : "draft"));
		const r = await runConverge(routineFrom(GOAL), { goal: "ship" }, deps({ adapter }));
		expect(r.status).toBe("did-not-converge"); // author must make the evaluator return the exact token
	});
});

describe("runConverge -- compound { all } convergence (a model review can BLOCK)", () => {
	// Converge only when the checks pass AND the critic returns exactly "pass". So a passing
	// build that the critic rejects keeps looping -- review is blocking, not advisory.
	const GATED = {
		id: "gated",
		inputs: {},
		agents: {
			builder: { profile: "builder", instructions: "Build.", filesystem: "read-write" },
			critic: { profile: "critic", instructions: "Judge.", filesystem: "read-only" },
		},
		steps: [
			{ id: "build", call: "builder", prompt: "iter {{ iteration }} prev=[{{ steps.critique.output }}]" },
			{ id: "critique", call: "critic", prompt: "review {{ steps.build.output }}" },
			{ id: "verify", check: [{ command: "bun", args: ["test"] }] },
		],
		repeat: { until: { all: ["checks-pass", { step: "critique", equals: "pass" }] }, maxIterations: 4 },
		output: "build",
	};

	test("checks pass but the critic withholds 'pass' -> keeps looping, then converges when it says pass", async () => {
		let judged = 0;
		// checks always pass (fakeCheckRunner default); critic blocks on iter 1, approves on iter 2
		const adapter = fakeAdapter((req) => (req.agent === "critic" ? (judged++ === 0 ? "needs work" : "pass") : "built"));
		const r = await runConverge(routineFrom(GATED), {}, deps({ adapter, checkRunner: fakeCheckRunner() }));
		expect(r.status).toBe("converged");
		expect(r.iterations).toHaveLength(2);
		expect(r.iterations[0]?.allChecksPassed).toBe(false); // "met the exit condition?" = false: critic blocked despite green checks
		expect(r.iterations[1]?.allChecksPassed).toBe(true);
		expect(r.until).toEqual({ all: ["checks-pass", { step: "critique", equals: "pass" }] });
	});

	test("green checks are not enough: a critic stuck on rejection -> did-not-converge", async () => {
		const adapter = fakeAdapter((req) => (req.agent === "critic" ? "needs work" : "built"));
		const r = await runConverge(routineFrom(GATED), {}, deps({ adapter, checkRunner: fakeCheckRunner() }));
		expect(r.status).toBe("did-not-converge");
		expect(r.iterations).toHaveLength(4);
	});

	test("the critic step is a signal, not the product: output is the build, not 'pass'", async () => {
		const adapter = fakeAdapter((req) => (req.agent === "critic" ? "pass" : "the built artifact"));
		const r = await runConverge(routineFrom(GATED), {}, deps({ adapter, checkRunner: fakeCheckRunner() }));
		expect(r.status).toBe("converged");
		expect(r.output).toBe("the built artifact");
	});
});

describe("runConverge -- structured verdict (json + path condition)", () => {
	const JSON_LOOP = {
		id: "json-loop",
		inputs: { task: { type: "string" } },
		agents: {
			worker: { profile: "claude", instructions: "Work.", filesystem: "read-only" },
			judge: { profile: "claude", instructions: "Judge.", filesystem: "read-only" },
		},
		steps: [
			{
				id: "work",
				call: "worker",
				prompt: "do {{ inputs.task }} iter {{ iteration }} prev=[{{ steps.verdict.output }}]",
			},
			{
				id: "verdict",
				call: "judge",
				prompt: "judge {{ steps.work.output }} iter {{ iteration }}",
				json: { schema: { type: "object", required: ["passed"], properties: { passed: { type: "boolean" } } } },
			},
		],
		repeat: { until: { step: "verdict", path: "passed", equals: true }, maxIterations: 4 },
	};

	test("converges when the JSON field flips to the target", async () => {
		const adapter = fakeAdapter((req) =>
			req.prompt.startsWith("judge")
				? req.prompt.includes("iter 2")
					? '{"passed":true}'
					: '{"passed":false}'
				: "work-output",
		);
		const r = await runConverge(routineFrom(JSON_LOOP), { task: "x" }, deps({ adapter }));
		expect(r.status).toBe("converged");
		expect(r.iterations).toHaveLength(2);
		expect(r.iterations[1]?.steps.find((s) => s.id === "verdict")?.status).toBe("ok");
	});

	test("soft-fails invalid JSON, feeds the error forward, then converges", async () => {
		let judged = 0;
		const adapter = fakeAdapter((req) => {
			if (req.prompt.startsWith("judge")) {
				judged++;
				return judged === 1 ? "looks good to me" : '{"passed":true}';
			}
			return "work-output";
		});
		const r = await runConverge(routineFrom(JSON_LOOP), { task: "x" }, deps({ adapter }));
		expect(r.status).toBe("converged");
		expect(r.iterations).toHaveLength(2);
		const v1 = r.iterations[0]?.steps.find((s) => s.id === "verdict");
		expect(v1?.status).toBe("failed");
		expect(v1?.error).toMatch(/not valid JSON/);
		expect(r.error).toBeUndefined();
		// the validation error became the step output, so iteration 2 saw it fed forward
		const work2 = adapter.calls.find((c) => c.prompt.startsWith("do") && c.prompt.includes("iter 2"));
		expect(work2?.prompt).toMatch(/not valid JSON/);
	});

	test("does-not-converge (not failed) when the field never reaches the target", async () => {
		const adapter = fakeAdapter((req) => (req.prompt.startsWith("judge") ? '{"passed":false}' : "work-output"));
		const r = await runConverge(routineFrom(JSON_LOOP), { task: "x" }, deps({ adapter }));
		expect(r.status).toBe("did-not-converge");
		expect(r.iterations).toHaveLength(4);
		expect(r.error).toBeUndefined();
	});
});

describe("runConverge -- structured validation gates convergence", () => {
	const GATED = {
		id: "gated",
		inputs: { task: { type: "string" } },
		agents: { reviewer: { profile: "claude", instructions: "Review.", filesystem: "read-only" } },
		steps: [
			{
				id: "judge",
				call: "reviewer",
				prompt: "judge iter {{ iteration }}",
				json: { schema: { type: "object", required: ["passed"], properties: { passed: { type: "boolean" } } } },
			},
			{ id: "verify", check: "bun test" },
		],
		repeat: { until: "checks-pass", maxIterations: 2 },
	};

	test("invalid structured output blocks convergence even when checks pass under until: checks-pass", async () => {
		const adapter = fakeAdapter((req) => (req.prompt.startsWith("judge") ? "looks fine to me" : "ok"));
		const r = await runConverge(routineFrom(GATED), { task: "x" }, deps({ adapter, checkRunner: fakeCheckRunner() }));
		expect(r.status).toBe("did-not-converge");
		expect(r.iterations).toHaveLength(2);
		expect(r.iterations[0]?.steps.find((s) => s.id === "judge")?.status).toBe("failed");
		expect(r.iterations[0]?.allChecksPassed).toBe(false); // checks passed, but the schema violation gates it
		expect(r.error).toBeUndefined();
	});

	test("valid structured output does not over-block a checks-pass convergence", async () => {
		const adapter = fakeAdapter((req) => (req.prompt.startsWith("judge") ? '{"passed":true}' : "ok"));
		const r = await runConverge(routineFrom(GATED), { task: "x" }, deps({ adapter, checkRunner: fakeCheckRunner() }));
		expect(r.status).toBe("converged");
		expect(r.iterations).toHaveLength(1);
	});
});
