// End-to-end acceptance matrix: every routine shape, driven through the real CLI
// (runCli) against a REAL git-worktree sandbox and REAL checks, with only the model
// call faked. This is the "is the product shape boring and reliable" proof. The
// other test files isolate one seam with fakes; this one wires the real dispatch,
// write-safety, diff/apply/discard, converge loop, composition, and cancellation
// together against real git -- deterministically, with no claude.
//
// The model stub stands in for claude: it returns scripted text and, for a
// read-write participant, performs the edits the real model would, so a real diff
// (and a real apply) actually happens inside the sandbox.

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import type { Adapter, AdapterRequest } from "./adapter.ts";
import { argvCheckRunner } from "./check-runner.ts";
import { type CliDeps, runCli } from "./cli.ts";
import type { ConvergeReceipt } from "./converge.ts";
import type { FlowReceipt } from "./flow.ts";
import type { RunReceipt } from "./run.ts";
import { gitWorktreeSandboxFactory } from "./sandbox.ts";
import { loadReceipt } from "./store.ts";
import { formatTrace } from "./views.ts";

function modelStub(onCall: (req: AdapterRequest, callIndex: number) => string): Adapter {
	let i = 0;
	return {
		async call(req) {
			return { output: onCall(req, i++) };
		},
	};
}

const repos: string[] = [];
function newRepo(manifests: Record<string, unknown>, config: unknown): string {
	const repo = mkdtempSync(join(tmpdir(), "chit-accept-"));
	repos.push(repo);
	const sh = (cmd: string) => {
		const r = Bun.spawnSync(["sh", "-c", cmd], { cwd: repo });
		if (r.exitCode !== 0) throw new Error(`${cmd}: ${new TextDecoder().decode(r.stderr)}`);
	};
	sh("git init -q && git config user.email t@t.co && git config user.name tester");
	for (const [name, m] of Object.entries(manifests)) writeFileSync(join(repo, `${name}.json`), JSON.stringify(m));
	// every test manifest uses agent "claude"; bind it unless the config says otherwise
	const full = { agents: { claude: { adapter: "claude", model: "default" } }, ...(config as object) };
	writeFileSync(join(repo, "chit.config.json"), JSON.stringify(full));
	writeFileSync(join(repo, "seed.txt"), "seed\n");
	sh("git add -A && git commit -q -m init");
	return repo;
}

afterEach(() => {
	for (const r of repos.splice(0)) rmSync(r, { recursive: true, force: true });
});

function harness(repo: string, adapter: Adapter, over: Partial<CliDeps> = {}) {
	const out: string[] = [];
	const err: string[] = [];
	let t = 0;
	let rid = 0;
	const deps: CliDeps = {
		cwd: repo,
		adapters: { claude: adapter },
		checkRunner: argvCheckRunner,
		sandboxFactory: gitWorktreeSandboxFactory,
		now: () => (t += 1),
		// unique per run/sub-run, so a composition's receipts do not overwrite each other
		newRunId: () => `run-accept-${rid++}`,
		out: (l) => out.push(l),
		err: (l) => err.push(l),
		...over,
	};
	return { deps, out, err };
}

// Manifests reused across cases.
const GRILLER = {
	id: "griller",
	inputs: { idea: { type: "string" } },
	participants: { g: { agent: "claude", instructions: "Inspect.", filesystem: "read-only" } },
	steps: [{ id: "out", call: "g", prompt: "grill {{ inputs.idea }}" }],
	output: "out",
};
const WRITEY = {
	id: "writey",
	participants: { w: { agent: "claude", instructions: "Edit.", filesystem: "read-write" } },
	steps: [{ id: "go", call: "w", prompt: "do it" }],
};
// A read-write call that creates `made.txt` in its (sandbox) cwd.
const writeMade = modelStub((req) => {
	if (req.filesystem === "read-write") writeFileSync(join(req.cwd, "made.txt"), "made\n");
	return "edited";
});

describe("acceptance matrix (real git sandbox, faked model)", () => {
	test("text: runs read-only in the cwd and prints output, no sandbox", async () => {
		const repo = newRepo({ griller: GRILLER }, { routines: { griller: { manifestPath: "griller.json" } } });
		const { deps, out } = harness(repo, modelStub((req) => `GRILLED(${req.prompt})`));
		expect(await runCli(["run", "griller", "--input", "idea=dark mode"], deps)).toBe(0);
		expect(out.join("\n")).toContain("GRILLED(grill dark mode)");
		expect(Bun.spawnSync(["git", "worktree", "list"], { cwd: repo }).stdout.toString().includes("chit-sbx-")).toBe(false);
	});

	test("single-pass sandboxed: dry-run shows the diff and leaves origin untouched", async () => {
		const repo = newRepo({ writey: WRITEY }, { routines: { writey: { manifestPath: "writey.json" } } });
		const { deps, out } = harness(repo, writeMade);
		expect(await runCli(["run", "writey"], deps)).toBe(0);
		const text = out.join("\n");
		expect(text).toContain("made.txt"); // the diff names the new file
		expect(text).toMatch(/dry run/);
		expect(existsSync(join(repo, "made.txt"))).toBe(false); // origin untouched
	});

	test("single-pass sandboxed: --auto-apply writes the result back to origin", async () => {
		const repo = newRepo({ writey: WRITEY }, { routines: { writey: { manifestPath: "writey.json" } } });
		const { deps, out } = harness(repo, writeMade);
		expect(await runCli(["run", "writey", "--auto-apply"], deps)).toBe(0);
		expect(out.join("\n")).toMatch(/applied to/);
		expect(readFileSync(join(repo, "made.txt"), "utf-8")).toBe("made\n"); // origin written
	});

	test("loop: the check fails, the model fixes it, the run converges and applies", async () => {
		const impl = {
			id: "impl",
			inputs: { task: { type: "string" } },
			participants: { b: { agent: "claude", instructions: "Build.", filesystem: "read-write" } },
			steps: [
				{ id: "build", call: "b", prompt: "{{ inputs.task }} iter {{ iteration }}" },
				{ id: "verify", check: [{ command: "sh", args: ["-c", "test -f ready.txt"] }] },
			],
			repeat: { until: "checks-pass", maxIterations: 3 },
		};
		const repo = newRepo({ impl }, { routines: { impl: { manifestPath: "impl.json" } } });
		// the builder only produces the file the check wants on its SECOND turn
		let builds = 0;
		const adapter = modelStub((req) => {
			if (req.filesystem === "read-write") {
				builds += 1;
				if (builds >= 2) writeFileSync(join(req.cwd, "ready.txt"), "ok\n");
			}
			return "working";
		});
		const { deps, out } = harness(repo, adapter);
		expect(await runCli(["run", "impl", "--input", "task=x", "--auto-apply"], deps)).toBe(0);
		expect(out.join("\n")).toMatch(/run converged \(2 iterations\)/);
		expect(out.join("\n")).toMatch(/applied to/);
		expect(existsSync(join(repo, "ready.txt"))).toBe(true);

		// receipt-level: the persisted receipt carries the timeline and per-step status
		const receipt = loadReceipt(repo, "run-accept-0") as ConvergeReceipt;
		expect(receipt.status).toBe("converged");
		expect(receipt.iterations).toHaveLength(2);
		expect(typeof receipt.iterations[0]?.startedAt).toBe("number");
		expect(receipt.iterations[1]?.steps.every((s) => typeof s.startedAt === "number")).toBe(true);
		expect(receipt.iterations[1]?.steps.at(-1)).toMatchObject({ id: "verify", status: "ok" });
	});

	test("check-only: a passing check converges with no changes", async () => {
		const smoke = {
			id: "smoke",
			inputs: {},
			steps: [{ id: "verify", check: [{ command: "sh", args: ["-c", "true"] }] }],
			repeat: { until: "checks-pass", maxIterations: 1 },
		};
		const repo = newRepo({ smoke }, { routines: { smoke: { manifestPath: "smoke.json" } } });
		const { deps, out } = harness(repo, modelStub(() => "")); // this routine makes no calls
		expect(await runCli(["run", "smoke"], deps)).toBe(0);
		const text = out.join("\n");
		expect(text).toMatch(/run converged/);
		expect(text).toMatch(/no changes produced/);
	});

	test("composition: grill (text) -> impl (sandboxed); output forwards and applies", async () => {
		const impl = {
			id: "impl",
			inputs: { task: { type: "string" } },
			participants: { b: { agent: "claude", instructions: "Build.", filesystem: "read-write" } },
			steps: [{ id: "go", call: "b", prompt: "build {{ inputs.task }}" }],
		};
		const flow = {
			id: "flow",
			inputs: { idea: { type: "string" } },
			steps: [
				{ id: "grill", routine: "griller", inputs: { idea: "{{ inputs.idea }}" } },
				{ id: "impl", routine: "impl", inputs: { task: "{{ steps.grill.output }}" } },
			],
		};
		const repo = newRepo(
			{ griller: GRILLER, impl, flow },
			{ routines: { griller: { manifestPath: "griller.json" }, impl: { manifestPath: "impl.json" }, flow: { manifestPath: "flow.json" } } },
		);
		const adapter = modelStub((req) => {
			if (req.filesystem === "read-write") {
				writeFileSync(join(req.cwd, "built.txt"), `built from: ${req.prompt}\n`);
				return "done";
			}
			return "GRILLED-IDEA";
		});
		const { deps, out } = harness(repo, adapter);
		expect(await runCli(["run", "flow", "--input", "idea=feature", "--auto-apply"], deps)).toBe(0);
		const text = out.join("\n");
		expect(text).toContain("grill -> griller: completed");
		expect(text).toContain("impl -> impl: converged");
		expect(text).toMatch(/applied to/);
		// grill's output flowed into impl's prompt, then into the file impl wrote
		expect(readFileSync(join(repo, "built.txt"), "utf-8")).toContain("build GRILLED-IDEA");

		// receipt-level: the flow links its sub-runs, which are persisted separately
		const flowReceipt = loadReceipt(repo, "run-accept-0") as FlowReceipt;
		expect(flowReceipt.policy).toBe("flow");
		expect(flowReceipt.steps.map((s) => (s.kind === "ask" ? "-" : s.subRunId))).toEqual(["run-accept-1", "run-accept-2"]);
		expect(loadReceipt(repo, "run-accept-1").routineId).toBe("griller");
		expect(loadReceipt(repo, "run-accept-2").routineId).toBe("impl");
	});

	test("interrupted: a pre-aborted run cancels, discards the worktree, exits 130", async () => {
		const repo = newRepo({ writey: WRITEY }, { routines: { writey: { manifestPath: "writey.json" } } });
		const controller = new AbortController();
		controller.abort();
		const { deps, err } = harness(repo, writeMade, { signal: controller.signal });
		expect(await runCli(["run", "writey"], deps)).toBe(130);
		expect(err.join("\n")).toMatch(/cancelled/);
		expect(existsSync(join(repo, "made.txt"))).toBe(false); // origin untouched
		const worktrees = Bun.spawnSync(["git", "worktree", "list"], { cwd: repo }).stdout.toString();
		expect(worktrees.includes("chit-sbx-")).toBe(false); // no leftover sandbox worktree

		// receipt-level: a cancelled receipt is persisted
		const receipt = loadReceipt(repo, "run-accept-0") as ConvergeReceipt;
		expect(receipt.status).toBe("cancelled");
	});
});

describe("acceptance matrix -- failure cases", () => {
	test("did-not-converge: --auto-apply does NOT write a non-converged result", async () => {
		const impl = {
			id: "impl",
			participants: { b: { agent: "claude", instructions: "Build.", filesystem: "read-write" } },
			steps: [
				{ id: "build", call: "b", prompt: "try" },
				{ id: "verify", check: [{ command: "sh", args: ["-c", "test -f goal.txt"] }] }, // never created
			],
			repeat: { until: "checks-pass", maxIterations: 2 },
		};
		const repo = newRepo({ impl }, { routines: { impl: { manifestPath: "impl.json" } } });
		// the builder writes a file, but never the one the check wants
		const adapter = modelStub((req) => {
			if (req.filesystem === "read-write") writeFileSync(join(req.cwd, "attempt.txt"), "x\n");
			return "tried";
		});
		const { deps, out } = harness(repo, adapter);
		expect(await runCli(["run", "impl", "--auto-apply"], deps)).toBe(1);
		expect(out.join("\n")).toMatch(/run did-not-converge/);
		expect(existsSync(join(repo, "attempt.txt"))).toBe(false); // never applied
		const receipt = loadReceipt(repo, "run-accept-0") as ConvergeReceipt;
		expect(receipt.status).toBe("did-not-converge");
		expect(receipt.iterations).toHaveLength(2);
	});

	test("failed: a throwing model call yields a failed receipt and exit 1", async () => {
		const repo = newRepo({ griller: GRILLER }, { routines: { griller: { manifestPath: "griller.json" } } });
		const adapter: Adapter = {
			async call() {
				throw new Error("model exploded");
			},
		};
		const { deps, err } = harness(repo, adapter);
		expect(await runCli(["run", "griller", "--input", "idea=x"], deps)).toBe(1);
		expect(err.join("\n")).toMatch(/failed/);
		const receipt = loadReceipt(repo, "run-accept-0") as RunReceipt;
		expect(receipt.status).toBe("failed");
		expect(receipt.steps.at(-1)).toMatchObject({ status: "failed" });
	});

	test("composition: a failing sub-run fails the flow and stops before the rest", async () => {
		const impl = {
			id: "impl",
			inputs: { task: { type: "string" } },
			participants: { b: { agent: "claude", instructions: "Build.", filesystem: "read-write" } },
			steps: [{ id: "go", call: "b", prompt: "build {{ inputs.task }}" }],
		};
		const flow = {
			id: "flow",
			inputs: { idea: { type: "string" } },
			steps: [
				{ id: "grill", routine: "griller", inputs: { idea: "{{ inputs.idea }}" } },
				{ id: "impl", routine: "impl", inputs: { task: "{{ steps.grill.output }}" } },
			],
		};
		const repo = newRepo(
			{ griller: GRILLER, impl, flow },
			{ routines: { griller: { manifestPath: "griller.json" }, impl: { manifestPath: "impl.json" }, flow: { manifestPath: "flow.json" } } },
		);
		// the first sub-run (grill, read-only) throws; the sandboxed impl must never run
		const adapter: Adapter = {
			async call(req) {
				if (req.filesystem === "read-only") throw new Error("grill failed");
				writeFileSync(join(req.cwd, "built.txt"), "should not happen\n");
				return { output: "done" };
			},
		};
		const { deps } = harness(repo, adapter);
		expect(await runCli(["run", "flow", "--input", "idea=x"], deps)).toBe(1);
		const flowReceipt = loadReceipt(repo, "run-accept-0") as FlowReceipt;
		expect(flowReceipt.status).toBe("failed");
		expect(flowReceipt.steps).toHaveLength(1); // stopped at grill
		expect(flowReceipt.steps[0]).toMatchObject({ id: "grill", status: "failed" });
		expect(existsSync(join(repo, "built.txt"))).toBe(false); // impl never ran
	});

	test("dirty origin is refused before a sandboxed run (a sandbox starts from HEAD)", async () => {
		const writeySeed = {
			id: "writey-seed",
			participants: { w: { agent: "claude", instructions: "Edit.", filesystem: "read-write" } },
			steps: [{ id: "go", call: "w", prompt: "edit the seed" }],
		};
		const repo = newRepo({ "writey-seed": writeySeed }, { routines: { "writey-seed": { manifestPath: "writey-seed.json" } } });
		writeFileSync(join(repo, "seed.txt"), "uncommitted change\n"); // dirty the origin
		let called = false;
		const adapter = modelStub(() => {
			called = true;
			return "done";
		});
		const { deps, err } = harness(repo, adapter);
		// even a DRY run is refused: it would compute a diff against HEAD, not your real tree
		expect(await runCli(["run", "writey-seed"], deps)).toBe(1);
		expect(err.join("\n")).toMatch(/Commit or stash/);
		expect(called).toBe(false); // refused before any model call
		expect(readFileSync(join(repo, "seed.txt"), "utf-8")).toBe("uncommitted change\n"); // untouched
		const worktrees = Bun.spawnSync(["git", "worktree", "list"], { cwd: repo }).stdout.toString();
		expect(worktrees.includes("chit-sbx-")).toBe(false); // no sandbox was ever created
		expect(() => loadReceipt(repo, "run-accept-0")).toThrow(); // the run never started, so no receipt
	});

	test("a flow with a sandboxed step refuses a dirty origin upfront, before any sub-routine runs", async () => {
		const impl = {
			id: "impl",
			inputs: { task: { type: "string" } },
			participants: { b: { agent: "claude", instructions: "Build.", filesystem: "read-write" } },
			steps: [{ id: "go", call: "b", prompt: "build {{ inputs.task }}" }],
		};
		const flow = {
			id: "flow",
			inputs: { idea: { type: "string" } },
			steps: [
				{ id: "grill", routine: "griller", inputs: { idea: "{{ inputs.idea }}" } },
				{ id: "impl", routine: "impl", inputs: { task: "{{ steps.grill.output }}" } },
			],
		};
		const repo = newRepo(
			{ griller: GRILLER, impl, flow },
			{ routines: { griller: { manifestPath: "griller.json" }, impl: { manifestPath: "impl.json" }, flow: { manifestPath: "flow.json" } } },
		);
		writeFileSync(join(repo, "seed.txt"), "uncommitted change\n"); // dirty the origin
		let called = false;
		const adapter = modelStub(() => {
			called = true;
			return "x";
		});
		const { deps, err } = harness(repo, adapter);
		expect(await runCli(["run", "flow", "--input", "idea=x"], deps)).toBe(1);
		expect(err.join("\n")).toMatch(/Commit or stash/);
		// fail-fast: the dirty check ran BEFORE grill, so no model call happened and no run id was used
		expect(called).toBe(false);
		expect(() => loadReceipt(repo, "run-accept-0")).toThrow();
	});

	test("interrupted in-flight: an abort during a running check cancels and discards", async () => {
		const slow = {
			id: "slow",
			inputs: {},
			steps: [{ id: "wait", check: [{ command: "sh", args: ["-c", "sleep 2"] }] }],
			repeat: { until: "checks-pass", maxIterations: 1 },
		};
		const repo = newRepo({ slow }, { routines: { slow: { manifestPath: "slow.json" } } });
		const controller = new AbortController();
		const { deps, err } = harness(repo, modelStub(() => ""), { signal: controller.signal });
		// abort asynchronously, after the run has started and the sleep check is in flight
		const timer = setTimeout(() => controller.abort(), 300);
		const code = await runCli(["run", "slow"], deps);
		clearTimeout(timer);
		expect(code).toBe(130);
		expect(err.join("\n")).toMatch(/cancelled/);
		const worktrees = Bun.spawnSync(["git", "worktree", "list"], { cwd: repo }).stdout.toString();
		expect(worktrees.includes("chit-sbx-")).toBe(false); // worktree discarded
	});
});
