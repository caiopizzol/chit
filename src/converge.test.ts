import { describe, expect, test } from "bun:test";
import { type Adapter, fakeAdapter } from "./adapter.ts";
import { fakeCheckRunner } from "./check-runner.ts";
import { type ConvergeDeps, effectiveMaxIterations, runConverge } from "./converge.ts";
import { type ConvergeManifest, parseManifest } from "./manifest.ts";
import type { ResolvedRoutine } from "./routine.ts";

const CONVERGE = {
	id: "impl-review",
	policy: "converge",
	inputs: { task: { type: "string" } },
	participants: {
		builder: { agent: "codex", instructions: "Build.", filesystem: "read-write" },
		critic: { agent: "claude", instructions: "Review.", filesystem: "read-only" },
	},
	steps: [
		{
			id: "build",
			call: "builder",
			prompt: "Task {{ inputs.task }} iter {{ iteration }} prevReview=[{{ steps.critique.output }}] fails=[{{ steps.verify.output }}]",
		},
		{ id: "critique", call: "critic", prompt: "Review {{ steps.build.output }}" },
		{ id: "verify", check: [{ command: "bun", args: ["test"] }] },
	],
	maxIterations: 3,
};

function routineFrom(raw: unknown): ResolvedRoutine {
	const manifest = parseManifest(raw, "m.json");
	return { id: (raw as { id: string }).id, manifestPath: "m.json", manifestAbs: "/m.json", manifest, digest: "sha256:test" };
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
		const r = await runConverge(routineFrom({ ...CONVERGE, maxIterations: 2 }), { task: "x" }, deps({ checkRunner }));
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

	test("aborts before exhausting iterations when the wall-time budget is exceeded", async () => {
		// each clock read advances 1s; the budget is small enough to stop the loop
		// well before its 10-iteration cap, even though checks keep failing.
		let t = 0;
		const checkRunner = fakeCheckRunner(() => ({ ok: false, exitCode: 1, output: "still failing" }));
		const r = await runConverge(routineFrom({ ...CONVERGE, maxIterations: 10 }), { task: "x" }, {
			...deps({ checkRunner }),
			now: () => (t += 1000),
			maxWallMs: 1500,
		});
		expect(r.status).toBe("failed");
		expect(r.error).toMatch(/exceeded max wall-time/);
		expect(r.iterations.length).toBeLessThan(10);
	});
});

describe("effectiveMaxIterations", () => {
	const m = (max?: number) => parseManifest({ ...CONVERGE, ...(max !== undefined && { maxIterations: max }) }, "m") as ConvergeManifest;

	test("override beats manifest beats default, and clamps to the ceiling", () => {
		expect(effectiveMaxIterations(m(3))).toBe(3);
		expect(effectiveMaxIterations(m(3), 7)).toBe(7);
		const noMax = parseManifest({ ...CONVERGE, maxIterations: undefined }, "m") as ConvergeManifest;
		expect(effectiveMaxIterations(noMax)).toBe(5);
		expect(effectiveMaxIterations(m(3), 999)).toBe(20);
	});
});
