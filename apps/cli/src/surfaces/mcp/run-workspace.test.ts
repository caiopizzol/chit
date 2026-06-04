import { describe, expect, test } from "bun:test";
import { isAbsolute, join } from "node:path";
import type { ResolvedRun } from "./controller.ts";
import {
	loopMayWriteFiles,
	planManagedWorkspace,
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
