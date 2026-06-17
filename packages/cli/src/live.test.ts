import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type LiveProcess,
	listLiveRuns,
	liveDir,
	loadLiveRun,
	registerLiveRun,
	stopLiveRun,
	unregisterLiveRun,
} from "./live.ts";

const dirs: string[] = [];

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "chit-live-"));
	dirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fakeProcess(alivePids: number[], killed: Array<{ pid: number; signal: NodeJS.Signals }> = []): LiveProcess {
	return {
		isAlive: (pid) => alivePids.includes(pid),
		kill: (pid, signal) => {
			killed.push({ pid, signal });
		},
	};
}

describe("live run registry", () => {
	test("registers, loads, and unregisters a live run", () => {
		const dir = tempDir();
		registerLiveRun(dir, { runId: "run-a", routineId: "impl", pid: 123, startedAt: 10, cwd: dir });

		expect(loadLiveRun(dir, "run-a")).toMatchObject({ runId: "run-a", routineId: "impl", pid: 123 });
		expect(readdirSync(liveDir(dir))).toEqual(["run-a.json"]);

		unregisterLiveRun(dir, "run-a");
		expect(loadLiveRun(dir, "run-a")).toBeUndefined();
	});

	test("listLiveRuns returns alive runs and removes stale entries", () => {
		const dir = tempDir();
		registerLiveRun(dir, { runId: "run-alive", routineId: "impl", pid: 1, startedAt: 10, cwd: dir });
		registerLiveRun(dir, { runId: "run-dead", routineId: "fix", pid: 2, startedAt: 20, cwd: dir });

		const runs = listLiveRuns(dir, fakeProcess([1]));

		expect(runs.map((r) => r.runId)).toEqual(["run-alive"]);
		expect(existsSync(join(liveDir(dir), "run-dead.json"))).toBe(false);
	});

	test("listLiveRuns removes invalid live entries", () => {
		const dir = tempDir();
		registerLiveRun(dir, { runId: "run-good", routineId: "impl", pid: 123, startedAt: 10, cwd: dir });
		writeFileSync(join(liveDir(dir), "run-zero.json"), JSON.stringify({ runId: "run-zero", pid: 0 }));
		writeFileSync(
			join(liveDir(dir), "run-mismatch.json"),
			JSON.stringify({ runId: "other", routineId: "impl", pid: 123, startedAt: 10, cwd: dir }),
		);

		const runs = listLiveRuns(dir, fakeProcess([123]));

		expect(runs.map((r) => r.runId)).toEqual(["run-good"]);
		expect(existsSync(join(liveDir(dir), "run-zero.json"))).toBe(false);
		expect(existsSync(join(liveDir(dir), "run-mismatch.json"))).toBe(false);
	});

	test("stopLiveRun sends SIGTERM by default and SIGKILL with force", () => {
		const dir = tempDir();
		const killed: Array<{ pid: number; signal: NodeJS.Signals }> = [];
		registerLiveRun(dir, { runId: "run-a", routineId: "impl", pid: 123, startedAt: 10, cwd: dir });

		expect(stopLiveRun(dir, "run-a", { process: fakeProcess([123], killed) })).toMatchObject({
			ok: true,
			signal: "SIGTERM",
		});
		expect(stopLiveRun(dir, "run-a", { force: true, process: fakeProcess([123], killed) })).toMatchObject({
			ok: true,
			signal: "SIGKILL",
		});
		expect(killed).toEqual([
			{ pid: 123, signal: "SIGTERM" },
			{ pid: 123, signal: "SIGKILL" },
		]);
	});

	test("stopLiveRun cleans stale entries", () => {
		const dir = tempDir();
		registerLiveRun(dir, { runId: "run-stale", routineId: "impl", pid: 123, startedAt: 10, cwd: dir });

		const result = stopLiveRun(dir, "run-stale", { process: fakeProcess([]) });

		expect(result).toMatchObject({ ok: false, reason: "stale" });
		expect(loadLiveRun(dir, "run-stale")).toBeUndefined();
	});

	test("stopLiveRun refuses invalid live entries", () => {
		const dir = tempDir();
		const killed: Array<{ pid: number; signal: NodeJS.Signals }> = [];
		mkdirSync(liveDir(dir), { recursive: true });
		writeFileSync(join(liveDir(dir), "run-zero.json"), JSON.stringify({ runId: "run-zero", pid: 0 }));

		const result = stopLiveRun(dir, "run-zero", { process: fakeProcess([0], killed) });

		expect(result).toMatchObject({ ok: false, reason: "not-found" });
		expect(killed).toEqual([]);
	});
});
