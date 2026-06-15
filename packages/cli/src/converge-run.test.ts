import { describe, expect, test } from "bun:test";
import { type Adapter, fakeAdapter } from "./adapter.ts";
import { fakeCheckRunner } from "./check-runner.ts";
import { type ConvergeRunDeps, runConvergeInSandbox } from "./converge-run.ts";
import { parseManifest } from "./manifest.ts";
import type { ResolvedRoutine } from "./routine.ts";
import { type FakeSandbox, fakeSandbox } from "./sandbox.ts";

const CONVERGE = {
	id: "impl-review",
	inputs: { task: { type: "string" } },
	participants: {
		builder: { agent: "claude", instructions: "Build.", filesystem: "read-write" },
		critic: { agent: "claude", instructions: "Review {{ diff }}.", filesystem: "read-only" },
	},
	steps: [
		{ id: "build", call: "builder", prompt: "{{ inputs.task }} {{ iteration }}" },
		{ id: "critique", call: "critic", prompt: "Review this diff:\n{{ diff }}" },
		{ id: "verify", check: [{ command: "bun", args: ["test"] }] },
	],
	repeat: { until: "checks-pass", maxIterations: 2 },
};

function routineFrom(raw: unknown): ResolvedRoutine {
	const manifest = parseManifest(raw, "m.json");
	return { id: (raw as { id: string }).id, manifestPath: "m.json", manifestAbs: "/m.json", manifest, digest: "sha256:test" };
}

function harness(over: Partial<ConvergeRunDeps> & { sandboxDiff?: string } = {}) {
	let sandbox: FakeSandbox | undefined;
	const adapter = over.adapter ?? fakeAdapter((req) => `${req.agent}|${req.prompt}`);
	let t = 0;
	const deps: ConvergeRunDeps = {
		sandboxFactory: {
			async preflight() {
				return { baseCommit: "base0000" };
			},
			async create() {
				sandbox = fakeSandbox({ workDir: "/sandbox", diff: over.sandboxDiff ?? "diff body" });
				return sandbox;
			},
			async applyPatch() {},
		},
		adapter,
		checkRunner: over.checkRunner ?? fakeCheckRunner(),
		cwd: "/origin",
		now: () => ++t,
		newRunId: () => "run-s",
		apply: over.apply ?? false,
	};
	return { deps, adapter: adapter as ReturnType<typeof fakeAdapter>, sandbox: () => sandbox };
}

describe("runConvergeInSandbox", () => {
	test("runs the loop in the sandbox workDir, not the origin", async () => {
		const h = harness();
		await runConvergeInSandbox(routineFrom(CONVERGE), { task: "x" }, h.deps);
		expect(h.adapter.calls.every((c) => c.cwd === "/sandbox")).toBe(true);
	});

	test("dry-run by default: converges, shows the diff, does NOT apply, always discards", async () => {
		const h = harness({ apply: false });
		const res = await runConvergeInSandbox(routineFrom(CONVERGE), { task: "x" }, h.deps);
		expect(res.receipt.status).toBe("converged");
		expect(res.diff).toBe("diff body");
		expect(res.applied).toBe(false);
		expect(h.sandbox()?.applied).toBe(false);
		expect(h.sandbox()?.discarded).toBe(true);
		expect(res.receipt.sandbox?.workDir).toBe("/sandbox");
	});

	test("applies on confirm when the run converged", async () => {
		const h = harness({ apply: true });
		const res = await runConvergeInSandbox(routineFrom(CONVERGE), { task: "x" }, h.deps);
		expect(res.applied).toBe(true);
		expect(h.sandbox()?.applied).toBe(true);
		expect(h.sandbox()?.discarded).toBe(true);
	});

	test("never applies a run that did not converge, even with apply=true", async () => {
		const checkRunner = fakeCheckRunner(() => ({ ok: false, exitCode: 1, output: "fail" }));
		const h = harness({ apply: true, checkRunner });
		const res = await runConvergeInSandbox(routineFrom(CONVERGE), { task: "x" }, h.deps);
		expect(res.receipt.status).toBe("did-not-converge");
		expect(res.applied).toBe(false);
		expect(h.sandbox()?.applied).toBe(false);
		expect(h.sandbox()?.discarded).toBe(true);
	});

	test("a cancelled run discards the sandbox and never applies, even with apply=true", async () => {
		const controller = new AbortController();
		controller.abort();
		const h = harness({ apply: true });
		h.deps.signal = controller.signal;
		const res = await runConvergeInSandbox(routineFrom(CONVERGE), { task: "x" }, h.deps);
		expect(res.receipt.status).toBe("cancelled");
		expect(res.applied).toBe(false);
		expect(h.sandbox()?.applied).toBe(false);
		expect(h.sandbox()?.discarded).toBe(true);
	});

	test("an apply failure is recorded on the receipt, not thrown (durable evidence)", async () => {
		const sb = fakeSandbox({ workDir: "/sandbox", diff: "diff body" });
		sb.apply = async () => {
			throw new Error("could not apply: conflict");
		};
		let t = 0;
		const deps: ConvergeRunDeps = {
			sandboxFactory: { async preflight() { return { baseCommit: "base0000" }; }, async create() { return sb; }, async applyPatch() {} },
			adapter: fakeAdapter((req) => `${req.agent}|${req.prompt}`),
			checkRunner: fakeCheckRunner(),
			cwd: "/origin",
			now: () => ++t,
			newRunId: () => "run-s",
			apply: true,
		};
		const res = await runConvergeInSandbox(routineFrom(CONVERGE), { task: "x" }, deps);
		expect(res.receipt.status).toBe("converged"); // the run itself converged
		expect(res.applied).toBe(false);
		expect(res.applyError).toMatch(/conflict/);
		expect(res.receipt.applyError).toMatch(/conflict/); // durable on the receipt
		expect(sb.discarded).toBe(true); // sandbox still torn down
	});

	test("discards the sandbox even when the loop throws", async () => {
		const adapter: Adapter = {
			async call() {
				throw new Error("boom");
			},
		};
		const h = harness({ adapter });
		// a thrown adapter is captured as a failed run, not a thrown orchestration
		const res = await runConvergeInSandbox(routineFrom(CONVERGE), { task: "x" }, h.deps);
		expect(res.receipt.status).toBe("failed");
		expect(h.sandbox()?.discarded).toBe(true);
		expect(h.sandbox()?.applied).toBe(false);
	});
});
