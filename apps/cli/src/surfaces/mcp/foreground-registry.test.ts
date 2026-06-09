import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConvergeSession } from "./converge-engine.ts";
import {
	FOREGROUND_STALE_AFTER_MS,
	ForegroundRegistry,
	type ForegroundSnapshot,
	summarizeForegroundForStatus,
} from "./foreground-registry.ts";

const NOW = Date.parse("2026-06-01T12:00:00.000Z");

// A pid that does not resolve to a live process, so pidAlive(DEAD_PID) is false.
// 2^31 - 1 is above any real pid on the platforms chit runs on.
const DEAD_PID = 2_147_483_647;

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "chit-fg-registry-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

// A full snapshot for the store-level tests (they exercise the file layer directly,
// independent of a ConvergeSession). pid defaults to this live process so the
// snapshot reads as alive unless a test overrides it.
function snapshot(runId: string, over: Partial<ForegroundSnapshot> = {}): ForegroundSnapshot {
	return {
		runId,
		pid: process.pid,
		scope: "sc",
		task: "do the thing",
		repoKey: "k",
		iteration: 1,
		phase: "implementing",
		startedAt: new Date(NOW - 60_000).toISOString(),
		phaseStartedAt: new Date(NOW - 10_000).toISOString(),
		lastActivityAt: new Date(NOW - 10_000).toISOString(),
		updatedAt: new Date(NOW - 10_000).toISOString(),
		statusLine: "iteration 1 · implementing",
		...over,
	};
}

describe("ForegroundRegistry store", () => {
	test("write then list returns a live snapshot; remove deletes it", () => {
		const reg = new ForegroundRegistry(dir);
		reg.write(snapshot("run-a"));
		expect(reg.list(NOW).map((s) => s.runId)).toEqual(["run-a"]);
		reg.remove("run-a");
		expect(reg.list(NOW)).toEqual([]);
	});

	test("remove is idempotent and an absent base dir lists nothing", () => {
		const reg = new ForegroundRegistry(join(dir, "does-not-exist-yet"));
		expect(reg.list(NOW)).toEqual([]);
		expect(() => reg.remove("nope")).not.toThrow(); // no file, no throw
	});

	test("a dead writer process is filtered out (pid not alive)", () => {
		const reg = new ForegroundRegistry(dir);
		reg.write(snapshot("alive")); // this process's pid
		reg.write(snapshot("dead", { pid: DEAD_PID }));
		expect(reg.list(NOW).map((s) => s.runId)).toEqual(["alive"]);
	});

	test("a stale snapshot is filtered out even when its pid is alive (PID-reuse guard)", () => {
		const reg = new ForegroundRegistry(dir);
		// pid is alive (this process) but updatedAt is older than the stale window: a
		// reused pid belonging to an unrelated process that never refreshes this snapshot.
		reg.write(
			snapshot("stale", {
				updatedAt: new Date(NOW - FOREGROUND_STALE_AFTER_MS - 1).toISOString(),
			}),
		);
		reg.write(snapshot("fresh", { updatedAt: new Date(NOW - 1_000).toISOString() }));
		expect(reg.list(NOW).map((s) => s.runId)).toEqual(["fresh"]);
	});

	test("a long-but-fresh phase stays live (updatedAt recent, well within the window)", () => {
		const reg = new ForegroundRegistry(dir);
		// phaseStartedAt is old (a long single phase) but updatedAt is recent, so the
		// run is still live: the stale window measures freshness, not phase length.
		reg.write(
			snapshot("long-phase", {
				phaseStartedAt: new Date(NOW - 20 * 60_000).toISOString(),
				updatedAt: new Date(NOW - 5_000).toISOString(),
			}),
		);
		expect(reg.list(NOW).map((s) => s.runId)).toEqual(["long-phase"]);
	});

	test("a corrupt / mid-write file is skipped, not fatal", () => {
		const reg = new ForegroundRegistry(dir);
		reg.write(snapshot("good"));
		writeFileSync(join(dir, "partial.json"), '{"runId":"partial","pid":'); // truncated JSON
		writeFileSync(join(dir, "notjson.json"), "this is not json");
		expect(reg.list(NOW).map((s) => s.runId)).toEqual(["good"]);
	});

	test("a file whose runId disagrees with its name is rejected", () => {
		// isValidSnapshot pins runId to the filename, so a renamed/mismatched file reads
		// as absent rather than being trusted under the wrong handle.
		writeFileSync(join(dir, "claimed.json"), JSON.stringify(snapshot("actually-different")));
		expect(new ForegroundRegistry(dir).list(NOW)).toEqual([]);
	});

	test("a file with extra participant config is sanitized on read (no env/config leak)", () => {
		// An older / malformed / hand-edited file may carry full participant provenance.
		// The reader must reconstruct the compact schema, so only agentId + adapter survive.
		writeFileSync(
			join(dir, "leaky.json"),
			JSON.stringify({
				...snapshot("leaky"),
				participants: {
					impl: {
						agentId: "claude",
						adapter: "claude-cli",
						permissions: { filesystem: "write" },
						config: { model: "claude-opus-4", envKeys: ["ANTHROPIC_API_KEY"] },
					},
				},
			}),
		);
		const live = new ForegroundRegistry(dir).list(NOW);
		expect(live).toHaveLength(1);
		expect(live[0]?.participants).toEqual({ impl: { agentId: "claude", adapter: "claude-cli" } });
		const json = JSON.stringify(live);
		expect(json).not.toContain("envKeys");
		expect(json).not.toContain("ANTHROPIC_API_KEY");
		expect(json).not.toContain("permissions");
		expect(json).not.toContain("config");
	});

	test("wrong-typed optional fields are dropped on read, not re-emitted", () => {
		writeFileSync(
			join(dir, "weird.json"),
			JSON.stringify({
				...snapshot("weird"),
				worktreePath: 123, // not a string
				phaseStartedAt: { nested: true }, // not a string
				maxIterations: "3", // not a number
				callTimeoutMs: null, // not a number
				participants: { impl: { agentId: "claude" } }, // missing adapter -> participant dropped
			}),
		);
		const live = new ForegroundRegistry(dir).list(NOW);
		expect(live).toHaveLength(1);
		expect(live[0]?.worktreePath).toBeUndefined();
		expect(live[0]?.phaseStartedAt).toBeUndefined();
		expect(live[0]?.maxIterations).toBeUndefined();
		expect(live[0]?.callTimeoutMs).toBeUndefined();
		expect(live[0]?.participants).toBeUndefined(); // the only entry was malformed
	});

	test("maxIterations and callTimeoutMs round-trip through write/list", () => {
		const reg = new ForegroundRegistry(dir);
		reg.write(snapshot("budgeted", { maxIterations: 5, callTimeoutMs: 900_000 }));
		const live = reg.list(NOW);
		expect(live).toHaveLength(1);
		expect(live[0]?.maxIterations).toBe(5);
		expect(live[0]?.callTimeoutMs).toBe(900_000);
	});

	test("a snapshot without maxIterations/callTimeoutMs still reads (older writer tolerated)", () => {
		const reg = new ForegroundRegistry(dir);
		reg.write(snapshot("plain")); // fixture omits both
		const live = reg.list(NOW);
		expect(live).toHaveLength(1);
		expect(live[0]?.maxIterations).toBeUndefined();
		expect(live[0]?.callTimeoutMs).toBeUndefined();
	});

	test("a heartbeat re-sync advances updatedAt but preserves lastActivityAt", () => {
		// The server beats the registry while an iteration runs so a long phase stays live.
		// A beat must move only the freshness marker (updatedAt), never the real activity mark
		// (lastActivityAt) -- the snapshot derives last-activity age from the latter.
		const reg = new ForegroundRegistry(dir);
		const activityAt = NOW - 30_000;
		reg.write(
			snapshot("beat", {
				lastActivityAt: new Date(activityAt).toISOString(),
				updatedAt: new Date(NOW - 30_000).toISOString(),
			}),
		);
		// Re-write the SAME snapshot with a fresh updatedAt (what a heartbeat sync does).
		reg.write(
			snapshot("beat", {
				lastActivityAt: new Date(activityAt).toISOString(),
				updatedAt: new Date(NOW).toISOString(),
			}),
		);
		const live = reg.list(NOW);
		expect(live).toHaveLength(1);
		expect(live[0]?.updatedAt).toBe(new Date(NOW).toISOString()); // freshness advanced
		expect(live[0]?.lastActivityAt).toBe(new Date(activityAt).toISOString()); // real mark held
	});

	test("pruneDead removes a dead-pid snapshot file and reports it; list stays empty", () => {
		const reg = new ForegroundRegistry(dir);
		reg.write(snapshot("dead", { pid: DEAD_PID }));
		expect(reg.list(NOW)).toEqual([]); // already filtered out at read time...
		expect(readdirSync(dir)).toEqual(["dead.json"]); // ...but the file lingered
		expect(reg.pruneDead()).toEqual(["dead"]); // the explicit sweep reclaims it
		expect(readdirSync(dir)).toEqual([]); // file is gone
		expect(reg.list(NOW)).toEqual([]);
	});

	test("pruneDead keeps a stale-but-pid-alive snapshot (stale window is a read filter, not a delete trigger)", () => {
		const reg = new ForegroundRegistry(dir);
		// pid is alive (this process) but updatedAt is past the stale window: list filters it,
		// yet pruneDead must NOT delete it -- a live pid may still be the real writer.
		reg.write(
			snapshot("stale", {
				updatedAt: new Date(NOW - FOREGROUND_STALE_AFTER_MS - 1).toISOString(),
			}),
		);
		expect(reg.list(NOW)).toEqual([]); // filtered out as stale
		expect(reg.pruneDead()).toEqual([]); // but not pruned: pid is alive
		expect(readdirSync(dir)).toEqual(["stale.json"]); // file remains
	});

	test("pruneDead leaves corrupt and pid-alive files, reclaims only the dead ones", () => {
		const reg = new ForegroundRegistry(dir);
		reg.write(snapshot("alive")); // this process's pid
		reg.write(snapshot("dead", { pid: DEAD_PID }));
		writeFileSync(join(dir, "partial.json"), '{"runId":"partial","pid":'); // truncated JSON
		expect(reg.pruneDead()).toEqual(["dead"]);
		expect(readdirSync(dir).sort()).toEqual(["alive.json", "partial.json"]);
	});

	test("pruneDead on an absent base dir is a no-op", () => {
		const reg = new ForegroundRegistry(join(dir, "does-not-exist-yet"));
		expect(reg.pruneDead()).toEqual([]);
	});

	test("write replaces the prior snapshot atomically (no stray .tmp left behind)", () => {
		const reg = new ForegroundRegistry(dir);
		reg.write(snapshot("run-a", { phase: "implementing" }));
		reg.write(snapshot("run-a", { phase: "reviewing" }));
		const live = reg.list(NOW);
		expect(live).toHaveLength(1);
		expect(live[0]?.phase).toBe("reviewing");
		// Only the one committed JSON file remains; the temp file was renamed away.
		expect(readdirSync(dir)).toEqual(["run-a.json"]);
	});
});

// A minimal session for snapshotFor / sync. The registry reads only these fields
// plus the live `activity` mark; a cast keeps the fixture small (matching the
// status/converge tests' fakeSession).
function fakeSession(over: Partial<ConvergeSession> = {}): ConvergeSession {
	return {
		loopId: "loop-1",
		scope: "sc",
		cwd: dir,
		task: "implement the slice",
		maxIterations: 3,
		iteration: 1,
		auditRefs: [],
		startedAtMs: NOW - 30_000,
		activity: {
			iteration: 2,
			phase: "reviewing",
			phaseStartedAtMs: NOW - 5_000,
			lastActivityAtMs: NOW - 5_000,
		},
		...over,
	} as unknown as ConvergeSession;
}

describe("ForegroundRegistry session sync", () => {
	test("snapshotFor mirrors the session's in-flight activity", () => {
		const snap = new ForegroundRegistry(dir).snapshotFor(fakeSession(), NOW);
		expect(snap).toBeDefined();
		expect(snap?.runId).toBe("loop-1");
		expect(snap?.iteration).toBe(2);
		expect(snap?.phase).toBe("reviewing");
		expect(snap?.scope).toBe("sc");
		expect(snap?.task).toBe("implement the slice");
		expect(snap?.taskFull).toBe("implement the slice");
		expect(snap?.pid).toBe(process.pid);
		expect(snap?.statusLine).toBe("iteration 2 · reviewing");
		expect(snap?.maxIterations).toBe(3); // from the session's iteration budget
	});

	test("snapshotFor carries callTimeoutMs when the run has an override, omits it otherwise", () => {
		const reg = new ForegroundRegistry(dir);
		const withBudget = reg.snapshotFor(
			fakeSession({ callTimeoutMs: 1_200_000 } as Partial<ConvergeSession>),
			NOW,
		);
		expect(withBudget?.callTimeoutMs).toBe(1_200_000);
		const without = reg.snapshotFor(fakeSession(), NOW);
		expect(without?.callTimeoutMs).toBeUndefined();
		expect(JSON.stringify(without)).not.toContain("callTimeoutMs"); // omitted, not null
	});

	test("snapshotFor returns undefined when the iteration has settled (no activity)", () => {
		expect(new ForegroundRegistry(dir).snapshotFor(fakeSession({ activity: undefined }), NOW)).toBe(
			undefined,
		);
	});

	test("the phase is 'starting' before the first phase is known", () => {
		const snap = new ForegroundRegistry(dir).snapshotFor(
			fakeSession({ activity: { iteration: 1, lastActivityAtMs: NOW } }),
			NOW,
		);
		expect(snap?.phase).toBe("starting");
		expect(snap?.phaseStartedAt).toBeUndefined(); // no phase clock yet
	});

	test("a managed worktree path is surfaced; an in_place run omits it", () => {
		const withWt = new ForegroundRegistry(dir).snapshotFor(
			fakeSession({ worktreePath: "/tmp/wt/chit-run-x" }),
			NOW,
		);
		expect(withWt?.worktreePath).toBe("/tmp/wt/chit-run-x");
		const inPlace = new ForegroundRegistry(dir).snapshotFor(fakeSession(), NOW);
		expect(inPlace?.worktreePath).toBeUndefined();
	});

	test("sync writes while active and removes once settled", () => {
		const reg = new ForegroundRegistry(dir);
		const session = fakeSession();
		reg.sync(session, NOW);
		expect(reg.list(NOW).map((s) => s.runId)).toEqual(["loop-1"]);
		// Iteration settles: the engine clears activity, so sync removes the snapshot.
		session.activity = undefined;
		reg.sync(session, NOW);
		expect(reg.list(NOW)).toEqual([]);
	});

	test("repeated sync (heartbeat) keeps updatedAt fresh while the iteration's activity is unchanged", () => {
		const reg = new ForegroundRegistry(dir);
		const session = fakeSession(); // activity.lastActivityAtMs = NOW - 5_000
		reg.sync(session, NOW);
		// A later beat with the SAME (unchanged) activity: updatedAt moves to the new now,
		// lastActivityAt still reflects the last real phase mark on the session.
		const later = NOW + 12_000;
		reg.sync(session, later);
		const live = reg.list(later);
		expect(live).toHaveLength(1);
		expect(live[0]?.updatedAt).toBe(new Date(later).toISOString());
		expect(live[0]?.lastActivityAt).toBe(new Date(NOW - 5_000).toISOString());
	});

	test("participants are reduced to agent + adapter; no env values or config leak", () => {
		const participants = {
			impl: {
				agentId: "claude",
				adapter: "claude-cli",
				session: "per_scope" as const,
				permissions: { filesystem: "write" as const },
				enforcesReadOnly: false,
				config: { model: "claude-opus-4", envKeys: ["ANTHROPIC_API_KEY"] },
			},
		};
		const snap = new ForegroundRegistry(dir).snapshotFor(
			fakeSession({ participants } as Partial<ConvergeSession>),
			NOW,
		);
		expect(snap?.participants).toEqual({ impl: { agentId: "claude", adapter: "claude-cli" } });
		// The redacted-but-still-sensitive fields never reach the cross-process snapshot.
		const json = JSON.stringify(snap);
		expect(json).not.toContain("envKeys");
		expect(json).not.toContain("ANTHROPIC_API_KEY");
		expect(json).not.toContain("permissions");
	});

	test("no model outputs or review prose are persisted", () => {
		// The session carries the threaded prior review (model/reviewer prose); it must
		// never appear in the live snapshot.
		const session = fakeSession({
			priorReview: "SECRET REVIEW PROSE that must not leak",
		} as Partial<ConvergeSession>);
		const json = JSON.stringify(new ForegroundRegistry(dir).snapshotFor(session, NOW));
		expect(json).not.toContain("SECRET REVIEW PROSE");
		expect(json).not.toContain("priorReview");
	});

	test("an over-long task one-liner is capped", () => {
		const long = "x".repeat(500);
		const snap = new ForegroundRegistry(dir).snapshotFor(
			fakeSession({ task: long } as Partial<ConvergeSession>),
			NOW,
		);
		expect(snap?.task.length).toBeLessThanOrEqual(200);
		expect(snap?.task.endsWith("...")).toBe(true);
		expect(snap?.taskFull).toBe(long);
	});

	test("sync swallows a write failure (best-effort mirror never breaks the loop)", () => {
		// A registry whose base dir cannot be created (a file sits where the dir should be)
		// must not throw from sync -- the loop is the source of truth, the mirror is optional.
		const filePath = join(dir, "not-a-dir");
		writeFileSync(filePath, "x");
		const reg = new ForegroundRegistry(join(filePath, "sub"));
		expect(() => reg.sync(fakeSession(), NOW)).not.toThrow();
	});
});

describe("summarizeForegroundForStatus", () => {
	test("derives live ages from the stored timestamps against the reader's clock", () => {
		const out = summarizeForegroundForStatus(
			snapshot("run-a", {
				startedAt: new Date(NOW - 90_000).toISOString(),
				phaseStartedAt: new Date(NOW - 30_000).toISOString(),
				lastActivityAt: new Date(NOW - 5_000).toISOString(),
			}),
			NOW,
		);
		expect(out.run_id).toBe("run-a");
		expect(out.elapsedMs).toBe(90_000);
		expect(out.phaseElapsedMs).toBe(30_000);
		expect(out.lastActivityAgeMs).toBe(5_000);
	});

	test("reconstructs participants to agent+adapter even from an off-contract snapshot (no config leak)", () => {
		// Mirrors a direct call with a snapshot carrying extra participant config: the
		// exported summary must still emit only the compact pair, never env keys / config.
		const out = summarizeForegroundForStatus(
			snapshot("r", {
				participants: {
					impl: {
						agentId: "a",
						adapter: "x",
						config: { envKeys: ["SECRET"] },
					},
				} as unknown as ForegroundSnapshot["participants"],
			}),
			NOW,
		);
		expect(out.participants).toEqual({ impl: { agentId: "a", adapter: "x" } });
		const json = JSON.stringify(out);
		expect(json).not.toContain("envKeys");
		expect(json).not.toContain("SECRET");
		expect(json).not.toContain("config");
	});

	test("passes maxIterations and callTimeoutMs through; omits them when absent", () => {
		const withBudget = summarizeForegroundForStatus(
			snapshot("r", { maxIterations: 4, callTimeoutMs: 600_000 }),
			NOW,
		);
		expect(withBudget.maxIterations).toBe(4);
		expect(withBudget.callTimeoutMs).toBe(600_000);
		const without = summarizeForegroundForStatus(snapshot("r"), NOW);
		expect(without.maxIterations).toBeUndefined();
		expect(without.callTimeoutMs).toBeUndefined();
	});

	test("omits an age it cannot derive (a future or unparseable timestamp)", () => {
		const out = summarizeForegroundForStatus(
			snapshot("run-a", {
				phaseStartedAt: new Date(NOW + 10_000).toISOString(), // in the future relative to read
			}),
			NOW,
		);
		expect(out.phaseElapsedMs).toBeUndefined();
		expect(out.elapsedMs).toBeDefined();
	});
});
