import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LoopJobRecord } from "../jobs/types.ts";
import type { BatchEngineDeps, LaunchJobParams } from "./engine.ts";
import { PlanError, type TaskInput } from "./plan.ts";
import { BatchStore } from "./store.ts";
import { BatchApprovalRefused, type BatchStartInput, runBatchStart } from "./tools.ts";

let stateDir: string;
let savedXdg: string | undefined;
beforeEach(() => {
	// BatchStore writes under XDG_STATE_HOME; isolate it so runBatchStart persists into a temp dir.
	stateDir = mkdtempSync(join(tmpdir(), "chit-batch-tools-state-"));
	savedXdg = process.env.XDG_STATE_HOME;
	process.env.XDG_STATE_HOME = stateDir;
});
afterEach(() => {
	if (savedXdg === undefined) delete process.env.XDG_STATE_HOME;
	else process.env.XDG_STATE_HOME = savedXdg;
	rmSync(stateDir, { recursive: true, force: true });
});

function present<T>(v: T | undefined, what: string): T {
	if (v === undefined) throw new Error(`expected ${what} to be present`);
	return v;
}

const ok = (stdout = ""): { code: number; stdout: string; stderr: string } => ({
	code: 0,
	stdout,
	stderr: "",
});

// A plain main-repo checkout: --git-common-dir is <cwd>/.git, so mainRepoOfWorktree
// resolves repo back to cwd (repo === callerCheckout for a non-linked launch). A symbolic
// ref (HEAD / develop) resolves to the harness's current head sha (mutable, so a test can
// simulate the ref moving after approval); a concrete sha resolves to itself, so pinning a
// launch to base.sha lands on that exact commit.
function makeHarness() {
	const cwd = realpathSync(mkdtempSync(join(tmpdir(), "chit-batch-start-cwd-")));
	const jobs = new Map<string, LoopJobRecord>();
	const launched: LaunchJobParams[] = [];
	let seq = 0;
	let wtSeq = 0;
	let headSha = "sha-approved";
	const setHeadSha = (sha: string) => {
		headSha = sha;
	};
	const git: BatchEngineDeps["git"] = (args) => {
		if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return ok(`${cwd}\n`);
		if (args[0] === "rev-parse" && args[1] === "--git-common-dir") return ok(`${cwd}/.git\n`);
		if (args[0] === "rev-parse") {
			const ref = args[1] ?? "HEAD";
			// Symbolic refs follow the moving head; a concrete sha resolves to itself.
			if (ref === "HEAD" || ref === "develop") return ok(`${headSha}\n`);
			return ok(`${ref}\n`);
		}
		return ok("");
	};
	const deps: BatchEngineDeps = {
		git,
		createWorktree: (_repo, cid, tid) => ({
			worktreePath: `/wt/${cid}/${tid}-${++wtSeq}`,
			branch: `chit-batch/${cid}/${tid}`,
		}),
		launchJob: (p) => {
			const jobId = `job-${++seq}`;
			jobs.set(jobId, {
				runId: jobId,
				policy: "loop",
				loopId: p.loopId,
				repoKey: "k",
				cwd: p.cwd,
				...p.worktree,
				scope: p.scope,
				task: p.task,
				maxIterations: p.maxIterations,
				allowUnenforced: false,
				state: "queued",
				createdAt: "t",
				iterationsCompleted: 0,
				auditRefs: [],
			});
			launched.push(p);
			return { jobId, loopId: p.loopId };
		},
		getJob: (id) => jobs.get(id),
		cancelJob: () => {},
		isStale: () => false,
		loopDetail: () => ({ changedFiles: [], workspaceWarnings: [] }),
		now: () => 1000,
	};
	return { cwd, deps, store: new BatchStore(cwd), jobs, launched, setHeadSha };
}

const TASKS: TaskInput[] = [
	{ id: "a", title: "A", body: "do a", claimedPaths: ["src/a"] },
	{ id: "b", title: "B", body: "do b", claimedPaths: ["src/b"], dependencies: ["a"] },
];

// The genId that a dry run must never reach (a dry run creates no batch, so no id is drawn).
const noLaunch = () => {
	throw new Error("genId must not be called on a dry run");
};

describe("runBatchStart: dry run (the default, no confirm)", () => {
	test("returns the normalized graph, resolved base, effective knobs, and a hash; launches nothing", () => {
		const { cwd, deps, store, launched } = makeHarness();
		const result = runBatchStart({ tasks: TASKS }, cwd, store, deps, noLaunch);
		expect(result.launched).toBe(false);
		if (result.launched) throw new Error("expected a dry run");
		expect(result.strategy).toBe("batch");
		expect(result.tasks.map((t) => t.id)).toEqual(["a", "b"]);
		// The base ref defaults to HEAD and resolves to the harness head sha.
		expect(result.base).toEqual({ ref: "HEAD", sha: "sha-approved" });
		// The effective knobs (schema/engine defaults) are surfaced for the operator to approve.
		expect(result.maxParallel).toBe(2);
		expect(result.maxIterations).toBe(3);
		expect(result.approvalHash).toMatch(/^[0-9a-f]{64}$/);
		// No batch record, no job, no worktree.
		expect(store.list()).toHaveLength(0);
		expect(launched).toHaveLength(0);
	});

	test("resolves an explicit base_branch ref to its commit for the approval", () => {
		const { cwd, deps, store } = makeHarness();
		const result = runBatchStart(
			{ tasks: TASKS, baseBranch: "develop" },
			cwd,
			store,
			deps,
			noLaunch,
		);
		if (result.launched) throw new Error("expected a dry run");
		expect(result.base).toEqual({ ref: "develop", sha: "sha-approved" });
	});

	test("clamps max_parallel to the cap when binding the approved knob", () => {
		const { cwd, deps, store } = makeHarness();
		const result = runBatchStart({ tasks: TASKS, maxParallel: 99 }, cwd, store, deps, noLaunch);
		if (result.launched) throw new Error("expected a dry run");
		// MAX_PARALLEL_CAP is 4: the operator approves the value startBatch will actually run with.
		expect(result.maxParallel).toBe(4);
	});

	test("rejects a malformed graph at the gate (before any base resolve or mutation)", () => {
		const { cwd, deps, store } = makeHarness();
		const cyclic: TaskInput[] = [
			{ id: "a", title: "A", body: "x", claimedPaths: ["a"], dependencies: ["b"] },
			{ id: "b", title: "B", body: "y", claimedPaths: ["b"], dependencies: ["a"] },
		];
		expect(() => runBatchStart({ tasks: cyclic }, cwd, store, deps, noLaunch)).toThrow(PlanError);
	});
});

// Re-run the dry run THEN confirm with the hash it returned, mirroring the operator flow.
function approveAndConfirm(
	h: ReturnType<typeof makeHarness>,
	input: BatchStartInput,
	genId: () => string,
) {
	const dry = runBatchStart(input, h.cwd, h.store, h.deps, noLaunch);
	if (dry.launched) throw new Error("expected a dry run");
	return runBatchStart(
		{ ...input, confirm: true, approvalHash: dry.approvalHash },
		h.cwd,
		h.store,
		h.deps,
		genId,
	);
}

describe("runBatchStart: confirmed launch (hash-gated)", () => {
	test("a matching approval_hash launches the first wave and persists, pinned to the base sha", () => {
		const h = makeHarness();
		const result = approveAndConfirm(h, { tasks: TASKS }, () => "gen-id");
		expect(result.launched).toBe(true);
		if (!result.launched) throw new Error("expected a launch");
		expect(result.view.batch_id).toBe("gen-id");
		const a = present(
			result.view.tasks.find((t) => t.id === "a"),
			"task a",
		);
		const b = present(
			result.view.tasks.find((t) => t.id === "b"),
			"task b",
		);
		expect(a.status).toBe("running"); // no deps -> launched in the first wave
		expect(b.status).toBe("pending"); // the dependent waits
		// The launch is pinned to the approved COMMIT, not the ref: baseSha is the resolved sha and
		// baseBranch is recorded as that sha (never "HEAD"), so a later ref move cannot redirect it.
		expect(result.view.baseSha).toBe("sha-approved");
		expect(result.view.baseBranch).toBe("sha-approved");
		expect(result.base).toEqual({ ref: "HEAD", sha: "sha-approved" });
		// Persisted once; only the runnable (no-dependency) task launched its worktree job.
		expect(present(h.store.get("gen-id"), "stored batch").id).toBe("gen-id");
		expect(h.launched).toHaveLength(1);
		expect(present(h.launched[0], "launched a").worktree.repo).toBe(h.cwd);
		expect(present(h.launched[0], "launched a").worktree.baseSha).toBe("sha-approved");
	});

	test("base sha pinning: the launch is handed the approved COMMIT, never the symbolic ref", () => {
		const h = makeHarness();
		// Approve against the symbolic ref HEAD (resolves to sha-approved).
		const result = approveAndConfirm(h, { tasks: TASKS }, () => "pinned");
		if (!result.launched) throw new Error("expected a launch");
		// runBatchStart pins startBatch's baseBranch to base.sha, so the PERSISTED batch records the
		// concrete commit ("sha-approved"), not the symbolic "HEAD" it was approved against. A
		// concrete sha resolves to itself, so a later HEAD move can never redirect the task worktrees.
		expect(result.base.ref).toBe("HEAD");
		const stored = present(h.store.get("pinned"), "stored batch");
		expect(stored.baseBranch).toBe("sha-approved");
		expect(stored.baseSha).toBe("sha-approved");
		// Every launched task worktree branches from the approved commit.
		expect(present(h.launched[0], "launched a").worktree.baseSha).toBe("sha-approved");
	});

	test("forwards the effective knobs (bound into the hash) onto the launched job", () => {
		const h = makeHarness();
		const result = approveAndConfirm(
			h,
			{ tasks: TASKS, baseBranch: "develop", maxIterations: 7, callTimeoutMs: 1234 },
			() => "p",
		);
		if (!result.launched) throw new Error("expected a launch");
		const a = present(h.launched[0], "launched a");
		expect(a.maxIterations).toBe(7);
		expect(a.callTimeoutMs).toBe(1234);
	});
});

describe("runBatchStart: the gate refuses before any mutation", () => {
	test("confirm with no approval_hash is refused", () => {
		const { cwd, deps, store, launched } = makeHarness();
		expect(() =>
			runBatchStart({ tasks: TASKS, confirm: true }, cwd, store, deps, noLaunch),
		).toThrow(BatchApprovalRefused);
		expect(store.list()).toHaveLength(0);
		expect(launched).toHaveLength(0);
	});

	test("confirm with a wrong approval_hash is refused", () => {
		const { cwd, deps, store, launched } = makeHarness();
		expect(() =>
			runBatchStart(
				{ tasks: TASKS, confirm: true, approvalHash: "deadbeef" },
				cwd,
				store,
				deps,
				noLaunch,
			),
		).toThrow(BatchApprovalRefused);
		expect(store.list()).toHaveLength(0);
		expect(launched).toHaveLength(0);
	});

	test("a changed task graph is refused with the old hash", () => {
		const { cwd, deps, store, launched } = makeHarness();
		const dry = runBatchStart({ tasks: TASKS }, cwd, store, deps, noLaunch);
		if (dry.launched) throw new Error("expected a dry run");
		const edited: TaskInput[] = [
			TASKS[0] as TaskInput,
			{ ...(TASKS[1] as TaskInput), body: "do b DIFFERENTLY" },
		];
		expect(() =>
			runBatchStart(
				{ tasks: edited, confirm: true, approvalHash: dry.approvalHash },
				cwd,
				store,
				deps,
				noLaunch,
			),
		).toThrow(BatchApprovalRefused);
		expect(launched).toHaveLength(0);
	});

	test("a changed base ref is refused with the old hash", () => {
		const { cwd, deps, store, launched } = makeHarness();
		const dry = runBatchStart({ tasks: TASKS }, cwd, store, deps, noLaunch);
		if (dry.launched) throw new Error("expected a dry run");
		// Approved against HEAD; confirming against a different ref (develop) recomputes a different
		// hash even though both resolve to the same sha here, because the ref is part of the artifact.
		expect(() =>
			runBatchStart(
				{ tasks: TASKS, baseBranch: "develop", confirm: true, approvalHash: dry.approvalHash },
				cwd,
				store,
				deps,
				noLaunch,
			),
		).toThrow(BatchApprovalRefused);
		expect(launched).toHaveLength(0);
	});

	test("a moved base sha (same ref) is refused with the old hash", () => {
		const h = makeHarness();
		const dry = runBatchStart({ tasks: TASKS }, h.cwd, h.store, h.deps, noLaunch);
		if (dry.launched) throw new Error("expected a dry run");
		// The ref (HEAD) is unchanged, but its commit moved after approval.
		h.setHeadSha("sha-moved");
		expect(() =>
			runBatchStart(
				{ tasks: TASKS, confirm: true, approvalHash: dry.approvalHash },
				h.cwd,
				h.store,
				h.deps,
				noLaunch,
			),
		).toThrow(BatchApprovalRefused);
		expect(h.launched).toHaveLength(0);
	});

	test("a changed knob (max_parallel) is refused with the old hash (the knobs are bound)", () => {
		const { cwd, deps, store, launched } = makeHarness();
		const dry = runBatchStart({ tasks: TASKS, maxParallel: 2 }, cwd, store, deps, noLaunch);
		if (dry.launched) throw new Error("expected a dry run");
		expect(() =>
			runBatchStart(
				{ tasks: TASKS, maxParallel: 3, confirm: true, approvalHash: dry.approvalHash },
				cwd,
				store,
				deps,
				noLaunch,
			),
		).toThrow(BatchApprovalRefused);
		expect(launched).toHaveLength(0);
	});

	test("a changed max_iterations is refused with the old hash (the budget is bound)", () => {
		const { cwd, deps, store, launched } = makeHarness();
		const dry = runBatchStart({ tasks: TASKS, maxIterations: 3 }, cwd, store, deps, noLaunch);
		if (dry.launched) throw new Error("expected a dry run");
		expect(() =>
			runBatchStart(
				{ tasks: TASKS, maxIterations: 9, confirm: true, approvalHash: dry.approvalHash },
				cwd,
				store,
				deps,
				noLaunch,
			),
		).toThrow(BatchApprovalRefused);
		expect(launched).toHaveLength(0);
	});
});
