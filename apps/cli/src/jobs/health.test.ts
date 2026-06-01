import { describe, expect, test } from "bun:test";
import { isStale } from "./health.ts";
import type { JobRecord } from "./types.ts";

const NOW = Date.parse("2026-06-01T12:00:00.000Z");
const fresh = new Date(NOW).toISOString();
const ancient = "2020-01-01T00:00:00.000Z";
// A pid far above the typical range, very unlikely to exist -> kill(pid,0) ESRCH.
const DEAD_PID = 2_147_480_000;

function job(over: Partial<JobRecord>): JobRecord {
	return {
		jobId: "j",
		loopId: "j",
		repoKey: "k",
		cwd: "/r",
		scope: "s",
		task: "t",
		maxIterations: 3,
		allowUnenforced: false,
		state: "running",
		createdAt: fresh,
		iterationsCompleted: 0,
		auditRefs: [],
		...over,
	} as JobRecord;
}

describe("isStale", () => {
	test("running + fresh heartbeat + live pid is not stale", () => {
		expect(isStale(job({ pid: process.pid, lastHeartbeatAt: fresh }), NOW)).toBe(false);
	});

	test("running + ancient heartbeat is stale (even with a live pid)", () => {
		expect(isStale(job({ pid: process.pid, lastHeartbeatAt: ancient }), NOW)).toBe(true);
	});

	test("running + dead pid is stale", () => {
		expect(isStale(job({ pid: DEAD_PID, lastHeartbeatAt: fresh }), NOW)).toBe(true);
	});

	test("queued longer than the window is stale (worker never started)", () => {
		expect(isStale(job({ state: "queued", createdAt: ancient }), NOW)).toBe(true);
	});

	test("freshly queued is not stale", () => {
		expect(isStale(job({ state: "queued", createdAt: fresh }), NOW)).toBe(false);
	});

	test("terminal jobs are never stale", () => {
		for (const state of ["completed", "cancelled", "failed"] as const) {
			expect(isStale(job({ state, lastHeartbeatAt: ancient }), NOW)).toBe(false);
		}
	});
});
