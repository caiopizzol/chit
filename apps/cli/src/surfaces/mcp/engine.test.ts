import { describe, expect, test } from "bun:test";
import { parseManifest } from "@chit/core";
import { prepareInputs } from "../../runtime/render.ts";
import type { AdapterCallResult, AdapterMap, RuntimeAdapter } from "../../runtime/types.ts";
import { isComplete, type Run, readySteps, runStep } from "./engine.ts";

// A two-step chain: a (from input) -> b (from a's output). deps: a=[], b=[a].
const CHAIN = {
	schema: 1,
	id: "chain",
	description: "test chain",
	inputs: { x: { type: "string" } },
	participants: { p: { agent: "fake", role: "r", session: "stateless" } },
	steps: {
		a: { call: "p", prompt: "{{ inputs.x }}" },
		b: { call: "p", prompt: "{{ steps.a.output }}" },
	},
	output: "b",
};

// Build a Run with injected adapters, bypassing real adapter construction so
// tests can control timing/failure. Mirrors startRun's record init.
function makeRun(raw: unknown, inputs: Record<string, unknown>, adapters: AdapterMap): Run {
	const manifest = parseManifest(raw);
	const records: Run["records"] = {};
	for (const [stepId, step] of Object.entries(manifest.steps)) {
		records[stepId] =
			step.kind === "call"
				? {
						stepId,
						kind: "call",
						participantId: step.call,
						agentId: manifest.participants[step.call]?.agent,
						session: manifest.participants[step.call]?.session,
						status: "pending",
					}
				: { stepId, kind: "format", status: "pending" };
	}
	return {
		runId: "t",
		manifest,
		preparedInputs: prepareInputs(manifest.inputs, inputs, "/tmp"),
		adapters,
		invocationCwd: "/tmp",
		outputs: {},
		records,
	};
}

const immediate = (output: string): AdapterMap => ({
	fake: { call: async () => ({ output }) },
});

describe("mcp engine: ready order + DAG guardrail", () => {
	test("only the input-rooted step is ready at start", () => {
		const run = makeRun(CHAIN, { x: "hi" }, immediate("A"));
		expect(readySteps(run)).toEqual(["a"]);
	});

	test("running a step advances the ready set to its dependents", async () => {
		const run = makeRun(CHAIN, { x: "hi" }, immediate("A"));
		await runStep(run, "a", () => {});
		expect(run.records.a?.status).toBe("done");
		expect(run.outputs.a).toBe("A");
		expect(readySteps(run)).toEqual(["b"]);
		expect(isComplete(run)).toBe(false);
	});

	test("out-of-order step is rejected with its unmet deps", async () => {
		const run = makeRun(CHAIN, { x: "hi" }, immediate("A"));
		await expect(runStep(run, "b", () => {})).rejects.toThrow(/not ready; waiting on: a/);
	});

	test("propose-verify-revise: ready order matches the declared DAG", () => {
		const raw = {
			schema: 1,
			id: "pvr",
			description: "d",
			inputs: { task: { type: "string" } },
			participants: {
				proposer: { agent: "fake", role: "r", session: "stateless" },
				verifier: { agent: "fake", role: "r", session: "stateless" },
			},
			steps: {
				propose: { call: "proposer", prompt: "{{ inputs.task }}" },
				verify: { call: "verifier", prompt: "{{ steps.propose.output }}" },
				revise: { call: "proposer", prompt: "{{ steps.verify.output }}" },
				out: { format: "{{ steps.revise.output }}" },
			},
			output: "out",
		};
		const run = makeRun(raw, { task: "x" }, immediate("A"));
		expect(readySteps(run)).toEqual(["propose"]);
	});
});

describe("mcp engine: running-state lock", () => {
	test("a concurrent runStep on the same in-flight step is rejected", async () => {
		// Never-resolving adapter: the first call stays in flight so we can race a
		// second call against it.
		let release!: (r: AdapterCallResult) => void;
		const gate = new Promise<AdapterCallResult>((r) => {
			release = r;
		});
		const adapters: AdapterMap = { fake: { call: () => gate } };
		const run = makeRun(CHAIN, { x: "hi" }, adapters);

		const first = runStep(run, "a", () => {});
		// Synchronously after kicking off the first call, the record is "running".
		expect(run.records.a?.status).toBe("running");

		// A second call on the same step must be rejected, not spawn again.
		await expect(runStep(run, "a", () => {})).rejects.toThrow(/already running/);

		// Let the first finish; it still completes cleanly.
		release({ output: "A" });
		await first;
		expect(run.records.a?.status).toBe("done");
		expect(run.outputs.a).toBe("A");
	});
});

describe("mcp engine: failure is terminal", () => {
	test("a failed step stays failed, blocks dependents, and refuses re-run", async () => {
		const adapters: AdapterMap = {
			fake: {
				call: async () => {
					throw new Error("boom");
				},
			} satisfies RuntimeAdapter,
		};
		const run = makeRun(CHAIN, { x: "hi" }, adapters);

		await expect(runStep(run, "a", () => {})).rejects.toThrow(/boom/);
		expect(run.records.a?.status).toBe("failed");
		// Not advertised as ready (only pending steps are), and dependents stay blocked.
		expect(readySteps(run)).toEqual([]);
		// Terminal: an explicit re-run is refused rather than spawning again.
		await expect(runStep(run, "a", () => {})).rejects.toThrow(/previously failed/);
	});
});
