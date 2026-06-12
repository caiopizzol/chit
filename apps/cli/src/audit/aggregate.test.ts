import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuditEvent } from "@chit-run/core";
import { aggregateReceipts } from "./aggregate.ts";
import { AuditStore } from "./store.ts";

let dir: string;
let store: AuditStore;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "chit-audit-aggregate-"));
	store = new AuditStore(dir);
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

let tsSeq = 0;
function ev(runId: string, body: Record<string, unknown>): AuditEvent {
	tsSeq++;
	const ts = `2026-06-01T00:00:${String(tsSeq).padStart(2, "0")}.000Z`;
	return { runId, ts, ...body } as unknown as AuditEvent;
}

interface RunSpec {
	startedAt: string;
	surface?: "cli" | "mcp" | "converge";
	scope?: string;
	cwd?: string;
	loopId?: string;
	status?: "ok" | "failed" | "cancelled" | "timeout" | "none"; // "none" = no run.completed
	recipeId?: string;
	usage?: Record<string, number>;
	steps?: number;
	failedSteps?: number;
	iterations?: { verdict: string; decision: string; findingCount: number; checksRun?: string }[];
}

// Write a run whose shape is fully controlled by the spec, through the real
// store, so every event is schema-valid. Bodies are written as blobs that the
// aggregate must never read.
function writeRun(runId: string, spec: RunSpec): void {
	store.openRun(runId);
	store.appendEvent(
		runId,
		ev(runId, {
			type: "run.started",
			ts: spec.startedAt,
			manifestId: "m",
			cwd: spec.cwd ?? "/c",
			surface: spec.surface ?? "converge",
			...(spec.loopId !== undefined && { loopId: spec.loopId }),
			...(spec.scope !== undefined && { scope: spec.scope }),
			...(spec.recipeId !== undefined && {
				recipe: { id: spec.recipeId, mode: "converge" },
			}),
		}) as AuditEvent,
	);
	for (let i = 0; i < (spec.steps ?? 0); i++) {
		store.appendEvent(runId, ev(runId, { type: "step.completed", stepId: `s${i}`, durationMs: 1 }));
	}
	for (let i = 0; i < (spec.failedSteps ?? 0); i++) {
		store.appendEvent(
			runId,
			ev(runId, { type: "step.failed", stepId: `f${i}`, error: "boom", durationMs: 1 }),
		);
	}
	if (spec.usage !== undefined) {
		const outputBlob = store.writeBlob(runId, `OUTPUT ${runId}`);
		store.appendEvent(
			runId,
			ev(runId, {
				type: "adapter.call.completed",
				stepId: "a",
				outputBlob,
				durationMs: 1,
				status: "ok",
				usage: spec.usage,
			}),
		);
	}
	for (const [n, it] of (spec.iterations ?? []).entries()) {
		store.appendEvent(
			runId,
			ev(runId, {
				type: "loop.iteration.recorded",
				loopId: "L",
				n: n + 1,
				verdict: it.verdict,
				decision: it.decision,
				findingCount: it.findingCount,
				changedFiles: [],
				checksRun: it.checksRun ?? "none",
				checkDurationMs: 0,
			}),
		);
	}
	const status = spec.status ?? "ok";
	if (status !== "none") {
		store.appendEvent(runId, ev(runId, { type: "run.completed", status, durationMs: 1 }));
	}
}

describe("aggregateReceipts", () => {
	test("an empty store yields a zeroed aggregate", () => {
		const agg = aggregateReceipts(store);
		expect(agg.runs).toBe(0);
		expect(agg.skipped).toBe(0);
		expect(agg.bySurface).toEqual({});
		expect(agg.byStatus).toEqual({});
		expect(agg.byRecipe).toEqual({});
		expect(agg.steps).toBe(0);
		expect(agg.failedSteps).toBe(0);
		expect(agg.usage).toBeUndefined();
		expect(agg.timeRange).toBeUndefined();
		expect(agg.convergence).toEqual({
			iterations: 0,
			verdicts: { proceed: 0, revise: 0, block: 0 },
			decisions: { proceed: 0, revise: 0, block: 0 },
			findingCount: 0,
			withVerificationSource: 0,
		});
	});

	test("counts mixed surfaces and statuses, including incomplete runs", () => {
		writeRun("a", { startedAt: "2026-06-01T10:00:00.000Z", surface: "converge", status: "ok" });
		writeRun("b", { startedAt: "2026-06-01T11:00:00.000Z", surface: "mcp", status: "failed" });
		writeRun("c", {
			startedAt: "2026-06-01T12:00:00.000Z",
			surface: "converge",
			status: "timeout",
		});
		writeRun("d", { startedAt: "2026-06-01T13:00:00.000Z", surface: "cli", status: "none" });
		const agg = aggregateReceipts(store);
		expect(agg.runs).toBe(4);
		expect(agg.bySurface).toEqual({ converge: 2, mcp: 1, cli: 1 });
		expect(agg.byStatus).toEqual({ ok: 1, failed: 1, timeout: 1, incomplete: 1 });
		expect(agg.timeRange).toEqual({
			earliest: "2026-06-01T10:00:00.000Z",
			latest: "2026-06-01T13:00:00.000Z",
		});
	});

	test("sums usage (tokens and cost) across runs", () => {
		writeRun("a", {
			startedAt: "2026-06-01T10:00:00.000Z",
			usage: { inputTokens: 100, outputTokens: 5, estimatedCostUsd: 0.25 },
		});
		writeRun("b", {
			startedAt: "2026-06-01T11:00:00.000Z",
			usage: { inputTokens: 200, outputTokens: 7, estimatedCostUsd: 0.5 },
		});
		const agg = aggregateReceipts(store);
		expect(agg.usage).toEqual({ inputTokens: 300, outputTokens: 12, estimatedCostUsd: 0.75 });
	});

	test("sums step counts and step.failed events", () => {
		writeRun("a", { startedAt: "2026-06-01T10:00:00.000Z", steps: 3, failedSteps: 1 });
		writeRun("b", { startedAt: "2026-06-01T11:00:00.000Z", steps: 2, failedSteps: 2 });
		const agg = aggregateReceipts(store);
		expect(agg.steps).toBe(5);
		expect(agg.failedSteps).toBe(3);
	});

	test("breaks down by recipe id only when a recipe was declared", () => {
		writeRun("a", { startedAt: "2026-06-01T10:00:00.000Z", recipeId: "converge-default" });
		writeRun("b", { startedAt: "2026-06-01T11:00:00.000Z", recipeId: "converge-default" });
		writeRun("c", { startedAt: "2026-06-01T12:00:00.000Z", recipeId: "deep-review" });
		writeRun("d", { startedAt: "2026-06-01T13:00:00.000Z" }); // no recipe
		const agg = aggregateReceipts(store);
		expect(agg.byRecipe).toEqual({ "converge-default": 2, "deep-review": 1 });
	});

	test("folds convergence verdicts, decisions, findings, and verification source", () => {
		writeRun("a", {
			startedAt: "2026-06-01T10:00:00.000Z",
			iterations: [
				{ verdict: "revise", decision: "revise", findingCount: 3, checksRun: "bun test" },
				{ verdict: "proceed", decision: "proceed", findingCount: 0, checksRun: "none" },
			],
		});
		writeRun("b", {
			startedAt: "2026-06-01T11:00:00.000Z",
			iterations: [
				{ verdict: "block", decision: "block", findingCount: 5, checksRun: "unreported" },
			],
		});
		const agg = aggregateReceipts(store);
		expect(agg.convergence).toEqual({
			iterations: 3,
			verdicts: { proceed: 1, revise: 1, block: 1 },
			decisions: { proceed: 1, revise: 1, block: 1 },
			findingCount: 8,
			// Only the "bun test" iteration names a real verification source; "none"
			// and "unreported" do not.
			withVerificationSource: 1,
		});
	});

	test("since/until filter on startedAt", () => {
		writeRun("old", { startedAt: "2026-06-01T08:00:00.000Z" });
		writeRun("mid", { startedAt: "2026-06-01T10:00:00.000Z" });
		writeRun("new", { startedAt: "2026-06-01T12:00:00.000Z" });
		const agg = aggregateReceipts(store, {
			since: "2026-06-01T09:00:00.000Z",
			until: "2026-06-01T11:00:00.000Z",
		});
		expect(agg.runs).toBe(1);
		expect(agg.timeRange).toEqual({
			earliest: "2026-06-01T10:00:00.000Z",
			latest: "2026-06-01T10:00:00.000Z",
		});
	});

	test("surface filter keeps only the matching surface", () => {
		writeRun("a", { startedAt: "2026-06-01T10:00:00.000Z", surface: "converge" });
		writeRun("b", { startedAt: "2026-06-01T11:00:00.000Z", surface: "mcp" });
		const agg = aggregateReceipts(store, { surface: "mcp" });
		expect(agg.runs).toBe(1);
		expect(agg.bySurface).toEqual({ mcp: 1 });
	});

	test("scope filters but is never an output dimension", () => {
		writeRun("a", { startedAt: "2026-06-01T10:00:00.000Z", scope: "ticket-1" });
		writeRun("b", { startedAt: "2026-06-01T11:00:00.000Z", scope: "ticket-2" });
		const agg = aggregateReceipts(store, { scope: "ticket-1" });
		expect(agg.runs).toBe(1);
		// The aggregate exposes no scope-keyed structure at all.
		expect(JSON.stringify(agg)).not.toContain("ticket-1");
	});

	test("limit keeps the newest runs after sorting, regardless of listRuns order", () => {
		writeRun("old", { startedAt: "2026-06-01T08:00:00.000Z", surface: "cli" });
		writeRun("new", { startedAt: "2026-06-01T12:00:00.000Z", surface: "mcp" });
		writeRun("mid", { startedAt: "2026-06-01T10:00:00.000Z", surface: "converge" });
		const agg = aggregateReceipts(store, { limit: 2 });
		expect(agg.runs).toBe(2);
		// The two newest (new, mid) are folded; the oldest (cli) is dropped.
		expect(agg.bySurface).toEqual({ mcp: 1, converge: 1 });
	});

	test("repoRoot scopes to one repo, excluding unrelated runs in the shared store", () => {
		writeRun("a", { startedAt: "2026-06-01T10:00:00.000Z", cwd: "/repos/alpha" });
		writeRun("b", { startedAt: "2026-06-01T11:00:00.000Z", cwd: "/repos/alpha/sub" });
		writeRun("c", { startedAt: "2026-06-01T12:00:00.000Z", cwd: "/repos/beta" });
		// resolveRepoRoot canonicalizes any subdir to its repo root, exactly as the
		// real git-backed resolver does; here a simple prefix map stands in for git.
		const resolveRepoRoot = (cwd: string) =>
			cwd.startsWith("/repos/alpha") ? "/repos/alpha" : "/repos/beta";
		const agg = aggregateReceipts(store, { repoRoot: "/repos/alpha", resolveRepoRoot });
		// Both alpha runs (root + subdir) are folded; the beta run is excluded.
		expect(agg.runs).toBe(2);
		expect(agg.timeRange).toEqual({
			earliest: "2026-06-01T10:00:00.000Z",
			latest: "2026-06-01T11:00:00.000Z",
		});
		// No cwd / repo path leaks into the metrics-only output.
		expect(JSON.stringify(agg)).not.toContain("/repos");
	});

	test("repoRoot defaults to identity and excludes runs whose cwd has no recorded match", () => {
		writeRun("a", { startedAt: "2026-06-01T10:00:00.000Z", cwd: "/repos/alpha" });
		writeRun("b", { startedAt: "2026-06-01T11:00:00.000Z", cwd: "/repos/beta" });
		// Without a resolver, the recorded cwd is compared verbatim.
		const agg = aggregateReceipts(store, { repoRoot: "/repos/alpha" });
		expect(agg.runs).toBe(1);
	});

	test("repoRoot can use durable run repo metadata before the recorded cwd fallback", () => {
		writeRun("managed", {
			startedAt: "2026-06-01T10:00:00.000Z",
			cwd: "/worktrees/alpha/run",
			loopId: "managed-loop",
			iterations: [{ verdict: "proceed", decision: "proceed", findingCount: 0 }],
		});
		writeRun("other", { startedAt: "2026-06-01T11:00:00.000Z", cwd: "/repos/beta" });
		const agg = aggregateReceipts(store, {
			repoRoot: "/repos/alpha",
			resolveRepoRoot: (cwd) => (cwd.startsWith("/repos/beta") ? "/repos/beta" : cwd),
			resolveRunRepoRoot: (_runId, events) => {
				const started = events.find((e) => e.type === "run.started");
				return started?.type === "run.started" && started.loopId === "managed-loop"
					? "/repos/alpha"
					: undefined;
			},
		});
		expect(agg.runs).toBe(1);
		expect(agg.convergence.iterations).toBe(1);
		expect(JSON.stringify(agg)).not.toContain("/repos");
		expect(JSON.stringify(agg)).not.toContain("/worktrees");
	});

	test("limit must be a non-negative integer", () => {
		expect(() => aggregateReceipts(store, { limit: -1 })).toThrow(/non-negative integer/);
		expect(() => aggregateReceipts(store, { limit: 1.5 })).toThrow(/non-negative integer/);
	});

	test("a corrupt or empty events.jsonl is counted as skipped, never thrown", () => {
		writeRun("good", { startedAt: "2026-06-01T10:00:00.000Z" });
		// A run dir whose log is not valid JSONL.
		mkdirSync(join(dir, "runs", "corrupt"), { recursive: true });
		writeFileSync(join(dir, "runs", "corrupt", "events.jsonl"), "{ not json\n");
		// A run dir whose log is empty.
		mkdirSync(join(dir, "runs", "empty"), { recursive: true });
		writeFileSync(join(dir, "runs", "empty", "events.jsonl"), "");
		const agg = aggregateReceipts(store);
		expect(agg.runs).toBe(1);
		expect(agg.skipped).toBe(2);
	});

	test("invariant: no blob body is ever read", () => {
		writeRun("a", {
			startedAt: "2026-06-01T10:00:00.000Z",
			usage: { inputTokens: 10, outputTokens: 2 },
			iterations: [{ verdict: "proceed", decision: "proceed", findingCount: 0 }],
		});
		// Any blob read during aggregation is a privacy violation: trip-wire it.
		store.readBlob = () => {
			throw new Error("aggregate must never read a blob body");
		};
		const agg = aggregateReceipts(store);
		expect(agg.runs).toBe(1);
		expect(agg.usage).toEqual({ inputTokens: 10, outputTokens: 2 });
	});
});
