// Durable per-run lifecycle events. The run process is the only writer, and
// other Chit processes can follow the run without scraping the human log.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runsDir } from "./store.ts";

// The terminal outcome carried by a `done` event. Mirrors every receipt's status union
// (see run.ts / converge.ts / flow.ts); the emit site passes `receipt.status`, so adding a
// receipt status that is missing here is a compile error there rather than silent drift.
const TERMINAL_STATUSES = ["completed", "failed", "cancelled", "converged", "did-not-converge"] as const;
export type TerminalStatus = (typeof TERMINAL_STATUSES)[number];

function isTerminalStatus(value: unknown): value is TerminalStatus {
	return typeof value === "string" && TERMINAL_STATUSES.includes(value as TerminalStatus);
}

export type RunEvent =
	| { at: number; kind: "progress"; line: string }
	| { at: number; kind: "ready"; baseCommit?: string }
	| { at: number; kind: "failed"; error: string }
	// The run reached a terminal receipt. `failed` marks a startup failure that wrote NO receipt
	// (an orphan); `done` marks a receipt written, so a follower of the stream sees the outcome and
	// the exit code `chit wait` resolves to without scraping the receipt itself.
	| { at: number; kind: "done"; status: TerminalStatus; exitCode: number };

export function runEventsPath(cwd: string, runId: string): string {
	return join(runsDir(cwd), `${runId}.events.jsonl`);
}

export function initRunEvents(cwd: string, runId: string): string {
	const dir = runsDir(cwd);
	mkdirSync(dir, { recursive: true });
	const path = runEventsPath(cwd, runId);
	writeFileSync(path, "", "utf-8");
	return path;
}

export function appendRunEvent(cwd: string, runId: string, event: RunEvent): void {
	mkdirSync(runsDir(cwd), { recursive: true });
	appendFileSync(runEventsPath(cwd, runId), `${JSON.stringify(event)}\n`, "utf-8");
}

export function readRunEvents(cwd: string, runId: string): RunEvent[] {
	const path = runEventsPath(cwd, runId);
	if (!existsSync(path)) return [];
	let raw: string;
	try {
		raw = readFileSync(path, "utf-8");
	} catch {
		return [];
	}
	const events: RunEvent[] = [];
	for (const line of raw.split("\n")) {
		if (line.trim() === "") continue;
		const event = parseEvent(line);
		if (event !== undefined) events.push(event);
	}
	return events;
}

function parseEvent(line: string): RunEvent | undefined {
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (typeof value !== "object" || value === null) return undefined;
	const e = value as Record<string, unknown>;
	if (typeof e.at !== "number") return undefined;
	if (e.kind === "progress") {
		return typeof e.line === "string" ? { at: e.at, kind: "progress", line: e.line } : undefined;
	}
	if (e.kind === "ready") {
		if (e.baseCommit === undefined) return { at: e.at, kind: "ready" };
		return typeof e.baseCommit === "string" ? { at: e.at, kind: "ready", baseCommit: e.baseCommit } : undefined;
	}
	if (e.kind === "failed") {
		return typeof e.error === "string" ? { at: e.at, kind: "failed", error: e.error } : undefined;
	}
	if (e.kind === "done") {
		if (!isTerminalStatus(e.status) || typeof e.exitCode !== "number") return undefined;
		return { at: e.at, kind: "done", status: e.status, exitCode: e.exitCode };
	}
	return undefined;
}

export interface RunEventSink {
	progress(line: string): void;
	ready(baseCommit?: string): void;
	failed(error: string): void;
	done(status: TerminalStatus, exitCode: number): void;
}

export function createRunEventSink(cwd: string, runId: string, now: () => number): RunEventSink {
	return {
		progress(line) {
			appendRunEvent(cwd, runId, { at: now(), kind: "progress", line });
		},
		ready(baseCommit) {
			appendRunEvent(cwd, runId, { at: now(), kind: "ready", ...(baseCommit !== undefined && { baseCommit }) });
		},
		failed(error) {
			appendRunEvent(cwd, runId, { at: now(), kind: "failed", error });
		},
		done(status, exitCode) {
			appendRunEvent(cwd, runId, { at: now(), kind: "done", status, exitCode });
		},
	};
}
