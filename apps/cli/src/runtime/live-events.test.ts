import { describe, expect, test } from "bun:test";
import {
	appendLiveEvent,
	type LiveEventSummary,
	MAX_LIVE_EVENTS,
	sanitizeLiveEvents,
	summarizeAdapterEvent,
	summarizeTraceEvent,
} from "./live-events.ts";

function summary(overrides: Partial<LiveEventSummary> & { ts: number }): LiveEventSummary {
	return { kind: "adapter.event", label: "x", ...overrides };
}

describe("appendLiveEvent", () => {
	test("caps the tail at MAX_LIVE_EVENTS, keeping the newest", () => {
		const events: LiveEventSummary[] = [];
		for (let i = 0; i < MAX_LIVE_EVENTS + 7; i++) {
			appendLiveEvent(events, summary({ ts: i }));
		}
		expect(events).toHaveLength(MAX_LIVE_EVENTS);
		expect(events[0]?.ts).toBe(7);
		expect(events[events.length - 1]?.ts).toBe(MAX_LIVE_EVENTS + 6);
	});
});

describe("summarizeTraceEvent", () => {
	test("step.started carries ids but never the prompt", () => {
		const out = summarizeTraceEvent(
			{
				type: "step.started",
				stepId: "ask",
				kind: "call",
				participantId: "codex",
				agentId: "codex-agent",
				session: "resumed",
				prompt: "SECRET interpolated prompt",
			},
			1000,
		);
		expect(out).toEqual({
			ts: 1000,
			kind: "step.started",
			label: "step ask started",
			stepId: "ask",
			participantId: "codex",
			agentId: "codex-agent",
		});
		expect(JSON.stringify(out)).not.toContain("SECRET");
		expect(JSON.stringify(out)).not.toContain("session");
	});

	test("step.completed never carries the output", () => {
		const out = summarizeTraceEvent(
			{ type: "step.completed", stepId: "ask", output: "SECRET output", durationMs: 42 },
			1000,
		);
		expect(out).toEqual({
			ts: 1000,
			kind: "step.completed",
			label: "step ask completed (42ms)",
			stepId: "ask",
		});
		expect(JSON.stringify(out)).not.toContain("SECRET");
	});

	test("step.failed label states the failure without the error text", () => {
		const out = summarizeTraceEvent(
			{ type: "step.failed", stepId: "ask", error: "SECRET token leaked in stderr", durationMs: 9 },
			1000,
		);
		expect(out).toEqual({
			ts: 1000,
			kind: "step.failed",
			label: "step ask failed (9ms)",
			stepId: "ask",
		});
		expect(JSON.stringify(out)).not.toContain("SECRET");
	});
});

describe("summarizeAdapterEvent", () => {
	test("summarizes from the type string and context ids only", () => {
		const out = summarizeAdapterEvent(
			"item.completed",
			{ stepId: "ask", participantId: "codex", agentId: "codex-agent" },
			1000,
		);
		expect(out).toEqual({
			ts: 1000,
			kind: "adapter.event",
			label: "item.completed",
			stepId: "ask",
			participantId: "codex",
			agentId: "codex-agent",
		});
	});

	test("omits absent context ids instead of writing undefined", () => {
		const out = summarizeAdapterEvent("turn.started", { stepId: "ask" }, 1000);
		expect(Object.keys(out).sort()).toEqual(["kind", "label", "stepId", "ts"]);
	});
});

describe("sanitizeLiveEvents", () => {
	test("returns [] for anything that is not an array", () => {
		expect(sanitizeLiveEvents(undefined)).toEqual([]);
		expect(sanitizeLiveEvents(null)).toEqual([]);
		expect(sanitizeLiveEvents("[]")).toEqual([]);
		expect(sanitizeLiveEvents({ 0: summary({ ts: 1 }) })).toEqual([]);
	});

	test("drops malformed entries and keeps valid ones", () => {
		const out = sanitizeLiveEvents([
			null,
			"step ask started",
			42,
			[summary({ ts: 1 })],
			{ ts: "1", kind: "adapter.event", label: "x" },
			{ ts: Number.NaN, kind: "adapter.event", label: "x" },
			{ ts: 1, kind: "made.up.kind", label: "x" },
			{ ts: 1, kind: "adapter.event" },
			summary({ ts: 2, label: "kept" }),
		]);
		expect(out).toEqual([{ ts: 2, kind: "adapter.event", label: "kept" }]);
	});

	test("strips foreign keys: raw, body, prompt, output, error, session", () => {
		const out = sanitizeLiveEvents([
			{
				ts: 1,
				kind: "step.failed",
				label: "step ask failed (9ms)",
				stepId: "ask",
				raw: "SECRET raw jsonl line",
				body: "SECRET body",
				prompt: "SECRET prompt",
				output: "SECRET output",
				error: "SECRET error",
				session: { threadId: "SECRET" },
			},
		]);
		expect(out).toEqual([
			{ ts: 1, kind: "step.failed", label: "step ask failed (9ms)", stepId: "ask" },
		]);
		expect(JSON.stringify(out)).not.toContain("SECRET");
	});

	test("non-string optional ids are dropped, not coerced", () => {
		const out = sanitizeLiveEvents([
			{ ts: 1, kind: "adapter.event", label: "x", participantId: 7, agentId: null },
		]);
		expect(out).toEqual([{ ts: 1, kind: "adapter.event", label: "x" }]);
	});

	test("keeps only the newest MAX_LIVE_EVENTS valid entries", () => {
		const entries: unknown[] = [];
		for (let i = 0; i < MAX_LIVE_EVENTS + 5; i++) {
			entries.push(summary({ ts: i }));
			entries.push({ ts: i, kind: "bogus", label: "invalid" });
		}
		const out = sanitizeLiveEvents(entries);
		expect(out).toHaveLength(MAX_LIVE_EVENTS);
		expect(out[0]?.ts).toBe(5);
		expect(out[out.length - 1]?.ts).toBe(MAX_LIVE_EVENTS + 4);
	});

	test("a reader clock drops future-dated entries BEFORE the cap, keeping datable ones", () => {
		const now = 100_000;
		// Datable entries first, then a full cap's worth of future ones: capping
		// before the future filter would evict every datable entry and emit [].
		const entries: unknown[] = [];
		for (let i = 0; i < 10; i++) entries.push(summary({ ts: now - 1_000 + i, label: `safe-${i}` }));
		for (let i = 0; i < MAX_LIVE_EVENTS; i++) {
			entries.push(summary({ ts: now + 1_000 + i, label: `future-${i}` }));
		}
		const out = sanitizeLiveEvents(entries, now);
		expect(out.map((e) => e.label)).toEqual(Array.from({ length: 10 }, (_, i) => `safe-${i}`));
	});

	test("an entry dated exactly at the reader clock is kept (age 0 is derivable)", () => {
		const out = sanitizeLiveEvents([summary({ ts: 5_000 })], 5_000);
		expect(out).toHaveLength(1);
	});

	test("without a reader clock, future-dated entries pass through unchanged", () => {
		// Shape-only sanitization (the read-modify-write paths): a skewed writer's
		// future timestamp is preserved, not destroyed.
		const out = sanitizeLiveEvents([summary({ ts: Number.MAX_SAFE_INTEGER })]);
		expect(out).toHaveLength(1);
	});
});
