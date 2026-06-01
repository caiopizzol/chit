import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuditEvent } from "@chit-run/core";
import { auditTimeline, describeIncomplete, listAudit, showAudit, summarizeRun } from "./reader.ts";
import { AuditStore } from "./store.ts";

let dir: string;
let store: AuditStore;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "chit-audit-reader-"));
	store = new AuditStore(dir);
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

// Stamp the envelope (runId + a monotonic ISO ts) onto a type-specific body, so
// each test writes real, schema-valid AuditEvents through the store.
let tsSeq = 0;
function ev(runId: string, body: Record<string, unknown>): AuditEvent {
	tsSeq++;
	const ts = `2026-06-01T00:00:${String(tsSeq).padStart(2, "0")}.000Z`;
	return { runId, ts, ...body } as unknown as AuditEvent;
}

// Write a healthy, complete run with one audited call (input + output blobs) and
// usage, returning its id. startedAt is controllable so list ordering is testable.
function writeCompleteRun(runId: string, startedAt: string): void {
	store.openRun(runId);
	const inputBlob = store.writeBlob(runId, `PROMPT for ${runId}`);
	const outputBlob = store.writeBlob(runId, `OUTPUT for ${runId}`);
	store.appendEvent(
		runId,
		ev(runId, {
			type: "run.started",
			ts: startedAt,
			manifestId: "m",
			cwd: "/x",
			surface: "converge",
			scope: "s",
		}) as AuditEvent,
	);
	store.appendEvent(runId, ev(runId, { type: "step.started", stepId: "implement", kind: "call" }));
	store.appendEvent(
		runId,
		ev(runId, {
			type: "adapter.call.started",
			stepId: "implement",
			participantId: "implementer",
			agentId: "claude",
			cwd: "/x",
			inputBlob,
		}),
	);
	store.appendEvent(
		runId,
		ev(runId, {
			type: "adapter.call.completed",
			stepId: "implement",
			outputBlob,
			durationMs: 50,
			status: "ok",
			usage: { inputTokens: 10, outputTokens: 3 },
		}),
	);
	store.appendEvent(
		runId,
		ev(runId, { type: "step.completed", stepId: "implement", durationMs: 51 }),
	);
	store.appendEvent(runId, ev(runId, { type: "run.completed", status: "ok", durationMs: 60 }));
}

describe("summarizeRun", () => {
	test("a complete run reports its run.completed status, usage, and metadata", () => {
		writeCompleteRun("done1", "2026-06-01T10:00:00.000Z");
		const s = summarizeRun("done1", store.readEvents("done1"));
		expect(s.status).toBe("ok");
		expect(s.manifestId).toBe("m");
		expect(s.surface).toBe("converge");
		expect(s.scope).toBe("s");
		expect(s.stepCount).toBe(1);
		expect(s.usage).toEqual({ inputTokens: 10, outputTokens: 3 });
		expect(s.openCall).toBeUndefined();
	});

	test("a run with no run.completed is incomplete; an open call is detected", () => {
		store.openRun("open1");
		const inputBlob = store.writeBlob("open1", "P");
		store.appendEvent(
			"open1",
			ev("open1", { type: "run.started", manifestId: "m", cwd: "/x", surface: "mcp" }),
		);
		store.appendEvent(
			"open1",
			ev("open1", {
				type: "adapter.call.started",
				stepId: "implement",
				participantId: "p",
				agentId: "claude",
				cwd: "/x",
				inputBlob,
			}),
		);
		// no adapter.call.completed, no run.completed -> killed mid-call
		const s = summarizeRun("open1", store.readEvents("open1"));
		expect(s.status).toBe("incomplete");
		expect(s.openCall?.stepId).toBe("implement");
		expect(s.openCall?.agentId).toBe("claude");
	});
});

describe("describeIncomplete", () => {
	test("open call takes precedence and names the stuck step", () => {
		store.openRun("o");
		const inputBlob = store.writeBlob("o", "P");
		store.appendEvent(
			"o",
			ev("o", { type: "run.started", manifestId: "m", cwd: "/x", surface: "mcp" }),
		);
		store.appendEvent(
			"o",
			ev("o", {
				type: "adapter.call.started",
				stepId: "review",
				participantId: "p",
				agentId: "codex",
				cwd: "/x",
				inputBlob,
			}),
		);
		const events = store.readEvents("o");
		const s = summarizeRun("o", events);
		expect(describeIncomplete(s, events)).toMatch(/open call: review/);
	});

	test("a failed step is reported when no call is open", () => {
		store.openRun("f");
		store.appendEvent(
			"f",
			ev("f", { type: "run.started", manifestId: "m", cwd: "/x", surface: "cli" }),
		);
		store.appendEvent(
			"f",
			ev("f", { type: "step.failed", stepId: "review", error: "boom happened", durationMs: 5 }),
		);
		const events = store.readEvents("f");
		const s = summarizeRun("f", events);
		expect(describeIncomplete(s, events)).toMatch(/failed step: review: boom happened/);
	});

	test("an abandoned run (no terminal, no failure, no open call) says so", () => {
		store.openRun("a");
		store.appendEvent(
			"a",
			ev("a", { type: "run.started", manifestId: "m", cwd: "/x", surface: "cli" }),
		);
		store.appendEvent("a", ev("a", { type: "step.started", stepId: "implement", kind: "format" }));
		const events = store.readEvents("a");
		const s = summarizeRun("a", events);
		expect(describeIncomplete(s, events)).toBe("abandoned before terminal run.completed");
	});
});

describe("listAudit", () => {
	test("returns runs newest-first and honors the limit", () => {
		writeCompleteRun("old", "2026-06-01T08:00:00.000Z");
		writeCompleteRun("new", "2026-06-01T12:00:00.000Z");
		writeCompleteRun("mid", "2026-06-01T10:00:00.000Z");
		expect(listAudit(store).map((r) => r.runId)).toEqual(["new", "mid", "old"]);
		expect(listAudit(store, 2).map((r) => r.runId)).toEqual(["new", "mid"]);
	});

	test("is robust to a corrupt run log (summarized as incomplete, never throws)", () => {
		writeCompleteRun("good", "2026-06-01T09:00:00.000Z");
		// A run dir whose events.jsonl is not valid JSONL.
		mkdirSync(join(dir, "runs", "corrupt"), { recursive: true });
		writeFileSync(join(dir, "runs", "corrupt", "events.jsonl"), "{ not json\n");
		const runs = listAudit(store);
		const corrupt = runs.find((r) => r.runId === "corrupt");
		expect(corrupt?.status).toBe("incomplete");
		expect(corrupt?.manifestId).toBe("?");
		expect(runs.find((r) => r.runId === "good")?.status).toBe("ok");
	});
});

describe("auditTimeline", () => {
	test("omits bodies by default", () => {
		writeCompleteRun("r", "2026-06-01T10:00:00.000Z");
		const tl = auditTimeline(store, "r", store.readEvents("r"), false);
		const started = tl.find((e) => e.type === "adapter.call.started");
		const completed = tl.find((e) => e.type === "adapter.call.completed");
		expect(started && "input" in started).toBe(false);
		expect(completed && "output" in completed).toBe(false);
	});

	test("includes bodies (resolved from the event's own refs) when requested", () => {
		writeCompleteRun("r", "2026-06-01T10:00:00.000Z");
		const tl = auditTimeline(store, "r", store.readEvents("r"), true);
		const started = tl.find((e) => e.type === "adapter.call.started");
		const completed = tl.find((e) => e.type === "adapter.call.completed");
		expect(started?.type === "adapter.call.started" && started.input).toBe("PROMPT for r");
		expect(completed?.type === "adapter.call.completed" && completed.output).toBe("OUTPUT for r");
	});

	test("marks a missing blob unavailable rather than throwing", () => {
		store.openRun("r");
		// A valid sha256-shaped ref that has no blob on disk.
		const danglingRef = "a".repeat(64);
		store.appendEvent(
			"r",
			ev("r", { type: "run.started", manifestId: "m", cwd: "/x", surface: "mcp" }),
		);
		store.appendEvent(
			"r",
			ev("r", {
				type: "adapter.call.started",
				stepId: "s",
				participantId: "p",
				agentId: "claude",
				cwd: "/x",
				inputBlob: danglingRef,
			}),
		);
		const tl = auditTimeline(store, "r", store.readEvents("r"), true);
		const started = tl.find((e) => e.type === "adapter.call.started");
		expect(started?.type === "adapter.call.started" && started.input).toMatch(/blob unavailable/);
	});
});

describe("showAudit", () => {
	test("throws on an invalid run id (no generic file access)", () => {
		expect(() => showAudit(store, "../etc", false)).toThrow(/invalid run id/);
	});

	test("throws on a missing run", () => {
		expect(() => showAudit(store, "nope", false)).toThrow(/no audit log/);
	});

	test("returns summary + timeline; bodies gated on include_bodies", () => {
		writeCompleteRun("r", "2026-06-01T10:00:00.000Z");
		const without = showAudit(store, "r", false);
		expect(without.summary.status).toBe("ok");
		expect(without.incompleteReason).toBeUndefined();
		expect(without.timeline.some((e) => "input" in e || "output" in e)).toBe(false);

		const withBodies = showAudit(store, "r", true);
		expect(withBodies.timeline.some((e) => "output" in e)).toBe(true);
	});

	test("an incomplete run carries the reason", () => {
		store.openRun("inc");
		store.appendEvent(
			"inc",
			ev("inc", { type: "run.started", manifestId: "m", cwd: "/x", surface: "cli" }),
		);
		store.appendEvent(
			"inc",
			ev("inc", { type: "step.failed", stepId: "review", error: "nope", durationMs: 1 }),
		);
		const show = showAudit(store, "inc", false);
		expect(show.summary.status).toBe("incomplete");
		expect(show.incompleteReason).toMatch(/failed step: review/);
	});
});
