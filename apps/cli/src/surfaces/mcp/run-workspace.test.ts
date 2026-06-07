import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { applyRunWorkspace, realGit } from "../../batches/worktree.ts";
import type { LoopJobRecord } from "../../jobs/types.ts";
import { startLoop, stopLoop } from "../../loops/log-store.ts";
import type { ResolvedRun } from "./controller.ts";
import {
	type ArchivedForegroundLoop,
	loopMayWriteFiles,
	planArchivedApply,
	planManagedWorkspace,
	resolveArchivedForegroundLoop,
	resolveManifestPathAbsolute,
	resolveRunWorkspace,
} from "./server.ts";

// The chit_start managed-worktree dispatch (#85) is a closure inside registerTool,
// not drivable without an MCP transport. These pin its decision logic, extracted into
// pure/injectable helpers, against the exact contract the independent review required
// (F1 read-only not isolated, F2 manifest path absolute from caller, F3a config before
// any worktree).

describe("resolveManifestPathAbsolute (F2): same file for fg + bg, from the caller cwd", () => {
	test("a relative manifest_path resolves against the CALLER cwd, not a worktree", () => {
		const abs = resolveManifestPathAbsolute("chit-manifests/converge.json", "/repo");
		expect(abs).toBe(join("/repo", "chit-manifests/converge.json"));
		expect(isAbsolute(abs)).toBe(true);
	});
	test("an already-absolute path passes through unchanged", () => {
		expect(resolveManifestPathAbsolute("/abs/m.json", "/repo")).toBe("/abs/m.json");
	});
});

describe("loopMayWriteFiles (F1): isolate only a loop that may write", () => {
	const p = (filesystem?: string) => (filesystem ? { permissions: { filesystem } } : {});
	test("any write-capable participant -> may write (isolate)", () => {
		expect(loopMayWriteFiles({ impl: p("write"), rev: p("read_only") })).toBe(true);
	});
	test("every participant provably read_only -> does NOT write (run in place)", () => {
		expect(loopMayWriteFiles({ a: p("read_only"), b: p("read_only") })).toBe(false);
	});
	test("a role-ref (permissions resolved later, absent here) errs toward may-write", () => {
		// permissions undefined at dispatch for a role-ref; the safe direction is to isolate.
		expect(loopMayWriteFiles({ impl: p(undefined), rev: p("read_only") })).toBe(true);
	});
});

describe("planManagedWorkspace: ordering + isolate decision (F1 + F3a)", () => {
	const writeLoop = { impl: { permissions: { filesystem: "write" } } };
	const readOnlyLoop = { a: { permissions: { filesystem: "read_only" } } };

	test("write loop, in_place false -> opens an ISOLATED worktree (inPlace=false)", () => {
		const calls: boolean[] = [];
		planManagedWorkspace(
			{ ensureConfig: () => {}, openWorkspace: (inPlace) => calls.push(inPlace) },
			{ participants: writeLoop, inPlace: false },
		);
		expect(calls).toEqual([false]); // isolated
	});

	test("read-only loop -> runs IN PLACE (inPlace=true), no worktree (F1)", () => {
		const calls: boolean[] = [];
		planManagedWorkspace(
			{ ensureConfig: () => {}, openWorkspace: (inPlace) => calls.push(inPlace) },
			{ participants: readOnlyLoop, inPlace: false },
		);
		expect(calls).toEqual([true]); // in place: nothing to isolate
	});

	test("in_place:true forces the caller checkout even for a write loop", () => {
		const calls: boolean[] = [];
		planManagedWorkspace(
			{ ensureConfig: () => {}, openWorkspace: (inPlace) => calls.push(inPlace) },
			{ participants: writeLoop, inPlace: true },
		);
		expect(calls).toEqual([true]);
	});

	test("a config error fails BEFORE any worktree is opened (F3a: no leak)", () => {
		let opened = false;
		expect(() =>
			planManagedWorkspace(
				{
					ensureConfig: () => {
						throw new Error("bad config");
					},
					openWorkspace: () => {
						opened = true;
						return opened;
					},
				},
				{ participants: writeLoop, inPlace: false },
			),
		).toThrow("bad config");
		expect(opened).toBe(false); // the worktree was never created
	});
});

describe("resolveRunWorkspace: shared run->worktree metadata + liveness (chit_cleanup + chit_apply)", () => {
	const NOW = 1_000;
	// Deps the helper injects: by default the process is alive and nothing is stale, so a
	// queued/running worker reads live -- each test overrides only what it exercises.
	const deps = (over: { isStale?: boolean; pidAlive?: boolean } = {}) => ({
		isStale: () => over.isStale ?? false,
		pidAlive: () => over.pidAlive ?? true,
		now: NOW,
	});
	const meta = {
		worktreePath: "/wt",
		branch: "chit/x",
		baseSha: "abc123",
		repo: "/repo",
		callerCheckout: "/caller",
	};
	// Minimal ResolvedRun shapes -- only the fields the helper reads.
	const bgJob = (state: string, extra: Record<string, unknown> = {}) =>
		({ mode: "background", job: { ...meta, state, pid: 42, ...extra } }) as unknown as ResolvedRun;
	const fgLoop = (session: Record<string, unknown>) =>
		({
			mode: "foreground",
			run: { kind: "loop", session: { ...meta, ...session } },
		}) as unknown as ResolvedRun;
	const oneShot = () =>
		({ mode: "foreground", run: { kind: "one-shot", run: {} } }) as unknown as ResolvedRun;

	test("background: returns all four metadata fields off the job", () => {
		const r = resolveRunWorkspace(bgJob("completed"), deps());
		expect(r).toMatchObject(meta);
	});

	test("a batch task's job (repo == callerCheckout) resolves to an APPLYABLE workspace", () => {
		// launchWave now records the task worktree on the job record, with repo and callerCheckout
		// both the batch's caller repo. resolveRunWorkspace must surface the apply triplet
		// (worktreePath + baseSha + a target) so chit_apply takes its apply path, not the
		// "no chit-managed worktree (one-shot or in_place)" no-op it used to hit for batch tasks.
		// A fully-valid LoopJobRecord, shaped exactly as launchWave -> launchConvergeJob persists a
		// converged batch task (runId == loopId == `<batchId>-<taskId>`, cwd == worktreePath, repo
		// == callerCheckout == the batch's caller repo) -- no partial cast, a reachable state.
		const batchJob = {
			runId: "c1-a",
			policy: "loop",
			loopId: "c1-a",
			repoKey: "k",
			cwd: "/wt/c1/a",
			worktreePath: "/wt/c1/a",
			branch: "chit-batch/c1/a",
			baseSha: "abc123",
			repo: "/batch-caller",
			callerCheckout: "/batch-caller", // a batch's repo and launching checkout are the same
			scope: "batch-c1-a",
			task: "do a",
			maxIterations: 3,
			allowUnenforced: false,
			state: "completed",
			createdAt: "2026-06-02T00:00:00.000Z",
			iterationsCompleted: 1,
			auditRefs: [],
			stopStatus: "converged",
		} satisfies LoopJobRecord;
		const r = resolveRunWorkspace({ mode: "background", job: batchJob }, deps());
		expect(r.worktreePath).toBe("/wt/c1/a"); // -> not the no-op branch
		expect(r.baseSha).toBe("abc123"); // -> the diff can be reconstructed
		expect(r.callerCheckout).toBe("/batch-caller"); // -> apply's default target
		expect(r.workerLive).toBe(false); // -> a terminal task is not refused as "still active"
	});

	test("background queued: live unless stale-queued", () => {
		expect(resolveRunWorkspace(bgJob("queued"), deps({ isStale: false })).workerLive).toBe(true);
		expect(resolveRunWorkspace(bgJob("queued"), deps({ isStale: true })).workerLive).toBe(false);
	});

	test("background running: live iff the pid is alive (NOT via isStale)", () => {
		// stale heartbeat but a live pid -> still live (removing it would corrupt the run).
		expect(
			resolveRunWorkspace(bgJob("running"), deps({ pidAlive: true, isStale: true })).workerLive,
		).toBe(true);
		expect(resolveRunWorkspace(bgJob("running"), deps({ pidAlive: false })).workerLive).toBe(false);
	});

	test("background terminal (completed/failed/cancelled): not live", () => {
		for (const state of ["completed", "failed", "cancelled"]) {
			expect(resolveRunWorkspace(bgJob(state), deps({ pidAlive: true })).workerLive).toBe(false);
		}
	});

	test("foreground loop: returns metadata off the session", () => {
		const r = resolveRunWorkspace(fgLoop({ terminalStatus: "passed" }), deps());
		expect(r).toMatchObject(meta);
	});

	test("foreground loop active (no terminalStatus, or active set): live", () => {
		expect(resolveRunWorkspace(fgLoop({}), deps()).workerLive).toBe(true);
		expect(
			resolveRunWorkspace(fgLoop({ terminalStatus: "passed", active: {} }), deps()).workerLive,
		).toBe(true);
	});

	test("foreground loop terminal (terminalStatus set, no active): not live", () => {
		expect(
			resolveRunWorkspace(fgLoop({ terminalStatus: "passed", active: undefined }), deps())
				.workerLive,
		).toBe(false);
	});

	test("one-shot / foreground non-loop: no worktree, never live", () => {
		const r = resolveRunWorkspace(oneShot(), deps({ pidAlive: true }));
		expect(r.worktreePath).toBeUndefined();
		expect(r.branch).toBeUndefined();
		expect(r.baseSha).toBeUndefined();
		expect(r.repo).toBeUndefined();
		expect(r.workerLive).toBe(false);
	});
});

describe("resolveArchivedForegroundLoop (#100): recover a closed foreground run from its log", () => {
	let stateDir: string;
	let savedXdg: string | undefined;
	let cwd: string;
	beforeEach(() => {
		stateDir = mkdtempSync(join(tmpdir(), "chit-arch-state-"));
		savedXdg = process.env.XDG_STATE_HOME;
		process.env.XDG_STATE_HOME = stateDir;
		cwd = mkdtempSync(join(tmpdir(), "chit-arch-cwd-"));
	});
	afterEach(() => {
		if (savedXdg === undefined) delete process.env.XDG_STATE_HOME;
		else process.env.XDG_STATE_HOME = savedXdg;
		rmSync(stateDir, { recursive: true, force: true });
		rmSync(cwd, { recursive: true, force: true });
	});

	const ws = {
		worktreePath: "/wt/A1/owner",
		branch: "chit-run/A1/owner",
		baseSha: "basesha",
		mainRepo: "/main/repo",
		callerCheckout: "/launch",
	};
	const participants = {
		impl: {
			agentId: "claude",
			adapter: "claude-cli",
			session: "per_scope" as const,
			permissions: { filesystem: "write" as const },
			enforcesReadOnly: false,
			config: { model: "claude-opus-4" },
		},
	};

	test("future log (0.23+): recovers workspace straight from the header; stopped reflects the stop record", () => {
		startLoop(cwd, {
			scope: "s",
			task: "t",
			maxIterations: 3,
			loopId: "A1",
			workspace: ws,
			participants,
		});
		const open = resolveArchivedForegroundLoop("A1");
		expect(open?.stopped).toBe(false);
		expect(open?.found.header.participants).toEqual(participants);
		expect(open?.workspace).toEqual({
			worktreePath: ws.worktreePath,
			branch: ws.branch,
			baseSha: ws.baseSha,
			mainRepo: ws.mainRepo,
			callerCheckout: ws.callerCheckout, // surfaced so chit_apply can default its target to it
		});
		stopLoop(cwd, "A1", { status: "converged", reason: "done" });
		expect(resolveArchivedForegroundLoop("A1")?.stopped).toBe(true);
	});

	test("unknown runId -> undefined", () => {
		expect(resolveArchivedForegroundLoop("nope")).toBeUndefined();
	});

	test("old log whose worktree dir is gone -> found but no recoverable workspace", () => {
		// no workspace metadata; header.repo = repoRoot(cwd) = cwd, which we then delete.
		startLoop(cwd, { scope: "s", task: "t", maxIterations: 3, loopId: "A2" });
		rmSync(cwd, { recursive: true, force: true });
		const r = resolveArchivedForegroundLoop("A2");
		expect(r).toBeDefined();
		expect(r?.workspace).toBeUndefined();
	});

	test("old log: derives branch + main repo from the worktree's git when it still exists", () => {
		// A real managed worktree: main repo + a chit-run/<id> branch checked out in a worktree.
		const main = mkdtempSync(join(tmpdir(), "chit-arch-main-"));
		const root = mkdtempSync(join(tmpdir(), "chit-arch-root-"));
		const wtPath = join(root, "wt");
		try {
			realGit(["init", "-q"], main);
			realGit(["config", "user.email", "t@chit.test"], main);
			realGit(["config", "user.name", "t"], main);
			writeFileSync(join(main, "f.ts"), "base\n");
			realGit(["add", "."], main);
			realGit(["commit", "-qm", "base"], main);
			realGit(["worktree", "add", "-q", "-b", "chit-run/A3/owner", wtPath], main);
			// an OLD-style log: header.repo points at the worktree (no workspace metadata).
			startLoop(wtPath, { scope: "s", task: "t", maxIterations: 3, loopId: "A3" });
			const r = resolveArchivedForegroundLoop("A3");
			expect(r?.workspace?.worktreePath).toBe(
				realGit(["rev-parse", "--show-toplevel"], wtPath).stdout.trim(),
			);
			expect(r?.workspace?.branch).toBe("chit-run/A3/owner"); // derived from git HEAD
			expect(r?.workspace?.mainRepo).toBe(realpathSync(main)); // derived
		} finally {
			try {
				realGit(["worktree", "remove", "--force", wtPath], main);
			} catch {}
			rmSync(main, { recursive: true, force: true });
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("old log: does NOT misclassify a worktree on a DIFFERENT run's chit-run/ branch (#100 review)", () => {
		// The worktree's HEAD branch belongs to ANOTHER run (chit-run/OTHER/...), not this log's id.
		// The bare chit-run/ prefix would wrongly accept it; binding to <runId> must reject it.
		const main = mkdtempSync(join(tmpdir(), "chit-arch-mis-"));
		const root = mkdtempSync(join(tmpdir(), "chit-arch-misroot-"));
		const wtPath = join(root, "wt");
		try {
			realGit(["init", "-q"], main);
			realGit(["config", "user.email", "t@chit.test"], main);
			realGit(["config", "user.name", "t"], main);
			writeFileSync(join(main, "f.ts"), "base\n");
			realGit(["add", "."], main);
			realGit(["commit", "-qm", "base"], main);
			realGit(["worktree", "add", "-q", "-b", "chit-run/SOMEONE-ELSE/owner", wtPath], main);
			// the log's id (A4) does NOT match the worktree's branch run id (SOMEONE-ELSE).
			startLoop(wtPath, { scope: "s", task: "t", maxIterations: 3, loopId: "A4" });
			const r = resolveArchivedForegroundLoop("A4");
			expect(r).toBeDefined();
			expect(r?.workspace).toBeUndefined(); // refused: not THIS run's managed branch
		} finally {
			try {
				realGit(["worktree", "remove", "--force", wtPath], main);
			} catch {}
			rmSync(main, { recursive: true, force: true });
			rmSync(root, { recursive: true, force: true });
		}
	});
});

// planArchivedApply is the testable core of chit_apply's closed-session fallback (the handler is a
// server-internal closure). It decides terminal/workspace/baseSha/target; the actual diff apply is
// applyRunWorkspace (tested in worktree.test.ts), which the archived path reuses unchanged.
describe("planArchivedApply: chit_apply's closed-session decision", () => {
	const stubFound = {} as ArchivedForegroundLoop["found"];
	function archived(
		over: Partial<Pick<ArchivedForegroundLoop, "stopped" | "workspace">>,
	): ArchivedForegroundLoop {
		return {
			found: stubFound,
			stopped: over.stopped ?? true,
			...("workspace" in over && { workspace: over.workspace }),
		};
	}
	const fullWs = {
		worktreePath: "/wt/R1/owner",
		branch: "chit-run/R1/owner",
		baseSha: "basesha",
		mainRepo: "/main",
		callerCheckout: "/launch",
	};

	test("a non-terminal archived run refuses (its diff is not final)", () => {
		const p = planArchivedApply(archived({ stopped: false, workspace: fullWs }), "R1", undefined);
		expect(p.kind).toBe("refuse");
		if (p.kind === "refuse") expect(p.error).toContain("never recorded a terminal stop");
	});

	test("no recoverable workspace -> no-op (in_place / worktree gone)", () => {
		const p = planArchivedApply(archived({ workspace: undefined }), "R1", undefined);
		expect(p.kind).toBe("noop");
		if (p.kind === "noop") expect(p.note).toContain("nothing to apply");
	});

	test("a workspace without baseSha refuses (pre-0.23, diff not reconstructable)", () => {
		const { baseSha, ...noBase } = fullWs;
		void baseSha;
		const p = planArchivedApply(archived({ workspace: noBase }), "R1", undefined);
		expect(p.kind).toBe("refuse");
		if (p.kind === "refuse") expect(p.error).toContain("pre-0.23");
	});

	test("no callerCheckout and no target_cwd refuses, asking for target_cwd", () => {
		const { callerCheckout, ...noCaller } = fullWs;
		void callerCheckout;
		const p = planArchivedApply(archived({ workspace: noCaller }), "R1", undefined);
		expect(p.kind).toBe("refuse");
		if (p.kind === "refuse") expect(p.error).toContain("pass target_cwd");
	});

	test("no callerCheckout but explicit target_cwd -> apply into target_cwd", () => {
		const { callerCheckout, ...noCaller } = fullWs;
		void callerCheckout;
		const p = planArchivedApply(archived({ workspace: noCaller }), "R1", "/elsewhere");
		expect(p.kind).toBe("apply");
		if (p.kind === "apply") {
			expect(p.target).toBe("/elsewhere");
			expect(p.baseSha).toBe("basesha");
			expect(p.worktreePath).toBe("/wt/R1/owner");
		}
	});

	test("default target is the recorded launching checkout (callerCheckout)", () => {
		const p = planArchivedApply(archived({ workspace: fullWs }), "R1", undefined);
		expect(p.kind).toBe("apply");
		if (p.kind === "apply") expect(p.target).toBe("/launch");
	});

	test("an explicit target_cwd overrides the recorded callerCheckout", () => {
		const p = planArchivedApply(archived({ workspace: fullWs }), "R1", "/override");
		expect(p.kind).toBe("apply");
		if (p.kind === "apply") expect(p.target).toBe("/override");
	});
});

// The dogfood as a deterministic test: a foreground run finished in a managed worktree, the session
// closed (so only the durable 0.23 log remains), and chit_apply recovers it and lands the diff in the
// launching checkout. Exercises resolveArchivedForegroundLoop -> planArchivedApply -> applyRunWorkspace
// end to end against real git, which a flaky live closed-session run cannot do reproducibly.
describe("archived apply end-to-end (#100 + slice 3)", () => {
	let savedXdg: string | undefined;
	let stateDir: string;
	beforeEach(() => {
		stateDir = mkdtempSync(join(tmpdir(), "chit-aa-state-"));
		savedXdg = process.env.XDG_STATE_HOME;
		process.env.XDG_STATE_HOME = stateDir;
	});
	afterEach(() => {
		if (savedXdg === undefined) delete process.env.XDG_STATE_HOME;
		else process.env.XDG_STATE_HOME = savedXdg;
		rmSync(stateDir, { recursive: true, force: true });
	});

	test("recovers a closed run and applies its worktree diff into the launching checkout", () => {
		const main = mkdtempSync(join(tmpdir(), "chit-aa-main-"));
		const root = mkdtempSync(join(tmpdir(), "chit-aa-root-"));
		const wtPath = join(root, "wt");
		try {
			// The launching checkout = the main repo, with one committed base file.
			realGit(["init", "-q"], main);
			realGit(["config", "user.email", "t@chit.test"], main);
			realGit(["config", "user.name", "t"], main);
			writeFileSync(join(main, "f.ts"), "base\n");
			realGit(["add", "."], main);
			realGit(["commit", "-qm", "base"], main);
			const baseSha = realGit(["rev-parse", "HEAD"], main).stdout.trim();
			// The run was isolated in a managed worktree cut off baseSha; it edited f.ts there.
			realGit(["worktree", "add", "-q", "-b", "chit-run/AP1/owner", wtPath], main);
			writeFileSync(join(wtPath, "f.ts"), "base\nthe run added this line\n");
			// The durable 0.23 header is all that survives the closed session.
			startLoop(wtPath, {
				scope: "owner",
				task: "t",
				maxIterations: 3,
				loopId: "AP1",
				workspace: {
					worktreePath: realGit(["rev-parse", "--show-toplevel"], wtPath).stdout.trim(),
					branch: "chit-run/AP1/owner",
					baseSha,
					mainRepo: main,
					callerCheckout: main,
				},
			});
			stopLoop(wtPath, "AP1", { status: "converged", reason: "done" });

			// Recover from the log alone, then plan: target defaults to the launching checkout.
			const recovered = resolveArchivedForegroundLoop("AP1");
			expect(recovered?.stopped).toBe(true);
			expect(recovered?.workspace?.callerCheckout).toBe(main);
			if (!recovered) throw new Error("expected the run to be recoverable");
			const plan = planArchivedApply(recovered, "AP1", undefined);
			if (plan.kind !== "apply") throw new Error(`expected apply, got ${plan.kind}`);
			expect(plan.target).toBe(main);

			// Dry run: reports the tracked change applies cleanly, but mutates nothing.
			const dry = applyRunWorkspace(realGit, {
				worktreePath: plan.worktreePath,
				baseSha: plan.baseSha,
				target: plan.target,
				confirm: false,
				includeUntracked: [],
			});
			expect(dry.trackedFiles).toContain("f.ts");
			expect(dry.appliesClean).toBe(true);
			expect(readFileSync(join(main, "f.ts"), "utf8")).toBe("base\n"); // unchanged by the dry run

			// Confirm: the run's edit lands (staged) in the launching checkout.
			const res = applyRunWorkspace(realGit, {
				worktreePath: plan.worktreePath,
				baseSha: plan.baseSha,
				target: plan.target,
				confirm: true,
				includeUntracked: [],
			});
			expect(res.applied).toBe(true);
			expect(readFileSync(join(main, "f.ts"), "utf8")).toContain("the run added this line");
		} finally {
			try {
				realGit(["worktree", "remove", "--force", wtPath], main);
			} catch {}
			rmSync(main, { recursive: true, force: true });
			rmSync(root, { recursive: true, force: true });
		}
	});
});
