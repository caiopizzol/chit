import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobStore, JobStoreError } from "./store.ts";
import type { JobRecord } from "./types.ts";

let dir: string;
let store: JobStore;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "chit-jobs-"));
	store = new JobStore(dir);
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function rec(jobId: string, over: Partial<JobRecord> = {}): JobRecord {
	return {
		jobId,
		loopId: jobId,
		repoKey: "k",
		cwd: "/repo",
		scope: "s",
		task: "t",
		maxIterations: 3,
		allowUnenforced: false,
		state: "queued",
		createdAt: "2026-06-01T10:00:00.000Z",
		iterationsCompleted: 0,
		auditRefs: [],
		...over,
	} as JobRecord;
}

describe("JobStore", () => {
	test("create then get round-trips", () => {
		store.create(rec("j1"));
		expect(store.get("j1")).toMatchObject({ jobId: "j1", state: "queued" });
	});

	test("create refuses to clobber an existing job", () => {
		store.create(rec("j1"));
		expect(() => store.create(rec("j1"))).toThrow(/already exists/);
	});

	test("get returns undefined for a missing job", () => {
		expect(store.get("nope")).toBeUndefined();
	});

	test("update is a read-modify-write under the lock", () => {
		store.create(rec("j1"));
		const next = store.update("j1", (c) => ({
			...c,
			state: "running",
			pid: 123,
			iterationsCompleted: 1,
		}));
		expect(next.state).toBe("running");
		expect(store.get("j1")).toMatchObject({ state: "running", pid: 123, iterationsCompleted: 1 });
	});

	test("update on a missing job throws", () => {
		expect(() => store.update("ghost", (c) => c)).toThrow(/no job/);
	});

	test("list returns jobs newest-created first and skips corrupt files", () => {
		store.create(rec("old", { createdAt: "2026-06-01T10:00:00.000Z" }));
		store.create(rec("new", { createdAt: "2026-06-01T11:00:00.000Z" }));
		writeFileSync(join(dir, "broken.json"), "not json");
		expect(store.list().map((j) => j.jobId)).toEqual(["new", "old"]);
	});

	test("rejects an unsafe job id", () => {
		expect(() => store.get("../evil")).toThrow(JobStoreError);
		expect(() => store.create(rec("a/b"))).toThrow(JobStoreError);
	});

	test("loopLockPath is under the jobs locks dir and id-validated", () => {
		expect(store.loopLockPath("L1")).toBe(join(dir, "locks", "L1.lock"));
		expect(() => store.loopLockPath("../evil")).toThrow(JobStoreError);
	});
});
