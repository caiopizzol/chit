// Repo-local live-run registry. A running `chit run` writes one short JSON file
// under .chit/live so another shell can discover it or ask it to stop.

import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface LiveRun {
	runId: string;
	routineId: string;
	pid: number;
	startedAt: number;
	cwd: string;
}

export interface LiveProcess {
	isAlive(pid: number): boolean;
	kill(pid: number, signal: NodeJS.Signals): void;
}

export const realLiveProcess: LiveProcess = {
	isAlive(pid) {
		try {
			process.kill(pid, 0);
			return true;
		} catch (e) {
			return (e as NodeJS.ErrnoException).code === "EPERM";
		}
	},
	kill(pid, signal) {
		process.kill(pid, signal);
	},
};

export function liveDir(cwd: string): string {
	return join(cwd, ".chit", "live");
}

function livePath(cwd: string, runId: string): string {
	return join(liveDir(cwd), `${runId}.json`);
}

function parseLiveRun(raw: string, expectedRunId: string): LiveRun | undefined {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (typeof value !== "object" || value === null) return undefined;
	const entry = value as Partial<LiveRun>;
	if (entry.runId !== expectedRunId) return undefined;
	if (typeof entry.routineId !== "string" || entry.routineId.length === 0) return undefined;
	const pid = entry.pid;
	if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) return undefined;
	const startedAt = entry.startedAt;
	if (typeof startedAt !== "number" || !Number.isFinite(startedAt)) return undefined;
	if (typeof entry.cwd !== "string" || entry.cwd.length === 0) return undefined;
	return {
		runId: entry.runId,
		routineId: entry.routineId,
		pid,
		startedAt,
		cwd: entry.cwd,
	};
}

function readLiveRun(path: string, expectedRunId: string): LiveRun | undefined {
	try {
		return parseLiveRun(readFileSync(path, "utf-8"), expectedRunId);
	} catch {
		return undefined;
	}
}

export function registerLiveRun(cwd: string, entry: LiveRun): void {
	const dir = liveDir(cwd);
	mkdirSync(dir, { recursive: true });
	writeFileSync(livePath(cwd, entry.runId), `${JSON.stringify(entry, null, 2)}\n`, "utf-8");
}

export function unregisterLiveRun(cwd: string, runId: string): void {
	try {
		unlinkSync(livePath(cwd, runId));
	} catch {
		// The run may have been cleaned up already.
	}
}

export function loadLiveRun(cwd: string, runId: string): LiveRun | undefined {
	const path = livePath(cwd, runId);
	if (!existsSync(path)) return undefined;
	return readLiveRun(path, runId);
}

export function listLiveRuns(cwd: string, proc: LiveProcess = realLiveProcess): LiveRun[] {
	const dir = liveDir(cwd);
	if (!existsSync(dir)) return [];
	const entries: LiveRun[] = [];
	for (const name of readdirSync(dir)) {
		if (!name.endsWith(".json")) continue;
		const path = join(dir, name);
		const entry = readLiveRun(path, name.slice(0, -".json".length));
		if (entry === undefined) {
			try {
				unlinkSync(path);
			} catch {}
			continue;
		}
		if (proc.isAlive(entry.pid)) {
			entries.push(entry);
		} else {
			try {
				unlinkSync(path);
			} catch {}
		}
	}
	return entries;
}

export type StopLiveRunResult =
	| { ok: true; run: LiveRun; signal: NodeJS.Signals }
	| { ok: false; reason: "not-found" | "stale" | "signal-failed"; message: string };

export function stopLiveRun(
	cwd: string,
	runId: string,
	opts: { force?: boolean; process?: LiveProcess } = {},
): StopLiveRunResult {
	const proc = opts.process ?? realLiveProcess;
	const run = loadLiveRun(cwd, runId);
	if (run === undefined)
		return { ok: false, reason: "not-found", message: `no live run ${JSON.stringify(runId)} found` };
	if (!proc.isAlive(run.pid)) {
		unregisterLiveRun(cwd, runId);
		return {
			ok: false,
			reason: "stale",
			message: `run ${runId} is no longer running (cleaned up stale live entry)`,
		};
	}
	const signal: NodeJS.Signals = opts.force ? "SIGKILL" : "SIGTERM";
	try {
		proc.kill(run.pid, signal);
		return { ok: true, run, signal };
	} catch (e) {
		return { ok: false, reason: "signal-failed", message: `could not signal pid ${run.pid}: ${(e as Error).message}` };
	}
}
