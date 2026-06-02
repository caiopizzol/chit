import { describe, expect, test } from "bun:test";
import { formatDuration, isStale, jobTiming } from "./health.ts";
import type { JobRecord } from "./types.ts";

const NOW = Date.parse("2026-06-01T12:00:00.000Z");
const fresh = new Date(NOW).toISOString();
const ancient = "2020-01-01T00:00:00.000Z";
// A pid far above the typical range, very unlikely to exist -> kill(pid,0) ESRCH.
const DEAD_PID = 2_147_480_000;

function job(over: Partial<JobRecord>): JobRecord {
	return {
		runId: "j",
		policy: "loop",
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

describe("jobTiming", () => {
	const minuteAgo = new Date(NOW - 60_000).toISOString();
	const tenSecAgo = new Date(NOW - 10_000).toISOString();

	test("running: elapsed from startedAt, heartbeat age, and phase age", () => {
		const t = jobTiming(
			job({
				state: "running",
				startedAt: minuteAgo,
				lastHeartbeatAt: tenSecAgo,
				phase: "implementing",
				phaseStartedAt: tenSecAgo,
			}),
			NOW,
		);
		expect(t.elapsedMs).toBe(60_000);
		expect(t.lastHeartbeatAgeMs).toBe(10_000);
		expect(t.phaseElapsedMs).toBe(10_000);
	});

	test("falls back to createdAt for elapsed when startedAt is absent", () => {
		const t = jobTiming(job({ state: "queued", createdAt: minuteAgo }), NOW);
		expect(t.elapsedMs).toBe(60_000);
	});

	test("terminal: elapsed spans startedAt->endedAt; heartbeat age omitted", () => {
		const t = jobTiming(
			job({
				state: "completed",
				startedAt: minuteAgo,
				endedAt: tenSecAgo,
				lastHeartbeatAt: tenSecAgo,
			}),
			NOW,
		);
		expect(t.elapsedMs).toBe(50_000); // minuteAgo -> tenSecAgo
		expect(t.lastHeartbeatAgeMs).toBeUndefined();
	});

	test("phase age omitted when no phase is active", () => {
		const t = jobTiming(
			job({ state: "running", startedAt: minuteAgo, phaseStartedAt: tenSecAgo }),
			NOW,
		);
		expect(t.phaseElapsedMs).toBeUndefined();
	});

	test("unparseable timestamps yield no fields rather than NaN", () => {
		const t = jobTiming(job({ state: "running", startedAt: "not-a-date" }), NOW);
		expect(t.elapsedMs).toBeUndefined();
	});
});

describe("formatDuration", () => {
	test("formats seconds, minutes, and hours compactly", () => {
		expect(formatDuration(0)).toBe("0s");
		expect(formatDuration(45_000)).toBe("45s");
		expect(formatDuration(60_000)).toBe("1m");
		expect(formatDuration(192_000)).toBe("3m12s");
		expect(formatDuration(3_600_000)).toBe("1h");
		expect(formatDuration(3_840_000)).toBe("1h4m");
	});
});
