import { describe, expect, test } from "bun:test";
import { type Adapter, fakeAdapter } from "./adapter.ts";
import { fakeCheckRunner } from "./check-runner.ts";
import { type FlowDeps, resolveFlow, runFlow } from "./flow.ts";
import { parseManifest } from "./manifest.ts";
import type { ResolvedRoutine } from "./routine.ts";
import { fakeSandboxFactory } from "./sandbox.ts";

function routine(raw: { id: string; [key: string]: unknown }): ResolvedRoutine {
	const manifest = parseManifest(raw, `${raw.id}.json`);
	return { id: raw.id, manifestPath: `${raw.id}.json`, manifestAbs: `/${raw.id}.json`, manifest, digest: `sha256:${raw.id}` };
}

const GRILL = routine({
	id: "grill",
	policy: "one-shot",
	inputs: { idea: { type: "string" } },
	participants: { g: { agent: "claude", instructions: "Inspect.", filesystem: "read-only" } },
	steps: [{ id: "out", call: "g", prompt: "grill {{ inputs.idea }}" }],
	output: "out",
});
const PLAN = routine({
	id: "plan",
	policy: "one-shot",
	inputs: { goal: { type: "string" } },
	participants: { p: { agent: "claude", instructions: "Plan.", filesystem: "read-only" } },
	steps: [{ id: "out", call: "p", prompt: "plan {{ inputs.goal }}" }],
	output: "out",
});
const IMPL = routine({
	id: "impl",
	policy: "converge",
	inputs: { task: { type: "string" } },
	participants: {
		builder: { agent: "claude", instructions: "Build.", filesystem: "read-write" },
		critic: { agent: "claude", instructions: "Review.", filesystem: "read-only" },
	},
	steps: [
		{ id: "build", call: "builder", prompt: "{{ inputs.task }}" },
		{ id: "verify", check: [{ command: "bun", args: ["test"] }] },
	],
});
const WRITEY_ONESHOT = routine({
	id: "writey",
	policy: "one-shot",
	inputs: {},
	participants: { w: { agent: "claude", instructions: "Edit.", filesystem: "read-write" } },
	steps: [{ id: "out", call: "w", prompt: "do it" }],
	output: "out",
});

const FLOW = routine({
	id: "feature-flow",
	policy: "flow",
	inputs: { idea: { type: "string" } },
	steps: [
		{ id: "grill", routine: "grill", inputs: { idea: "{{ inputs.idea }}" } },
		{ id: "plan", routine: "plan", inputs: { goal: "{{ steps.grill.output }}" } },
		{ id: "impl", routine: "impl", inputs: { task: "{{ steps.plan.output }}" } },
	],
});

const REGISTRY: Record<string, ResolvedRoutine> = { grill: GRILL, plan: PLAN, impl: IMPL, writey: WRITEY_ONESHOT, "feature-flow": FLOW };
function resolver(over: Record<string, ResolvedRoutine> = {}) {
	const reg = { ...REGISTRY, ...over };
	return (id: string): ResolvedRoutine => {
		const r = reg[id];
		if (r === undefined) throw new Error(`unknown routine ${JSON.stringify(id)}`);
		return r;
	};
}

describe("resolveFlow (graph rules)", () => {
	test("resolves a valid grill -> plan -> impl flow", () => {
		const rf = resolveFlow(FLOW, resolver());
		expect(rf.steps.map((s) => [s.id, s.routine.id])).toEqual([
			["grill", "grill"],
			["plan", "plan"],
			["impl", "impl"],
		]);
	});

	test("rejects a read-write one-shot step (would write the caller tree)", () => {
		const f = routine({ id: "f", policy: "flow", inputs: {}, steps: [{ id: "w", routine: "writey", inputs: {} }] });
		expect(() => resolveFlow(f, resolver())).toThrow(/must be read-only/);
	});

	test("rejects a converge step that is not last", () => {
		const f = routine({
			id: "f",
			policy: "flow",
			inputs: { task: { type: "string" } },
			steps: [
				{ id: "impl", routine: "impl", inputs: { task: "{{ inputs.task }}" } },
				{ id: "grill", routine: "grill", inputs: { idea: "x" } },
			],
		});
		expect(() => resolveFlow(f, resolver())).toThrow(/must be the last step/);
	});

	test("rejects more than one converge step (the non-last one fails the must-be-last rule)", () => {
		const f = routine({
			id: "f",
			policy: "flow",
			inputs: { task: { type: "string" } },
			steps: [
				{ id: "a", routine: "impl", inputs: { task: "{{ inputs.task }}" } },
				{ id: "b", routine: "impl", inputs: { task: "{{ inputs.task }}" } },
			],
		});
		expect(() => resolveFlow(f, resolver())).toThrow(/must be the last step.*at most one converge/);
	});

	test("rejects an unknown sub-routine", () => {
		const f = routine({ id: "f", policy: "flow", inputs: {}, steps: [{ id: "x", routine: "ghost", inputs: {} }] });
		expect(() => resolveFlow(f, resolver())).toThrow(/unknown routine "ghost"/);
	});

	test("rejects an input referencing a non-earlier step", () => {
		const f = routine({
			id: "f",
			policy: "flow",
			inputs: {},
			steps: [{ id: "plan", routine: "plan", inputs: { goal: "{{ steps.grill.output }}" } }],
		});
		expect(() => resolveFlow(f, resolver())).toThrow(/not an earlier step/);
	});

	test("rejects an input referencing an undeclared flow input (a typo)", () => {
		const f = routine({
			id: "f",
			policy: "flow",
			inputs: { idea: { type: "string" } },
			steps: [{ id: "grill", routine: "grill", inputs: { idea: "{{ inputs.idae }}" } }],
		});
		expect(() => resolveFlow(f, resolver())).toThrow(/not a declared flow input/);
	});

	test("rejects a nested flow", () => {
		const f = routine({ id: "f", policy: "flow", inputs: {}, steps: [{ id: "n", routine: "feature-flow", inputs: {} }] });
		expect(() => resolveFlow(f, resolver())).toThrow(/nested flows are not supported/);
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
		expect(res.receipt.steps.map((s) => [s.id, s.routine, s.status])).toEqual([
			["grill", "grill", "completed"],
			["plan", "plan", "completed"],
			["impl", "impl", "converged"],
		]);
		// plan's prompt saw grill's output; impl's task saw plan's output
		const planPrompt = adapter.calls[1]?.prompt ?? "";
		expect(planPrompt).toContain("plan OUT[grill dark mode]");
		const implBuild = adapter.calls[2]?.prompt ?? "";
		expect(implBuild).toContain("OUT[plan OUT[grill dark mode]]");
	});

	test("a flow ending in converge returns the terminal diff and apply flag", async () => {
		const res = await runFlow(resolveFlow(FLOW, resolver()), { idea: "x" }, deps({ apply: true }));
		expect(res.terminalDiff).toBe("the diff");
		expect(res.applied).toBe(true);
		expect(res.subReceipts).toHaveLength(3);
	});

	test("stops and fails the flow when a step does not succeed", async () => {
		const checkRunner = fakeCheckRunner(() => ({ ok: false, exitCode: 1, output: "fail" }));
		const res = await runFlow(resolveFlow(FLOW, resolver()), { idea: "x" }, deps({ checkRunner }));
		expect(res.receipt.status).toBe("failed");
		expect(res.receipt.error).toMatch(/impl.*did-not-converge/);
		// all three steps ran; impl is the failing terminal one
		expect(res.receipt.steps.at(-1)).toMatchObject({ id: "impl", status: "did-not-converge" });
		expect(res.applied).toBe(false);
	});

	test("fails a step whose mapped inputs are invalid for the sub-routine", async () => {
		const f = routine({
			id: "f",
			policy: "flow",
			inputs: {},
			steps: [{ id: "plan", routine: "plan", inputs: {} }], // plan needs `goal`
		});
		const res = await runFlow(resolveFlow(f, resolver()), {}, deps());
		expect(res.receipt.status).toBe("failed");
		expect(res.receipt.error).toMatch(/missing required input "goal"/);
	});

	test("forwards the sub-routine's config maxIterations default into the converge sub-run", async () => {
		const implCapped: ResolvedRoutine = { ...IMPL, defaults: { maxIterations: 7 } };
		const f = routine({
			id: "f",
			policy: "flow",
			inputs: { task: { type: "string" } },
			steps: [{ id: "impl", routine: "impl", inputs: { task: "{{ inputs.task }}" } }],
		});
		const res = await runFlow(resolveFlow(f, resolver({ impl: implCapped })), { task: "x" }, deps());
		const sub = res.subReceipts[0];
		expect(sub?.policy).toBe("converge");
		if (sub?.policy !== "converge") throw new Error("narrow");
		expect(sub.maxIterations).toBe(7);
	});

	test("propagates the flow scope to every sub-run", async () => {
		const res = await runFlow(resolveFlow(FLOW, resolver()), { idea: "x" }, deps(), { scope: "feat-z" });
		expect(res.receipt.scope).toBe("feat-z");
		expect(res.subReceipts).toHaveLength(3);
		for (const sub of res.subReceipts) expect(sub.scope).toBe("feat-z");
	});
});
