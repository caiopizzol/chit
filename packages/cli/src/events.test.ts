import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendRunEvent, createRunEventSink, initRunEvents, readRunEvents, runEventsPath } from "./events.ts";

const dirs: string[] = [];
function tmp(): string {
	const d = mkdtempSync(join(tmpdir(), "chit-events-"));
	dirs.push(d);
	return d;
}
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("run event stream", () => {
	test("append then read round-trips events in order", () => {
		const dir = tmp();
		appendRunEvent(dir, "r1", { at: 1, kind: "progress", line: "iteration 1" });
		appendRunEvent(dir, "r1", { at: 2, kind: "ready", baseCommit: "abc123" });
		appendRunEvent(dir, "r1", { at: 3, kind: "progress", line: "  call builder done" });

		expect(readRunEvents(dir, "r1")).toEqual([
			{ at: 1, kind: "progress", line: "iteration 1" },
			{ at: 2, kind: "ready", baseCommit: "abc123" },
			{ at: 3, kind: "progress", line: "  call builder done" },
		]);
	});

	test("missing stream reads as empty", () => {
		expect(readRunEvents(tmp(), "ghost")).toEqual([]);
	});

	test("a torn trailing line (a crash mid-append) is skipped, not fatal", () => {
		const dir = tmp();
		appendRunEvent(dir, "r1", { at: 1, kind: "ready" });
		// Simulate a half-written final line, as a crashed writer would leave.
		appendFileSync(runEventsPath(dir, "r1"), '{"at":2,"kind":"progr', "utf-8");

		expect(readRunEvents(dir, "r1")).toEqual([{ at: 1, kind: "ready" }]);
	});

	test("malformed and wrong-shaped lines are dropped", () => {
		const dir = tmp();
		initRunEvents(dir, "r1");
		writeFileSync(
			runEventsPath(dir, "r1"),
			[
				"not json",
				JSON.stringify({ at: "nope", kind: "progress", line: "x" }), // bad timestamp
				JSON.stringify({ at: 1, kind: "mystery" }), // unknown kind
				JSON.stringify({ at: 2, kind: "progress" }), // missing line
				JSON.stringify({ at: 3, kind: "progress", line: "keep me" }),
				"",
			].join("\n"),
			"utf-8",
		);

		expect(readRunEvents(dir, "r1")).toEqual([{ at: 3, kind: "progress", line: "keep me" }]);
	});

	test("initRunEvents truncates a reused stream so a run never inherits stale events", () => {
		const dir = tmp();
		appendRunEvent(dir, "r1", { at: 1, kind: "progress", line: "old run" });
		initRunEvents(dir, "r1");
		appendRunEvent(dir, "r1", { at: 2, kind: "ready" });

		expect(readRunEvents(dir, "r1")).toEqual([{ at: 2, kind: "ready" }]);
	});

	test("the sink stamps events with the clock and omits an absent base commit", () => {
		const dir = tmp();
		let clock = 0;
		const events = createRunEventSink(dir, "r1", () => (clock += 10));
		events.progress("working");
		events.ready();
		events.failed("boom");

		expect(readRunEvents(dir, "r1")).toEqual([
			{ at: 10, kind: "progress", line: "working" },
			{ at: 20, kind: "ready" },
			{ at: 30, kind: "failed", error: "boom" },
		]);
		// The ready line carries no baseCommit key when none was given.
		expect(readFileSync(runEventsPath(dir, "r1"), "utf-8")).not.toContain("baseCommit");
	});

	test("a done event round-trips its terminal status and exit code", () => {
		const dir = tmp();
		const events = createRunEventSink(dir, "r1", () => 7);
		events.ready();
		events.done("converged", 0);

		expect(readRunEvents(dir, "r1")).toEqual([
			{ at: 7, kind: "ready" },
			{ at: 7, kind: "done", status: "converged", exitCode: 0 },
		]);
	});

	test("a done event missing its status or exit code is dropped", () => {
		const dir = tmp();
		initRunEvents(dir, "r1");
		writeFileSync(
			runEventsPath(dir, "r1"),
			[
				JSON.stringify({ at: 1, kind: "done", status: "completed" }), // missing exitCode
				JSON.stringify({ at: 2, kind: "done", exitCode: 0 }), // missing status
				JSON.stringify({ at: 3, kind: "done", status: "mystery", exitCode: 0 }), // unknown status
				JSON.stringify({ at: 4, kind: "done", status: "completed", exitCode: 0 }), // valid
			].join("\n"),
			"utf-8",
		);

		expect(readRunEvents(dir, "r1")).toEqual([{ at: 4, kind: "done", status: "completed", exitCode: 0 }]);
	});
});
