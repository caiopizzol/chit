import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ManifestBinding } from "@chit-run/core";
import { loadConfig } from "../config/load.ts";
import type { LoopJobRecord } from "../jobs/types.ts";
import {
	type ResolvedRecipe,
	resolveManifestBindingWith,
	resolveRecipe,
} from "../manifest/binding.ts";
import type { BatchEngineDeps, LaunchJobParams } from "./engine.ts";
import { PlanError, type TaskInput } from "./plan.ts";
import { BatchStore } from "./store.ts";
import { BatchApprovalRefused, type BatchStartInput, runBatchStart } from "./tools.ts";
import type { GitResult, GitRunner } from "./worktree.ts";

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

function shellGit(args: string[], cwd: string): GitResult {
	try {
		return {
			code: 0,
			stdout: execFileSync("git", args, { cwd, encoding: "utf-8" }),
			stderr: "",
		};
	} catch (e) {
		const err = e as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string };
		return {
			code: err.status ?? 1,
			stdout: String(err.stdout ?? ""),
			stderr: String(err.stderr ?? ""),
		};
	}
}

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

// --- manifest binding at the gate: the approval hash binds the execution surface ---

function gateBinding(manifestPath: string, digest: string): ManifestBinding {
	return {
		manifestPath,
		source: "git",
		manifestDigest: digest,
		participants: {
			implementer: {
				agentId: "claude",
				adapter: "claude-cli",
				session: "per_scope",
				permissions: { filesystem: "write" },
				enforcesReadOnly: false,
				config: {},
			},
		},
	};
}

describe("runBatchStart: manifest binding (digest + participant summary in the hash)", () => {
	test("a relative manifest path is normalized repo-root relative and bound from the base commit", () => {
		const h = makeHarness();
		const requests: Array<{ manifestPath: string; baseSha: string }> = [];
		h.deps.resolveManifestBinding = (p) => {
			requests.push({ manifestPath: p.manifestPath, baseSha: p.baseSha });
			return gateBinding(p.manifestPath, "sha256:aaaa");
		};
		const result = runBatchStart(
			{
				tasks: [
					{
						id: "a",
						title: "A",
						body: "do a",
						claimedPaths: ["src/a"],
						manifestPath: "manifests/own.json",
					},
					{ id: "b", title: "B", body: "do b", claimedPaths: ["src/b"] },
				],
				manifestPath: "manifests/default.json",
			},
			h.cwd,
			h.store,
			h.deps,
			noLaunch,
		);
		if (result.launched) throw new Error("expected a dry run");
		// Identities are repo-root relative (NOT absolutized into the caller checkout),
		// and every binding resolves from the approved base commit.
		expect(result.manifestPath).toBe("manifests/default.json");
		expect(present(result.tasks[0], "task a").manifestPath).toBe("manifests/own.json");
		expect(result.manifests?.batch?.manifestPath).toBe("manifests/default.json");
		expect(result.manifests?.tasks?.a?.manifestPath).toBe("manifests/own.json");
		expect(result.manifests?.tasks?.b).toBeUndefined();
		for (const r of requests) expect(r.baseSha).toBe("sha-approved");
	});

	test("an absolute manifest path stays absolute and is bound as a file read", () => {
		const h = makeHarness();
		h.deps.resolveManifestBinding = (p) => ({
			...gateBinding(p.manifestPath, "sha256:abs"),
			source: "file",
		});
		const result = runBatchStart(
			{ tasks: TASKS, manifestPath: "/global/manifest.json" },
			h.cwd,
			h.store,
			h.deps,
			noLaunch,
		);
		if (result.launched) throw new Error("expected a dry run");
		expect(result.manifestPath).toBe("/global/manifest.json");
		expect(result.manifests?.batch?.source).toBe("file");
	});

	test("a manifest whose content changed after the dry run is refused at confirm", () => {
		const h = makeHarness();
		let digest = "sha256:aaaa";
		h.deps.resolveManifestBinding = (p) => gateBinding(p.manifestPath, digest);
		const input: BatchStartInput = { tasks: TASKS, manifestPath: "manifests/default.json" };
		const dry = runBatchStart(input, h.cwd, h.store, h.deps, noLaunch);
		if (dry.launched) throw new Error("expected a dry run");
		digest = "sha256:bbbb"; // the manifest content moved between dry run and confirm
		expect(() =>
			runBatchStart(
				{ ...input, confirm: true, approvalHash: dry.approvalHash },
				h.cwd,
				h.store,
				h.deps,
				noLaunch,
			),
		).toThrow(BatchApprovalRefused);
		expect(h.launched).toHaveLength(0);
	});

	test("a confirmed start persists the approved bindings on the batch record", () => {
		const h = makeHarness();
		h.deps.resolveManifestBinding = (p) => gateBinding(p.manifestPath, "sha256:aaaa");
		const input: BatchStartInput = { tasks: TASKS, manifestPath: "manifests/default.json" };
		const dry = runBatchStart(input, h.cwd, h.store, h.deps, noLaunch);
		if (dry.launched) throw new Error("expected a dry run");
		const confirmed = runBatchStart(
			{ ...input, confirm: true, approvalHash: dry.approvalHash },
			h.cwd,
			h.store,
			h.deps,
			() => "batch-id",
		);
		if (!confirmed.launched) throw new Error("expected a launch");
		const stored = present(h.store.get("batch-id"), "stored batch");
		expect(stored.manifests?.batch?.manifestDigest).toBe("sha256:aaaa");
		// The launched job carries the digest for the worker's own re-verification, and
		// the task view stamps it for receipts.
		expect(present(h.launched[0], "launched a").manifestDigest).toBe("sha256:aaaa");
		const taskA = present(
			confirmed.view.tasks.find((t) => t.id === "a"),
			"task a view",
		);
		expect(taskA.manifestDigest).toBe("sha256:aaaa");
	});

	test("a repo-escaping manifest path is refused at the gate", () => {
		const h = makeHarness();
		h.deps.resolveManifestBinding = (p) => gateBinding(p.manifestPath, "sha256:aaaa");
		expect(() =>
			runBatchStart(
				{ tasks: TASKS, manifestPath: "../outside.json" },
				h.cwd,
				h.store,
				h.deps,
				noLaunch,
			),
		).toThrow(/escapes the repo/);
		expect(h.launched).toHaveLength(0);
	});

	test("an unresolvable manifest reference is refused at the gate as a PlanError", () => {
		const h = makeHarness();
		h.deps.resolveManifestBinding = () => {
			throw new Error("no manifests/default.json in the git tree at sha-approved");
		};
		expect(() =>
			runBatchStart(
				{ tasks: TASKS, manifestPath: "manifests/default.json" },
				h.cwd,
				h.store,
				h.deps,
				noLaunch,
			),
		).toThrow(PlanError);
		expect(h.launched).toHaveLength(0);
	});
});

// --- recipe selections at the gate: the approval hash binds what each recipe
// resolved to (identity, defaults, manifest digest, participants), not the id string. ---

function gateRecipe(over: Partial<ResolvedRecipe> = {}): ResolvedRecipe {
	return {
		id: "deep-feature",
		origin: { source: "repo", path: "chit.config.json" },
		mode: "converge",
		binding: gateBinding("manifests/converge.json", "sha256:aaaa"),
		maxIterations: 4,
		callTimeoutMs: 1200000,
		...over,
	};
}

describe("runBatchStart: recipe selections (resolved recipes in the hash)", () => {
	test("the dry run resolves task + batch recipes and previews receipts next to bindings", () => {
		const h = makeHarness();
		const requested: Array<{ recipeId: string; baseSha: string }> = [];
		h.deps.resolveRecipe = (p) => {
			requested.push({ recipeId: p.recipeId, baseSha: p.baseSha });
			return p.recipeId === "deep-feature"
				? gateRecipe()
				: gateRecipe({
						id: p.recipeId,
						binding: gateBinding("manifests/quick.json", "sha256:bbbb"),
						maxIterations: 2,
					});
		};
		const result = runBatchStart(
			{
				tasks: [
					{ id: "a", title: "A", body: "do a", claimedPaths: ["src/a"], recipe: "quick-fix" },
					{ id: "b", title: "B", body: "do b", claimedPaths: ["src/b"] },
				],
				recipe: "deep-feature",
			},
			h.cwd,
			h.store,
			h.deps,
			noLaunch,
		);
		if (result.launched) throw new Error("expected a dry run");
		// Every recipe resolves from the APPROVED base commit, like manifest bindings.
		for (const r of requested) expect(r.baseSha).toBe("sha-approved");
		// The receipts carry identity + provenance + defaults; the manifest content
		// surface lives in the bindings under the SAME batch/task slot.
		expect(result.recipe).toBe("deep-feature");
		expect(result.recipes?.batch).toEqual({
			id: "deep-feature",
			origin: { source: "repo", path: "chit.config.json" },
			mode: "converge",
			maxIterations: 4,
			callTimeoutMs: 1200000,
		});
		expect(result.recipes?.tasks?.a?.id).toBe("quick-fix");
		expect(result.recipes?.tasks?.b).toBeUndefined();
		expect(result.manifests?.batch?.manifestDigest).toBe("sha256:aaaa");
		expect(result.manifests?.tasks?.a?.manifestDigest).toBe("sha256:bbbb");
		// Effective batch budgets fold the batch recipe's defaults (nothing explicit given).
		expect(result.maxIterations).toBe(4);
		expect(result.callTimeoutMs).toBe(1200000);
	});

	test("explicit batch knobs beat the batch recipe's defaults in the effective values", () => {
		const h = makeHarness();
		h.deps.resolveRecipe = () => gateRecipe();
		const result = runBatchStart(
			{ tasks: TASKS, recipe: "deep-feature", maxIterations: 9, callTimeoutMs: 5000 },
			h.cwd,
			h.store,
			h.deps,
			noLaunch,
		);
		if (result.launched) throw new Error("expected a dry run");
		expect(result.maxIterations).toBe(9);
		expect(result.callTimeoutMs).toBe(5000);
	});

	test("a batch-level recipe and manifest_path together are refused before any resolution", () => {
		const h = makeHarness();
		expect(() =>
			runBatchStart(
				{ tasks: TASKS, recipe: "deep-feature", manifestPath: "manifests/own.json" },
				h.cwd,
				h.store,
				h.deps,
				noLaunch,
			),
		).toThrow(/mutually exclusive/);
	});

	test("a non-kebab-case batch-level recipe is refused (config recipe id rules)", () => {
		const h = makeHarness();
		expect(() =>
			runBatchStart(
				{ tasks: TASKS, recipe: "manifests/own.json" },
				h.cwd,
				h.store,
				h.deps,
				noLaunch,
			),
		).toThrow(/config recipe id/);
	});

	test("an unknown recipe is refused at the gate as a PlanError naming the surface", () => {
		const h = makeHarness();
		h.deps.resolveRecipe = () => {
			throw new Error('unknown recipe "ghost" (no recipes are configured)');
		};
		expect(() =>
			runBatchStart(
				{
					tasks: [{ id: "a", title: "A", body: "do a", claimedPaths: ["src/a"], recipe: "ghost" }],
				},
				h.cwd,
				h.store,
				h.deps,
				noLaunch,
			),
		).toThrow(PlanError);
		expect(() =>
			runBatchStart(
				{
					tasks: [{ id: "a", title: "A", body: "do a", claimedPaths: ["src/a"], recipe: "ghost" }],
				},
				h.cwd,
				h.store,
				h.deps,
				noLaunch,
			),
		).toThrow(/task "a" recipe: unknown recipe/);
	});

	test("a one-shot batch recipe is refused because batches launch loop jobs", () => {
		const h = makeHarness();
		h.deps.resolveRecipe = () =>
			gateRecipe({
				mode: "one-shot",
				maxIterations: undefined,
				callTimeoutMs: undefined,
			});
		expect(() =>
			runBatchStart({ tasks: TASKS, recipe: "deep-feature" }, h.cwd, h.store, h.deps, noLaunch),
		).toThrow(/recipe.*batch recipes must be converge recipes/);
		expect(h.launched).toHaveLength(0);
	});

	test("a one-shot task recipe is refused because batches launch loop jobs", () => {
		const h = makeHarness();
		h.deps.resolveRecipe = () =>
			gateRecipe({
				mode: "one-shot",
				maxIterations: undefined,
				callTimeoutMs: undefined,
			});
		expect(() =>
			runBatchStart(
				{
					tasks: [{ id: "a", title: "A", body: "do a", claimedPaths: ["src/a"], recipe: "ghost" }],
				},
				h.cwd,
				h.store,
				h.deps,
				noLaunch,
			),
		).toThrow(/task "a" recipe.*batch recipes must be converge recipes/);
		expect(h.launched).toHaveLength(0);
	});

	test("a recipe-naming batch with no recipe resolver wired is refused, not silently launched", () => {
		const h = makeHarness(); // makeHarness wires no resolveRecipe
		expect(() =>
			runBatchStart({ tasks: TASKS, recipe: "deep-feature" }, h.cwd, h.store, h.deps, noLaunch),
		).toThrow(/recipe resolution is not available/);
		expect(h.launched).toHaveLength(0);
	});

	test("a recipe default changed after the dry run is refused at confirm", () => {
		const h = makeHarness();
		let maxIterations = 4;
		h.deps.resolveRecipe = () => gateRecipe({ maxIterations });
		const input: BatchStartInput = { tasks: TASKS, recipe: "deep-feature" };
		const dry = runBatchStart(input, h.cwd, h.store, h.deps, noLaunch);
		if (dry.launched) throw new Error("expected a dry run");
		maxIterations = 9; // the recipe was redefined between dry run and confirm
		expect(() =>
			runBatchStart(
				{ ...input, confirm: true, approvalHash: dry.approvalHash },
				h.cwd,
				h.store,
				h.deps,
				noLaunch,
			),
		).toThrow(BatchApprovalRefused);
		expect(h.launched).toHaveLength(0);
	});

	test("a recipe whose manifest content changed after the dry run is refused at confirm", () => {
		const h = makeHarness();
		let digest = "sha256:aaaa";
		h.deps.resolveRecipe = () =>
			gateRecipe({ binding: gateBinding("manifests/converge.json", digest) });
		const input: BatchStartInput = { tasks: TASKS, recipe: "deep-feature" };
		const dry = runBatchStart(input, h.cwd, h.store, h.deps, noLaunch);
		if (dry.launched) throw new Error("expected a dry run");
		digest = "sha256:bbbb"; // the vetted manifest moved under the recipe
		expect(() =>
			runBatchStart(
				{ ...input, confirm: true, approvalHash: dry.approvalHash },
				h.cwd,
				h.store,
				h.deps,
				noLaunch,
			),
		).toThrow(BatchApprovalRefused);
		expect(h.launched).toHaveLength(0);
	});

	test("a confirmed start persists recipes + bindings and launches with the recipe wiring", () => {
		const h = makeHarness();
		h.deps.resolveRecipe = (p) =>
			p.recipeId === "deep-feature"
				? gateRecipe()
				: gateRecipe({
						id: p.recipeId,
						binding: gateBinding("manifests/quick.json", "sha256:bbbb"),
						maxIterations: 2,
						callTimeoutMs: 60000,
					});
		const input: BatchStartInput = {
			tasks: [
				{ id: "a", title: "A", body: "do a", claimedPaths: ["src/a"], recipe: "quick-fix" },
				// b uses the batch recipe's manifest + defaults, but its own explicit budget wins.
				{ id: "b", title: "B", body: "do b", claimedPaths: ["src/b"], maxIterations: 7 },
			],
			recipe: "deep-feature",
			maxParallel: 2,
		};
		const dry = runBatchStart(input, h.cwd, h.store, h.deps, noLaunch);
		if (dry.launched) throw new Error("expected a dry run");
		const confirmed = runBatchStart(
			{ ...input, confirm: true, approvalHash: dry.approvalHash },
			h.cwd,
			h.store,
			h.deps,
			() => "batch-id",
		);
		if (!confirmed.launched) throw new Error("expected a launch");
		// Persistence: the record carries the receipts, the batch recipe id, the
		// effective budget, and each recipe's STAMPED resolved manifest reference.
		const stored = present(h.store.get("batch-id"), "stored batch");
		expect(stored.recipe).toBe("deep-feature");
		expect(stored.maxIterations).toBe(4); // the batch recipe's default (nothing explicit)
		expect(stored.recipes?.batch?.id).toBe("deep-feature");
		expect(stored.recipes?.tasks?.a?.id).toBe("quick-fix");
		expect(stored.manifestPath).toBe("manifests/converge.json"); // stamped from the batch recipe
		const storedA = present(
			stored.tasks.find((t) => t.id === "a"),
			"stored task a",
		);
		expect(storedA.recipe).toBe("quick-fix");
		expect(storedA.manifestPath).toBe("manifests/quick.json"); // stamped from its recipe
		// Launch wiring: both tasks launched (independent claims, maxParallel 2). Task a
		// runs its recipe's manifest, digest, receipt, and defaults.
		expect(h.launched).toHaveLength(2);
		const launchedA = present(
			h.launched.find((l) => l.scope.endsWith("-a")),
			"launched a",
		);
		expect(launchedA.manifestPath).toBe("manifests/quick.json");
		expect(launchedA.manifestDigest).toBe("sha256:bbbb");
		expect(launchedA.recipe?.id).toBe("quick-fix");
		expect(launchedA.maxIterations).toBe(2); // its recipe's default
		expect(launchedA.callTimeoutMs).toBe(60000);
		// Task b runs the batch recipe's manifest, but its explicit budget beats the
		// recipe-derived batch default.
		const launchedB = present(
			h.launched.find((l) => l.scope.endsWith("-b")),
			"launched b",
		);
		expect(launchedB.manifestPath).toBe("manifests/converge.json");
		expect(launchedB.manifestDigest).toBe("sha256:aaaa");
		expect(launchedB.recipe?.id).toBe("deep-feature");
		expect(launchedB.maxIterations).toBe(7);
		expect(launchedB.callTimeoutMs).toBe(1200000); // the batch recipe's default
		// The view surfaces the recipe id + approved digest per task (no prompt text).
		const viewA = present(
			confirmed.view.tasks.find((t) => t.id === "a"),
			"task a view",
		);
		expect(viewA.recipe).toBe("quick-fix");
		expect(viewA.manifestDigest).toBe("sha256:bbbb");
		const viewB = present(
			confirmed.view.tasks.find((t) => t.id === "b"),
			"task b view",
		);
		expect(viewB.recipe).toBe("deep-feature");
		expect(viewB.manifestDigest).toBe("sha256:aaaa");
	});

	test("a direct-manifest task next to a recipe task binds and launches independently", () => {
		const h = makeHarness();
		h.deps.resolveRecipe = () => gateRecipe();
		h.deps.resolveManifestBinding = (p) => gateBinding(p.manifestPath, "sha256:direct");
		const result = runBatchStart(
			{
				tasks: [
					{ id: "a", title: "A", body: "do a", claimedPaths: ["src/a"], recipe: "deep-feature" },
					{
						id: "b",
						title: "B",
						body: "do b",
						claimedPaths: ["src/b"],
						manifestPath: "manifests/own.json",
					},
				],
			},
			h.cwd,
			h.store,
			h.deps,
			noLaunch,
		);
		if (result.launched) throw new Error("expected a dry run");
		// The recipe task binds its recipe's manifest; the direct task binds its own
		// reference; no batch-level recipe -> no batch receipt or binding.
		expect(result.recipes?.tasks?.a?.id).toBe("deep-feature");
		expect(result.recipes?.tasks?.b).toBeUndefined();
		expect(result.manifests?.tasks?.a?.manifestDigest).toBe("sha256:aaaa");
		expect(result.manifests?.tasks?.b?.manifestDigest).toBe("sha256:direct");
		expect(result.recipes?.batch).toBeUndefined();
		expect(result.manifests?.batch).toBeUndefined();
	});

	test("a real repo chit.config.json recipe menu resolves through the dry-run and confirm path", () => {
		const repo = realpathSync(mkdtempSync(join(tmpdir(), "chit-batch-recipe-menu-")));
		const git: GitRunner = (args, cwd = repo) => shellGit(args, cwd);
		const savedConfigHome = process.env.XDG_CONFIG_HOME;
		process.env.XDG_CONFIG_HOME = join(repo, ".empty-config");
		try {
			expect(shellGit(["init", "-b", "main"], repo).code).toBe(0);
			expect(shellGit(["config", "user.email", "test@example.com"], repo).code).toBe(0);
			expect(shellGit(["config", "user.name", "Test User"], repo).code).toBe(0);
			mkdirSync(join(repo, "manifests"), { recursive: true });
			writeFileSync(
				join(repo, "manifests", "converge.json"),
				JSON.stringify({
					schema: 1,
					id: "batch-dogfood-loop",
					description: "batch recipe menu dogfood loop",
					inputs: {
						task: { type: "string" },
						prior_review: { type: "string", optional: true },
					},
					participants: {
						implementer: {
							agent: "claude",
							instructions: "implement",
							session: "stateless",
							permissions: { filesystem: "write" },
						},
						reviewer: {
							agent: "codex",
							instructions: "review",
							session: "stateless",
							permissions: { filesystem: "read_only" },
						},
					},
					steps: {
						implement: { call: "implementer", prompt: "{{ inputs.task }}" },
						review: { call: "reviewer", prompt: "{{ steps.implement.output }}" },
						out: { format: "{{ steps.review.output }}" },
					},
					output: "out",
					policy: { kind: "loop", implementStep: "implement", reviewStep: "review" },
				}),
			);
			expect(shellGit(["add", "manifests/converge.json"], repo).code).toBe(0);
			expect(shellGit(["commit", "-m", "test: add manifest"], repo).code).toBe(0);
			writeFileSync(
				join(repo, "chit.config.json"),
				JSON.stringify({
					recipes: {
						"batch-dogfood-loop": {
							mode: "converge",
							manifestPath: "manifests/converge.json",
							maxIterations: 2,
							callTimeoutMs: 60000,
							description: "Run the temp repo batch dogfood loop",
						},
					},
				}),
			);

			const jobs = new Map<string, LoopJobRecord>();
			const launched: LaunchJobParams[] = [];
			const deps: BatchEngineDeps = {
				git,
				createWorktree: (_repo, batchId, taskId) => ({
					worktreePath: `/tmp/${batchId}/${taskId}`,
					branch: `chit-batch/${batchId}/${taskId}`,
				}),
				launchJob: (p) => {
					launched.push(p);
					const jobId = "job-1";
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
						...(p.manifestPath !== undefined && { manifestPath: p.manifestPath }),
						...(p.manifestDigest !== undefined && { manifestDigest: p.manifestDigest }),
						...(p.manifestParticipants !== undefined && {
							manifestParticipants: p.manifestParticipants,
						}),
						...(p.recipe !== undefined && { recipe: p.recipe }),
					});
					return { jobId, loopId: p.loopId };
				},
				getJob: (id) => jobs.get(id),
				cancelJob: () => {},
				isStale: () => false,
				loopDetail: () => ({ changedFiles: [], workspaceWarnings: [] }),
				resolveManifestBinding: (p) => {
					const config = loadConfig(undefined, { cwd: p.configCwd });
					return resolveManifestBindingWith(p, { git, config });
				},
				resolveRecipe: (p) => {
					const config = loadConfig(undefined, { cwd: p.configCwd });
					return resolveRecipe(p.recipeId, config, {
						git,
						repoRoot: p.gitCwd,
						baseSha: p.baseSha,
					});
				},
				now: () => 1000,
			};
			const store = new BatchStore(repo);
			const input: BatchStartInput = {
				tasks: [{ id: "a", title: "A", body: "do a", claimedPaths: ["src/a"] }],
				recipe: "batch-dogfood-loop",
			};

			const dry = runBatchStart(input, repo, store, deps, noLaunch);
			if (dry.launched) throw new Error("expected a dry run");
			expect(dry.recipes?.batch).toMatchObject({
				id: "batch-dogfood-loop",
				mode: "converge",
				maxIterations: 2,
				callTimeoutMs: 60000,
			});
			expect(dry.manifests?.batch?.manifestPath).toBe("manifests/converge.json");
			expect(dry.manifests?.batch?.manifestDigest).toMatch(/^sha256:/);

			const confirmed = runBatchStart(
				{ ...input, confirm: true, approvalHash: dry.approvalHash },
				repo,
				store,
				deps,
				() => "recipe-menu-batch",
			);
			if (!confirmed.launched) throw new Error("expected launch");
			const launchedTask = present(launched[0], "launched recipe task");
			expect(launchedTask.recipe).toEqual(dry.recipes?.batch);
			expect(launchedTask.manifestPath).toBe("manifests/converge.json");
			expect(launchedTask.manifestDigest).toBe(dry.manifests?.batch?.manifestDigest);
			expect(launchedTask.maxIterations).toBe(2);
			expect(launchedTask.callTimeoutMs).toBe(60000);
		} finally {
			if (savedConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
			else process.env.XDG_CONFIG_HOME = savedConfigHome;
			rmSync(repo, { recursive: true, force: true });
		}
	});
});
