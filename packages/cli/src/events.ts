// Durable per-run lifecycle events. The run process is the only writer, and
// other Chit processes can follow the run without scraping the human log.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runsDir } from "./store.ts";

export type RunEvent =
	| { at: number; kind: "progress"; line: string }
	| { at: number; kind: "ready"; baseCommit?: string }
	| { at: number; kind: "failed"; error: string };

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
	return undefined;
}

export interface RunEventSink {
	progress(line: string): void;
	ready(baseCommit?: string): void;
	failed(error: string): void;
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
	};
}
