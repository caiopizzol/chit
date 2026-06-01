import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AdapterCallCompletedEvent,
	type AdapterCallStartedEvent,
	type AdapterEventEvent,
	parseManifest,
	type StepCompletedEvent,
} from "@chit-run/core";
import { executeManifest } from "../runtime/execute.ts";
import type { AdapterCallRequest, RuntimeAdapter } from "../runtime/types.ts";
import { AuditRecorder } from "./recorder.ts";
import { AuditStore } from "./store.ts";
import { wrapAdaptersWithAudit } from "./wrap.ts";

let baseDir: string;
let store: AuditStore;

beforeEach(() => {
	baseDir = mkdtempSync(join(tmpdir(), "chit-rec-"));
	store = new AuditStore(baseDir);
});
afterEach(() => {
	rmSync(baseDir, { recursive: true, force: true });
});

// A fixed clock so ts is deterministic (not asserted; event order comes from
// append order, not ts).
const fixedClock = () => 1_700_000_000_000;

function recorder(runId = "R1"): AuditRecorder {
	return new AuditRecorder(
		store,
		runId,
		{ manifestId: "m", cwd: "/c", surface: "converge", scope: "s" },
		fixedClock,
	);
}

const req = (over: Partial<AdapterCallRequest> = {}): AdapterCallRequest => ({
	participantId: "p",
	agentId: "a",
	stepId: "s1",
	input: "PROMPT BODY",
	cwd: "/c",
	...over,
});

function started(runId: string): AdapterCallStartedEvent | undefined {
	return store
		.readEvents(runId)
		.find((e): e is AdapterCallStartedEvent => e.type === "adapter.call.started");
}
function completed(runId: string): AdapterCallCompletedEvent | undefined {
	return store
		.readEvents(runId)
		.find((e): e is AdapterCallCompletedEvent => e.type === "adapter.call.completed");
}

describe("AuditRecorder", () => {
	test("records a run lifecycle in order, with prompt/output blobs and usage", () => {
		const rec = recorder();
		rec.runStarted();
		rec.fromTrace({
			type: "step.started",
			stepId: "s1",
			kind: "call",
			participantId: "p",
			agentId: "a",
		});
		rec.adapterCallStarted(req());
		rec.adapterCallCompleted(
			req(),
			{ output: "OUT BODY", usage: { inputTokens: 10, outputTokens: 2 } },
			1234,
			"ok",
			"OUT BODY",
		);
		rec.fromTrace({ type: "step.completed", stepId: "s1", output: "OUT BODY", durationMs: 1500 });
		rec.runCompleted("ok", 2000);

		const events = store.readEvents("R1");
		expect(events.map((e) => e.type)).toEqual([
			"run.started",
			"step.started",
			"adapter.call.started",
			"adapter.call.completed",
			"step.completed",
			"run.completed",
		]);
		expect(store.readBlob("R1", started("R1")?.inputBlob ?? "")).toBe("PROMPT BODY");
		const done = completed("R1");
		expect(store.readBlob("R1", done?.outputBlob ?? "")).toBe("OUT BODY");
		expect(done?.usage).toEqual({ inputTokens: 10, outputTokens: 2 });
		expect(done?.status).toBe("ok");
		// step.completed also captures the step output as a blob (full replay).
		const stepDone = store
			.readEvents("R1")
			.find((e): e is StepCompletedEvent => e.type === "step.completed");
		expect(store.readBlob("R1", stepDone?.outputBlob ?? "")).toBe("OUT BODY");
		expect(rec.lastError).toBeUndefined();
	});

	test("run.started carries optional loop linkage metadata when present", () => {
		const rec = new AuditRecorder(
			store,
			"R2",
			{ manifestId: "m", cwd: "/c", surface: "converge", loopId: "L1", iteration: 2 },
			fixedClock,
		);
		rec.runStarted();
		const ev = store.readEvents("R2")[0];
		expect(ev).toMatchObject({ type: "run.started", loopId: "L1", iteration: 2 });
	});

	test("step.failed maps through with error and duration", () => {
		const rec = recorder();
		rec.runStarted();
		rec.fromTrace({ type: "step.failed", stepId: "s1", error: "boom", durationMs: 50 });
		const ev = store.readEvents("R1").find((e) => e.type === "step.failed");
		expect(ev).toMatchObject({ type: "step.failed", stepId: "s1", error: "boom", durationMs: 50 });
	});

	test("audit is best-effort: a failing store is swallowed and surfaced on lastError", () => {
		const broken = {
			openRun() {
				throw new Error("disk full");
			},
			writeBlob() {
				throw new Error("disk full");
			},
			appendEvent() {
				throw new Error("disk full");
			},
		} as unknown as AuditStore;
		const rec = new AuditRecorder(broken, "R1", {
			manifestId: "m",
			cwd: "/c",
			surface: "converge",
		});
		expect(() => rec.runStarted()).not.toThrow();
		expect(() => rec.adapterCallStarted(req())).not.toThrow();
		expect(rec.lastError?.message).toMatch(/disk full/);
	});
});

describe("wrapAdaptersWithAudit", () => {
	test("is transparent and records started/completed with blobs + usage", async () => {
		const rec = recorder();
		rec.runStarted();
		const fake: RuntimeAdapter = {
			call: async (r) => ({ output: `echo:${r.input}`, usage: { inputTokens: 5 } }),
		};
		const wrapped = wrapAdaptersWithAudit({ a: fake }, rec);
		const result = await wrapped.a?.call(req({ input: "hi" }));
		expect(result?.output).toBe("echo:hi"); // transparent passthrough

		expect(store.readBlob("R1", started("R1")?.inputBlob ?? "")).toBe("hi");
		const done = completed("R1");
		expect(store.readBlob("R1", done?.outputBlob ?? "")).toBe("echo:hi");
		expect(done?.usage).toEqual({ inputTokens: 5 });
		expect(done?.status).toBe("ok");
	});

	test("a thrown error records status=error with the error text as output blob, then rethrows", async () => {
		const rec = recorder();
		rec.runStarted();
		const fake: RuntimeAdapter = {
			call: async () => {
				throw new Error("kaboom");
			},
		};
		const wrapped = wrapAdaptersWithAudit({ a: fake }, rec);
		await expect(wrapped.a?.call(req())).rejects.toThrow("kaboom");
		const done = completed("R1");
		expect(done?.status).toBe("error");
		expect(store.readBlob("R1", done?.outputBlob ?? "")).toBe("kaboom");
	});

	test("an aborted call records status=cancelled", async () => {
		const rec = recorder();
		rec.runStarted();
		const ac = new AbortController();
		ac.abort();
		const fake: RuntimeAdapter = {
			call: async () => {
				throw new Error("aborted by client");
			},
		};
		const wrapped = wrapAdaptersWithAudit({ a: fake }, rec);
		await expect(wrapped.a?.call(req({ signal: ac.signal }))).rejects.toThrow();
		expect(completed("R1")?.status).toBe("cancelled");
	});

	test("records an adapter.event for each event the adapter emits, between started and completed", async () => {
		const rec = recorder();
		rec.runStarted();
		const fake: RuntimeAdapter = {
			call: async (r) => {
				r.onEvent?.({ type: "thread.started", raw: '{"type":"thread.started"}' });
				r.onEvent?.({ type: "item.completed", raw: '{"type":"item.completed"}' });
				return { output: "OK" };
			},
		};
		const wrapped = wrapAdaptersWithAudit({ a: fake }, rec);
		await wrapped.a?.call(req());
		const events = store.readEvents("R1");
		expect(events.map((e) => e.type)).toEqual([
			"run.started",
			"adapter.call.started",
			"adapter.event",
			"adapter.event",
			"adapter.call.completed",
		]);
		const first = events.find((e): e is AdapterEventEvent => e.type === "adapter.event");
		expect(first?.eventType).toBe("thread.started");
		expect(store.readBlob("R1", first?.rawBlob ?? "")).toBe('{"type":"thread.started"}');
	});

	test("forwards to a pre-existing onEvent (composes, does not replace)", async () => {
		const rec = recorder();
		rec.runStarted();
		const seen: string[] = [];
		const fake: RuntimeAdapter = {
			call: async (r) => {
				r.onEvent?.({ type: "x", raw: "{}" });
				return { output: "OK" };
			},
		};
		const wrapped = wrapAdaptersWithAudit({ a: fake }, rec);
		await wrapped.a?.call(req({ onEvent: (e) => seen.push(e.type) }));
		expect(seen).toEqual(["x"]); // the caller's onEvent still fired
		expect(store.readEvents("R1").some((e) => e.type === "adapter.event")).toBe(true);
	});
});

describe("audit integration via executeManifest", () => {
	test("a manifest run writes a full audit run: run/step/adapter-call events + blobs", async () => {
		const manifest = parseManifest(
			JSON.parse(
				readFileSync(
					join(import.meta.dir, "..", "..", "..", "..", "examples", "investigate-bug.json"),
					"utf8",
				),
			),
		);
		const rec = recorder("RUN");
		rec.runStarted();
		const fake: RuntimeAdapter = {
			call: async (r) => ({ output: `OK:${r.stepId}`, usage: { inputTokens: 3, outputTokens: 1 } }),
		};
		const adapters = wrapAdaptersWithAudit({ codex: fake, claude: fake }, rec);
		const result = await executeManifest(manifest, {
			inputs: { issue: "x" },
			adapters,
			invocationCwd: "/c",
			onTrace: (e) => rec.fromTrace(e),
		});
		rec.runCompleted(result.ok ? "ok" : "failed", 100);

		expect(result.ok).toBe(true);
		const events = store.readEvents("RUN");
		const types = events.map((e) => e.type);
		expect(types[0]).toBe("run.started");
		expect(types[types.length - 1]).toBe("run.completed");
		expect(types).toContain("step.started");
		expect(types).toContain("step.completed");
		// Each call step (diagnose, verify) produced a completed adapter call with usage.
		const calls = events.filter(
			(e): e is AdapterCallCompletedEvent => e.type === "adapter.call.completed",
		);
		expect(calls.length).toBeGreaterThanOrEqual(2);
		expect(calls.every((c) => c.usage?.inputTokens === 3 && c.status === "ok")).toBe(true);
		// Every adapter.call.started input blob is readable (the rendered prompt).
		for (const e of events) {
			if (e.type === "adapter.call.started")
				expect(store.readBlob("RUN", e.inputBlob).length).toBeGreaterThan(0);
		}
		// Every step.completed captures its output as a blob, INCLUDING the format
		// step ("out"), which has no adapter call - the full-replay guarantee.
		const stepDones = events.filter((e): e is StepCompletedEvent => e.type === "step.completed");
		expect(stepDones.every((s) => typeof s.outputBlob === "string")).toBe(true);
		const out = stepDones.find((s) => s.stepId === "out");
		expect(out).toBeDefined();
		expect(store.readBlob("RUN", out?.outputBlob ?? "").length).toBeGreaterThan(0);
		expect(rec.lastError).toBeUndefined();
	});
});

describe("AuditRecorder.prune", () => {
	test("keeps this run and removes a run a cap selects", () => {
		// An older run already in the store.
		store.appendEvent("OLD", {
			type: "run.started",
			runId: "OLD",
			ts: new Date(1_000_000).toISOString(),
			manifestId: "m",
			cwd: "/c",
			surface: "converge",
		});
		const rec = recorder("CUR");
		rec.runStarted();
		rec.runCompleted("ok", 5);
		rec.prune({ maxRuns: 1 }); // keep newest; keep:[CUR] also protects CUR
		expect(store.listRuns()).toEqual(["CUR"]);
		expect(rec.lastError).toBeUndefined();
	});

	test("is best-effort: a failing prune never throws and never sets lastError", () => {
		const brokenPrune = {
			prune() {
				throw new Error("prune boom");
			},
		} as unknown as AuditStore;
		const rec = new AuditRecorder(brokenPrune, "X", {
			manifestId: "m",
			cwd: "/c",
			surface: "converge",
		});
		expect(() => rec.prune()).not.toThrow();
		// lastError gates the run<->audit link; a retention failure must not touch it.
		expect(rec.lastError).toBeUndefined();
	});
});
