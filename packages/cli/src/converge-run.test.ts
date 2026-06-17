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
	agents: {
		builder: { profile: "claude", instructions: "Build.", filesystem: "read-write" },
		critic: { profile: "claude", instructions: "Review {{ diff }}.", filesystem: "read-only" },
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
	return {
		id: (raw as { id: string }).id,
		manifestPath: "m.json",
		manifestAbs: "/m.json",
		manifest,
		digest: "sha256:test",
	};
}

function harness(over: Partial<ConvergeRunDeps> & { sandboxDiff?: string } = {}) {
	let sandbox: FakeSandbox | undefined;
	let createdBaseCommit: string | undefined;
	const adapter = over.adapter ?? fakeAdapter((req) => `${req.agent}|${req.prompt}`);
	let t = 0;
	const deps: ConvergeRunDeps = {
		sandboxFactory: {
			async preflight() {
				return { baseCommit: "base0000" };
			},
			async create(_cwd, _runId, baseCommit) {
				createdBaseCommit = baseCommit;
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
		...(over.baseCommit !== undefined && { baseCommit: over.baseCommit }),
		...(over.onProgress !== undefined && { onProgress: over.onProgress }),
	};
	return {
		deps,
		adapter: adapter as ReturnType<typeof fakeAdapter>,
		sandbox: () => sandbox,
		createdBaseCommit: () => createdBaseCommit,
	};
}

describe("runConvergeInSandbox", () => {
	test("runs the loop in the sandbox workDir, not the origin", async () => {
		const progress: string[] = [];
		const h = harness({ onProgress: (line) => progress.push(line) });
		await runConvergeInSandbox(routineFrom(CONVERGE), { task: "x" }, h.deps);
		expect(h.adapter.calls.every((c) => c.cwd === "/sandbox")).toBe(true);
		expect(progress[0]).toBe("run run-s");
		expect(progress[1]).toBe("  creating sandbox (git worktree) ...");
	});

	test("creates the sandbox from the accepted base commit", async () => {
		const h = harness({ baseCommit: "accepted-base" });
		const res = await runConvergeInSandbox(routineFrom(CONVERGE), { task: "x" }, h.deps);
		expect(h.createdBaseCommit()).toBe("accepted-base");
		expect(res.receipt.baseCommit).toBe("accepted-base");
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
			sandboxFactory: {
				async preflight() {
					return { baseCommit: "base0000" };
				},
				async create() {
					return sb;
				},
				async applyPatch() {},
			},
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

// A sandboxed routine with a change policy.
const POLICY_CONVERGE = {
	...CONVERGE,
	id: "policy-edit",
	changePolicy: { allowedChangedPaths: ["src/"] },
};

describe("runConvergeInSandbox -- change policy enforcement", () => {
	function policyHarness(opts: { statusLines?: string[]; diff?: string } = {}) {
		const status = opts.statusLines ?? ["M\tsrc/foo.ts"];
		let sandbox: FakeSandbox | undefined;
		let t = 0;
		const deps: ConvergeRunDeps = {
			sandboxFactory: {
				async preflight() {
					return { baseCommit: "base0000" };
				},
				async create() {
					const sb = fakeSandbox({ workDir: "/sandbox", diff: opts.diff ?? "diff body" });
					// Override status to return the controlled list.
					sb.status = async () => status;
					sandbox = sb;
					return sb;
				},
				async applyPatch() {},
			},
			adapter: fakeAdapter((req) => `${req.agent}|${req.prompt}`),
			checkRunner: fakeCheckRunner(),
			cwd: "/origin",
			now: () => ++t,
			newRunId: () => "run-p",
			apply: true,
		};
		return { deps, sandbox: () => sandbox };
	}

	test("converged run with all files within allowed paths applies normally", async () => {
		const h = policyHarness({ statusLines: ["M\tsrc/foo.ts", "A\tsrc/bar.ts"] });
		const res = await runConvergeInSandbox(routineFrom(POLICY_CONVERGE), { task: "x" }, h.deps);
		expect(res.receipt.status).toBe("converged");
		expect(res.applied).toBe(true);
		expect(res.receipt.changePolicyViolation).toBeUndefined();
		expect(res.debugPatch).toBeUndefined();
	});

	test("converged run with unexpected files fails with changePolicyViolation", async () => {
		const h = policyHarness({ statusLines: ["M\tsrc/foo.ts", "A\tconfig/secrets.json"] });
		const res = await runConvergeInSandbox(routineFrom(POLICY_CONVERGE), { task: "x" }, h.deps);
		expect(res.receipt.status).toBe("failed");
		expect(res.applied).toBe(false);
		expect(res.receipt.changePolicyViolation).toEqual({
			unexpectedFiles: ["config/secrets.json"],
			allowed: ["src/"],
		});
		expect(res.receipt.error).toMatch(/change policy violation/);
		expect(res.receipt.error).toMatch(/config\/secrets\.json/);
		expect(res.debugPatch).toBe(true);
		expect(h.sandbox()?.applied).toBe(false);
		expect(h.sandbox()?.discarded).toBe(true);
	});

	test("change policy violation prevents apply even with apply=true", async () => {
		const h = policyHarness({ statusLines: ["A\toutside.txt"] });
		const res = await runConvergeInSandbox(routineFrom(POLICY_CONVERGE), { task: "x" }, h.deps);
		expect(res.applied).toBe(false);
		expect(h.sandbox()?.applied).toBe(false);
	});

	test("deniedChangedPaths rejects files matching the deny list", async () => {
		const routine = routineFrom({
			...CONVERGE,
			id: "deny-edit",
			changePolicy: { deniedChangedPaths: [".env", "node_modules/"] },
		});
		const h = policyHarness({ statusLines: ["M\tsrc/ok.ts", "M\t.env"] });
		const res = await runConvergeInSandbox(routine, { task: "x" }, h.deps);
		expect(res.receipt.status).toBe("failed");
		expect(res.receipt.changePolicyViolation?.unexpectedFiles).toEqual([".env"]);
		expect(res.receipt.changePolicyViolation?.denied).toEqual([".env", "node_modules/"]);
	});

	test("violation is visible in receipt sandbox status", async () => {
		const h = policyHarness({ statusLines: ["A\tbad.txt"] });
		const res = await runConvergeInSandbox(routineFrom(POLICY_CONVERGE), { task: "x" }, h.deps);
		expect(res.receipt.sandbox?.status).toContain("A\tbad.txt");
	});

	test("non-converged run with change policy violation is 'failed', not 'did-not-converge'", async () => {
		const checkRunner = fakeCheckRunner(() => ({ ok: false, exitCode: 1, output: "fail" }));
		const status = ["M\tsrc/foo.ts", "A\toutside.txt"];
		let t = 0;
		const deps: ConvergeRunDeps = {
			sandboxFactory: {
				async preflight() {
					return { baseCommit: "base0000" };
				},
				async create() {
					const sb = fakeSandbox({ workDir: "/sandbox", diff: "diff body" });
					sb.status = async () => status;
					return sb;
				},
				async applyPatch() {},
			},
			adapter: fakeAdapter((req) => `${req.agent}|${req.prompt}`),
			checkRunner,
			cwd: "/origin",
			now: () => ++t,
			newRunId: () => "run-p",
			apply: true,
		};
		const res = await runConvergeInSandbox(routineFrom(POLICY_CONVERGE), { task: "x" }, deps);
		expect(res.receipt.status).toBe("failed");
		expect(res.receipt.changePolicyViolation?.unexpectedFiles).toEqual(["outside.txt"]);
		expect(res.applied).toBe(false);
		expect(res.debugPatch).toBe(true);
	});

	test("no policy on manifest skips validation (existing behavior)", async () => {
		const h = policyHarness({ statusLines: ["M\tanything.txt"] });
		const res = await runConvergeInSandbox(routineFrom(CONVERGE), { task: "x" }, h.deps);
		expect(res.receipt.status).toBe("converged");
		expect(res.receipt.changePolicyViolation).toBeUndefined();
	});
});

describe("runConvergeInSandbox -- debug patch for failed/non-converged runs", () => {
	test("a non-converged run marks the patch as debugPatch", async () => {
		const checkRunner = fakeCheckRunner(() => ({ ok: false, exitCode: 1, output: "fail" }));
		const h = harness({ checkRunner, sandboxDiff: "some diff" });
		const res = await runConvergeInSandbox(routineFrom(CONVERGE), { task: "x" }, h.deps);
		expect(res.receipt.status).toBe("did-not-converge");
		expect(res.debugPatch).toBe(true);
		expect(res.patch).toBe("some diff");
	});

	test("a converged run does NOT mark the patch as debugPatch", async () => {
		const h = harness({ sandboxDiff: "converged diff" });
		const res = await runConvergeInSandbox(routineFrom(CONVERGE), { task: "x" }, h.deps);
		expect(res.receipt.status).toBe("converged");
		expect(res.debugPatch).toBeUndefined();
	});

	test("an empty patch on a failed run does not set debugPatch", async () => {
		const adapter: Adapter = {
			async call() {
				throw new Error("boom");
			},
		};
		const h = harness({ adapter, sandboxDiff: "" });
		const res = await runConvergeInSandbox(routineFrom(CONVERGE), { task: "x" }, h.deps);
		expect(res.receipt.status).toBe("failed");
		expect(res.debugPatch).toBeUndefined();
	});
});

describe("runConvergeInSandbox -- per-step output evidence", () => {
	test("call step receipts include bounded output", async () => {
		const h = harness();
		const res = await runConvergeInSandbox(routineFrom(CONVERGE), { task: "hello" }, h.deps);
		const callStep = res.receipt.iterations[0]?.steps.find((s) => s.kind === "call");
		expect(callStep?.output).toBeDefined();
		expect(typeof callStep?.output).toBe("string");
	});

	test("check step receipts include output evidence on failure", async () => {
		const checkRunner = fakeCheckRunner(() => ({ ok: false, exitCode: 1, output: "test output: 3 failed" }));
		const h = harness({ checkRunner });
		const res = await runConvergeInSandbox(routineFrom(CONVERGE), { task: "x" }, h.deps);
		const checkStep = res.receipt.iterations[0]?.steps.find((s) => s.kind === "check");
		expect(checkStep?.output).toMatch(/test output/);
		// Individual check receipts also carry output
		expect(checkStep?.checks?.[0]?.output).toMatch(/test output/);
	});
});
