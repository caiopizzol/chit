import { describe, expect, test } from "bun:test";
import { type Adapter, fakeAdapter } from "./adapter.ts";
import { fakeCheckRunner } from "./check-runner.ts";
import { type FlowDeps, resolveFlow, runFlow } from "./flow.ts";
import { parseManifest } from "./manifest.ts";
import type { ResolvedRoutine } from "./routine.ts";
import { fakeSandboxFactory } from "./sandbox.ts";

function routine(raw: { id: string; [key: string]: unknown }): ResolvedRoutine {
	const manifest = parseManifest(raw, `${raw.id}.json`);
	return {
		id: raw.id,
		manifestPath: `${raw.id}.json`,
		manifestAbs: `/${raw.id}.json`,
		manifest,
		digest: `sha256:${raw.id}`,
	};
}

// Text sub-routines (read-only, no checks -> run in cwd).
const GRILL = routine({
	id: "grill",
	inputs: { idea: { type: "string" } },
	agents: { g: { profile: "claude", instructions: "Inspect.", filesystem: "read-only" } },
	steps: [{ id: "out", call: "g", prompt: "grill {{ inputs.idea }}" }],
	output: "out",
});
const PLAN = routine({
	id: "plan",
	inputs: { goal: { type: "string" } },
	agents: { p: { profile: "claude", instructions: "Plan.", filesystem: "read-only" } },
	steps: [{ id: "out", call: "p", prompt: "plan {{ inputs.goal }}" }],
	output: "out",
});
// A sandboxed loop sub-routine (checks + read-write -> worktree).
const IMPL = routine({
	id: "impl",
	inputs: { task: { type: "string" } },
	agents: {
		builder: { profile: "claude", instructions: "Build.", filesystem: "read-write" },
		critic: { profile: "claude", instructions: "Review.", filesystem: "read-only" },
	},
	steps: [
		{ id: "build", call: "builder", prompt: "{{ inputs.task }}" },
		{ id: "verify", check: [{ command: "bun", args: ["test"] }] },
	],
	repeat: { until: "checks-pass", maxIterations: 3 },
});
// A sandboxed single-pass sub-routine (read-write, no repeat).
const WRITEY = routine({
	id: "writey",
	agents: { w: { profile: "claude", instructions: "Edit.", filesystem: "read-write" } },
	steps: [{ id: "out", call: "w", prompt: "do it" }],
});
// A NON-sandboxed loop sub-routine: read-only, { step, equals } exit -> loops in the cwd.
const REFINE = routine({
	id: "refine",
	inputs: { brief: { type: "string" } },
	agents: {
		writer: { profile: "claude", instructions: "Draft.", filesystem: "read-only" },
		critic: { profile: "claude", instructions: "Judge.", filesystem: "read-only" },
	},
	steps: [
		{ id: "draft", call: "writer", prompt: "brief {{ inputs.brief }} prev=[{{ steps.verdict.output }}]" },
		{ id: "verdict", call: "critic", prompt: "ship? {{ steps.draft.output }}" },
	],
	repeat: { until: { step: "verdict", equals: "ship" }, maxIterations: 3 },
	output: "draft",
});

const FLOW = routine({
	id: "feature-flow",
	inputs: { idea: { type: "string" } },
	steps: [
		{ id: "grill", routine: "grill", inputs: { idea: "{{ inputs.idea }}" } },
		{ id: "plan", routine: "plan", inputs: { goal: "{{ steps.grill.output }}" } },
		{ id: "impl", routine: "impl", inputs: { task: "{{ steps.plan.output }}" } },
	],
});

const REGISTRY: Record<string, ResolvedRoutine> = {
	grill: GRILL,
	plan: PLAN,
	impl: IMPL,
	writey: WRITEY,
	refine: REFINE,
	"feature-flow": FLOW,
};
function resolver(over: Record<string, ResolvedRoutine> = {}) {
	const reg = { ...REGISTRY, ...over };
	return (id: string): ResolvedRoutine => {
		const r = reg[id];
		if (r === undefined) throw new Error(`unknown routine ${JSON.stringify(id)}`);
		return r;
	};
}

describe("resolveFlow (graph rules)", () => {
	test("resolves a valid grill -> plan -> impl composition", () => {
		const rf = resolveFlow(FLOW, resolver());
		expect(rf.steps.map((s) => [s.id, s.kind === "ask" ? "ask" : s.routine.id])).toEqual([
			["grill", "grill"],
			["plan", "plan"],
			["impl", "impl"],
		]);
	});

	test("allows a single sandboxed sub-routine when it is last", () => {
		const f = routine({
			id: "f",
			inputs: { task: { type: "string" } },
			steps: [{ id: "impl", routine: "impl", inputs: { task: "{{ inputs.task }}" } }],
		});
		expect(() => resolveFlow(f, resolver())).not.toThrow();
	});

	test("rejects a sandboxed (write/check) sub-routine that is not last", () => {
		const f = routine({
			id: "f",
			inputs: {},
			steps: [
				{ id: "w", routine: "writey", inputs: {} },
				{ id: "g", routine: "grill", inputs: { idea: "x" } },
			],
		});
		expect(() => resolveFlow(f, resolver())).toThrow(/must be the LAST step/);
	});

	test("rejects a converge (looping) sub-routine that is not last", () => {
		const f = routine({
			id: "f",
			inputs: { task: { type: "string" } },
			steps: [
				{ id: "impl", routine: "impl", inputs: { task: "{{ inputs.task }}" } },
				{ id: "grill", routine: "grill", inputs: { idea: "x" } },
			],
		});
		expect(() => resolveFlow(f, resolver())).toThrow(/must be the LAST step/);
	});

	test("rejects an unknown sub-routine", () => {
		const f = routine({ id: "f", inputs: {}, steps: [{ id: "x", routine: "ghost", inputs: {} }] });
		expect(() => resolveFlow(f, resolver())).toThrow(/unknown routine "ghost"/);
	});

	test("rejects an input referencing a non-earlier step", () => {
		const f = routine({
			id: "f",
			inputs: {},
			steps: [{ id: "plan", routine: "plan", inputs: { goal: "{{ steps.grill.output }}" } }],
		});
		expect(() => resolveFlow(f, resolver())).toThrow(/not an earlier step/);
	});

	test("rejects an input referencing an undeclared input (a typo)", () => {
		const f = routine({
			id: "f",
			inputs: { idea: { type: "string" } },
			steps: [{ id: "grill", routine: "grill", inputs: { idea: "{{ inputs.idae }}" } }],
		});
		expect(() => resolveFlow(f, resolver())).toThrow(/not a declared input/);
	});

	test("rejects nested composition", () => {
		const f = routine({ id: "f", inputs: {}, steps: [{ id: "n", routine: "feature-flow", inputs: {} }] });
		expect(() => resolveFlow(f, resolver())).toThrow(/nested composition is not supported/);
	});

	test("resolves an ask gate between routine steps", () => {
		const f = routine({
			id: "gated",
			inputs: { idea: { type: "string" } },
			steps: [
				{ id: "grill", routine: "grill", inputs: { idea: "{{ inputs.idea }}" } },
				{ id: "approve", ask: "Refine the goal? {{ steps.grill.output }}" },
				{ id: "plan", routine: "plan", inputs: { goal: "{{ steps.approve.output }}" } },
			],
		});
		const rf = resolveFlow(f, resolver());
		expect(rf.steps.map((s) => [s.id, s.kind])).toEqual([
			["grill", "routine"],
			["approve", "ask"],
			["plan", "routine"],
		]);
	});

	test("rejects an ask whose question references a not-yet-run step", () => {
		const f = routine({
			id: "f",
			inputs: { idea: { type: "string" } },
			steps: [
				{ id: "approve", ask: "approve {{ steps.plan.output }}?" }, // plan runs later
				{ id: "plan", routine: "plan", inputs: { goal: "{{ inputs.idea }}" } },
			],
		});
		expect(() => resolveFlow(f, resolver())).toThrow(/not an earlier step/);
	});
});

function deps(over: Partial<FlowDeps> = {}): FlowDeps {
	let n = 0;
	return {
		adapter: over.adapter ?? fakeAdapter((req) => `out(${req.prompt})`),
		checkRunner: over.checkRunner ?? fakeCheckRunner(),
		sandboxFactory: fakeSandboxFactory({ diff: "the diff" }),
		cwd: "/origin",
		now: () => ++n,
		newRunId: () => `r${n++}`,
		apply: over.apply ?? false,
	};
}

describe("runFlow (execution)", () => {
	test("runs steps in order and passes outputs forward into the next routine's inputs", async () => {
		const adapter = fakeAdapter((req) => `OUT[${req.prompt}]`);
		const res = await runFlow(resolveFlow(FLOW, resolver()), { idea: "dark mode" }, deps({ adapter }));
		expect(res.receipt.status).toBe("completed");
		expect(res.receipt.steps.map((s) => [s.id, s.kind === "ask" ? "ask" : s.routine, s.status])).toEqual([
			["grill", "grill", "completed"],
			["plan", "plan", "completed"],
			["impl", "impl", "converged"],
		]);
		// plan's prompt saw grill's output; impl's task saw plan's output
		expect(adapter.calls[1]?.prompt ?? "").toContain("plan OUT[grill dark mode]");
		expect(adapter.calls[2]?.prompt ?? "").toContain("OUT[plan OUT[grill dark mode]]");
	});

	test("a composition ending in a sandboxed step returns the terminal diff and apply flag", async () => {
		const res = await runFlow(resolveFlow(FLOW, resolver()), { idea: "x" }, deps({ apply: true }));
		expect(res.terminalDiff).toBe("the diff");
		expect(res.applied).toBe(true);
		expect(res.subReceipts).toHaveLength(3);
	});

	test("stops and fails the composition when a step does not succeed", async () => {
		const checkRunner = fakeCheckRunner(() => ({ ok: false, exitCode: 1, output: "fail" }));
		const res = await runFlow(resolveFlow(FLOW, resolver()), { idea: "x" }, deps({ checkRunner }));
		expect(res.receipt.status).toBe("failed");
		expect(res.receipt.error).toMatch(/impl.*did-not-converge/);
		expect(res.receipt.steps.at(-1)).toMatchObject({ id: "impl", status: "did-not-converge" });
		expect(res.applied).toBe(false);
	});

	test("fails a step whose mapped inputs are invalid for the sub-routine", async () => {
		const f = routine({
			id: "f",
			inputs: {},
			steps: [{ id: "plan", routine: "plan", inputs: {} }], // plan needs `goal`
		});
		const res = await runFlow(resolveFlow(f, resolver()), {}, deps());
		expect(res.receipt.status).toBe("failed");
		expect(res.receipt.error).toMatch(/missing required input "goal"/);
	});

	test("forwards the sub-routine's config maxIterations default into the sandboxed sub-run", async () => {
		const implCapped: ResolvedRoutine = { ...IMPL, defaults: { maxIterations: 7 } };
		const f = routine({
			id: "f",
			inputs: { task: { type: "string" } },
			steps: [{ id: "impl", routine: "impl", inputs: { task: "{{ inputs.task }}" } }],
		});
		const res = await runFlow(resolveFlow(f, resolver({ impl: implCapped })), { task: "x" }, deps());
		const sub = res.subReceipts[0];
		expect(sub?.policy).toBe("converge");
		if (sub?.policy !== "converge") throw new Error("narrow");
		expect(sub.maxIterations).toBe(7);
	});

	test("emits a live-progress header per sub-routine", async () => {
		const lines: string[] = [];
		await runFlow(resolveFlow(FLOW, resolver()), { idea: "x" }, { ...deps(), onProgress: (l) => lines.push(l) });
		expect(lines).toContain("step grill -> grill");
		expect(lines).toContain("step plan -> plan");
		expect(lines).toContain("step impl -> impl");
	});

	test("propagates the composition scope to every sub-run", async () => {
		const res = await runFlow(resolveFlow(FLOW, resolver()), { idea: "x" }, deps(), { scope: "feat-z" });
		expect(res.receipt.scope).toBe("feat-z");
		expect(res.subReceipts).toHaveLength(3);
		for (const sub of res.subReceipts) expect(sub.scope).toBe("feat-z");
	});

	test("a pre-aborted signal cancels the flow before any sub-routine", async () => {
		const controller = new AbortController();
		controller.abort();
		const res = await runFlow(resolveFlow(FLOW, resolver()), { idea: "x" }, { ...deps(), signal: controller.signal });
		expect(res.receipt.status).toBe("cancelled");
		expect(res.receipt.steps).toHaveLength(0);
		expect(res.subReceipts).toHaveLength(0);
	});

	test("a cancelled sub-run cancels the whole flow", async () => {
		const controller = new AbortController();
		const adapter: Adapter = {
			async call() {
				controller.abort();
				throw new Error("claude call cancelled");
			},
		};
		const res = await runFlow(
			resolveFlow(FLOW, resolver()),
			{ idea: "x" },
			{ ...deps({ adapter }), signal: controller.signal },
		);
		expect(res.receipt.status).toBe("cancelled");
		expect(res.receipt.steps.at(-1)).toMatchObject({ id: "grill", status: "cancelled" });
	});

	test("enforces a whole-flow wall-time budget from the composition's limits", async () => {
		const f = routine({
			id: "budgeted",
			inputs: { idea: { type: "string" } },
			steps: [
				{ id: "grill", routine: "grill", inputs: { idea: "{{ inputs.idea }}" } },
				{ id: "plan", routine: "plan", inputs: { goal: "{{ steps.grill.output }}" } },
			],
			limits: { runTimeoutMinutes: 1 },
		});
		// clock advances 10s per read; by the 2nd step the 1-minute flow budget is blown
		let i = 0;
		const clock = () => (i += 10_000);
		const res = await runFlow(resolveFlow(f, resolver()), { idea: "x" }, { ...deps(), now: clock });
		expect(res.receipt.status).toBe("failed");
		expect(res.receipt.error).toMatch(/flow wall-time/);
		expect(res.receipt.steps.map((s) => s.id)).toEqual(["grill"]); // plan never started
	});
});

describe("runFlow -- ask gates", () => {
	// grill -> approve(ask) -> plan: the operator's answer becomes plan's goal.
	const GATED = routine({
		id: "gated",
		inputs: { idea: { type: "string" } },
		steps: [
			{ id: "grill", routine: "grill", inputs: { idea: "{{ inputs.idea }}" } },
			{ id: "approve", ask: "Refine the goal?\n{{ steps.grill.output }}" },
			{ id: "plan", routine: "plan", inputs: { goal: "{{ steps.approve.output }}" } },
		],
	});

	test("pauses at the gate, feeds the answer into the next sub-routine's input", async () => {
		const adapter = fakeAdapter((req) => `OUT[${req.prompt}]`);
		const asked: string[] = [];
		const askUser = async (q: string) => {
			asked.push(q);
			return "ship dark mode first";
		};
		const res = await runFlow(resolveFlow(GATED, resolver()), { idea: "dark mode" }, { ...deps({ adapter }), askUser });
		expect(res.receipt.status).toBe("completed");
		// the gate's question rendered with grill's output
		expect(asked).toEqual(["Refine the goal?\nOUT[grill dark mode]"]);
		// plan's prompt used the OPERATOR's answer, not grill's output
		expect(adapter.calls.at(-1)?.prompt ?? "").toContain("plan ship dark mode first");
		expect(res.receipt.steps.map((s) => [s.id, s.kind === "ask" ? "ask" : s.routine, s.status])).toEqual([
			["grill", "grill", "completed"],
			["approve", "ask", "completed"],
			["plan", "plan", "completed"],
		]);
	});

	test("the ask step receipt carries no answer body, and launches no sub-run", async () => {
		const res = await runFlow(
			resolveFlow(GATED, resolver()),
			{ idea: "x" },
			{ ...deps(), askUser: async () => "SENSITIVE" },
		);
		const ask = res.receipt.steps.find((s) => s.id === "approve");
		expect(Object.keys(ask ?? {}).sort()).toEqual(["elapsedMs", "id", "kind", "startedAt", "status"]);
		// only grill and plan produced sub-receipts; the gate did not
		expect(res.subReceipts.map((s) => s.routineId)).toEqual(["grill", "plan"]);
	});

	test("a gate with no input handler wired fails the flow at that step", async () => {
		const res = await runFlow(resolveFlow(GATED, resolver()), { idea: "x" }, deps()); // no askUser
		expect(res.receipt.status).toBe("failed");
		expect(res.receipt.error).toMatch(/needs an input handler/);
		expect(res.receipt.steps.map((s) => [s.id, s.status])).toEqual([
			["grill", "completed"],
			["approve", "failed"],
		]);
	});

	test("a Ctrl-C at the gate cancels the flow", async () => {
		const controller = new AbortController();
		const askUser = async () => {
			controller.abort(); // mimic the bin rejecting the pending prompt on SIGINT
			throw new Error("cancelled");
		};
		const res = await runFlow(
			resolveFlow(GATED, resolver()),
			{ idea: "x" },
			{ ...deps(), signal: controller.signal, askUser },
		);
		expect(res.receipt.status).toBe("cancelled");
		expect(res.receipt.steps.at(-1)).toMatchObject({ id: "approve", kind: "ask", status: "cancelled" });
	});

	test("emits a live-progress line for the gate", async () => {
		const lines: string[] = [];
		await runFlow(
			resolveFlow(GATED, resolver()),
			{ idea: "x" },
			{ ...deps(), askUser: async () => "ok", onProgress: (l) => lines.push(l) },
		);
		expect(lines).toContain("step approve (ask)");
	});

	test("a gate before the terminal sandboxed step feeds the answer into the sandboxed sub-run (the feature-flow shape)", async () => {
		const adapter = fakeAdapter((req) => `OUT[${req.prompt}]`);
		const gatedImpl = routine({
			id: "gated-impl",
			inputs: { idea: { type: "string" } },
			steps: [
				{ id: "grill", routine: "grill", inputs: { idea: "{{ inputs.idea }}" } },
				{ id: "approve", ask: "Adjustments before building? {{ steps.grill.output }}" },
				{ id: "impl", routine: "impl", inputs: { task: "{{ steps.approve.output }}" } },
			],
		});
		const res = await runFlow(
			resolveFlow(gatedImpl, resolver()),
			{ idea: "x" },
			{ ...deps({ adapter }), askUser: async () => "keep it tiny" },
		);
		expect(res.receipt.status).toBe("completed");
		expect(res.receipt.steps.map((s) => [s.id, s.status])).toEqual([
			["grill", "completed"],
			["approve", "completed"],
			["impl", "converged"],
		]);
		// the builder call inside the sandboxed sub-run saw the operator's answer
		expect(adapter.calls.at(-1)?.prompt ?? "").toContain("keep it tiny");
	});

	test("rejects a gate placed AFTER the terminal sandboxed step (sandboxed must be last)", () => {
		const f = routine({
			id: "bad-order",
			inputs: { idea: { type: "string" } },
			steps: [
				{ id: "impl", routine: "impl", inputs: { task: "{{ inputs.idea }}" } },
				{ id: "approve", ask: "looks good?" },
			],
		});
		expect(() => resolveFlow(f, resolver())).toThrow(/must be the LAST step/);
	});

	test("forwards askUser into a text sub-routine that has its OWN ask gate (composed behaves like standalone)", async () => {
		// a read-only text sub-routine that asks INSIDE itself
		const clarifySub = routine({
			id: "clarify-sub",
			inputs: {},
			steps: [
				{ id: "name", ask: "who?" },
				{ id: "out", format: "hello {{ steps.name.output }}" },
			],
			output: "out",
		});
		const f = routine({ id: "calls-clarify", inputs: {}, steps: [{ id: "c", routine: "clarify-sub", inputs: {} }] });
		const res = await runFlow(
			resolveFlow(f, resolver({ "clarify-sub": clarifySub })),
			{},
			{ ...deps(), askUser: async () => "Zoe" },
		);
		expect(res.receipt.status).toBe("completed");
		// the injected answer reached the sub-routine's output
		const sub = res.subReceipts[0];
		if (sub?.policy !== "one-shot") throw new Error("expected a one-shot sub-receipt");
		expect(sub.output).toBe("hello Zoe");
		// and the sub-run's ask STEP receipt still carries no answer body
		const askStep = sub.steps.find((s) => s.id === "name");
		expect(Object.keys(askStep ?? {}).sort()).toEqual(["elapsedMs", "id", "kind", "startedAt", "status"]);
	});
});

describe("runFlow -- non-sandboxed loop sub-routines", () => {
	test("runs a check-less loop sub-routine (loops in cwd, no worktree) and feeds its result forward", async () => {
		// the critic returns "ship" -> the loop converges on iteration 1; everything else echoes
		const adapter = fakeAdapter((req) => (req.instructions === "Judge." ? "ship" : `out(${req.prompt})`));
		const f = routine({
			id: "uses-refine",
			inputs: { brief: { type: "string" } },
			steps: [
				{ id: "r", routine: "refine", inputs: { brief: "{{ inputs.brief }}" } },
				{ id: "use", routine: "grill", inputs: { idea: "{{ steps.r.output }}" } },
			],
		});
		const res = await runFlow(resolveFlow(f, resolver({ refine: REFINE })), { brief: "b" }, deps({ adapter }));
		expect(res.receipt.status).toBe("completed");
		expect(res.receipt.steps.map((s) => [s.id, s.kind === "ask" ? "ask" : s.routine, s.status])).toEqual([
			["r", "refine", "converged"], // a loop sub-run: status is "converged", not "completed"
			["use", "grill", "completed"],
		]);
		// the loop ran with NO sandbox (it writes nothing) and produced no diff
		expect(res.terminalDiff).toBeUndefined();
		// its text result (the final draft) flowed into grill's input
		expect(adapter.calls.some((c) => c.prompt.includes("grill out(brief b prev=[])"))).toBe(true);
	});
});
