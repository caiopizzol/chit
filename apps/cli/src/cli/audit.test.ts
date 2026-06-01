import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditStore } from "../audit/store.ts";
import { type AuditIO, runAudit } from "./audit.ts";

let dir: string;
let store: AuditStore;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "chit-audit-cli-"));
	store = new AuditStore(dir);
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function capture(): { io: AuditIO; out: () => string; err: () => string } {
	let out = "";
	let err = "";
	return { io: { out: (s) => (out += s), err: (s) => (err += s) }, out: () => out, err: () => err };
}

// A complete converge-style run with one call step + usage.
function seedComplete(runId: string, ts: string): void {
	store.appendEvent(runId, {
		type: "run.started",
		runId,
		ts: `${ts}T10:00:00.000Z`,
		manifestId: "m",
		cwd: "/c",
		surface: "converge",
		scope: "s",
	});
	const inBlob = store.writeBlob(runId, "THE PROMPT");
	store.appendEvent(runId, {
		type: "adapter.call.started",
		runId,
		ts: `${ts}T10:00:01.000Z`,
		stepId: "a",
		participantId: "p",
		agentId: "ag",
		cwd: "/c",
		inputBlob: inBlob,
	});
	const outBlob = store.writeBlob(runId, "THE OUTPUT");
	store.appendEvent(runId, {
		type: "adapter.call.completed",
		runId,
		ts: `${ts}T10:00:10.000Z`,
		stepId: "a",
		outputBlob: outBlob,
		durationMs: 100,
		status: "ok",
		usage: { inputTokens: 10, outputTokens: 2, estimatedCostUsd: 0.05 },
	});
	store.appendEvent(runId, {
		type: "step.completed",
		runId,
		ts: `${ts}T10:00:11.000Z`,
		stepId: "a",
		durationMs: 120,
		outputBlob: outBlob,
	});
	store.appendEvent(runId, {
		type: "run.completed",
		runId,
		ts: `${ts}T10:00:12.000Z`,
		status: "ok",
		durationMs: 2000,
	});
}

// An incomplete run: a failed step and NO run.completed.
function seedIncomplete(runId: string, ts: string): void {
	store.appendEvent(runId, {
		type: "run.started",
		runId,
		ts: `${ts}T10:00:00.000Z`,
		manifestId: "m2",
		cwd: "/c",
		surface: "mcp",
	});
	store.appendEvent(runId, {
		type: "step.failed",
		runId,
		ts: `${ts}T10:00:05.000Z`,
		stepId: "a",
		error: "boom",
		durationMs: 50,
	});
}

// An incomplete run killed WHILE a call was in flight: adapter.call.started with
// no matching adapter.call.completed (the wedge/kill case the 78bebdfe run hit).
function seedOpenCall(runId: string, ts: string): void {
	store.appendEvent(runId, {
		type: "run.started",
		runId,
		ts: `${ts}T10:00:00.000Z`,
		manifestId: "m3",
		cwd: "/c",
		surface: "converge",
		loopId: "L",
		iteration: 1,
	});
	const inBlob = store.writeBlob(runId, "REVIEW PROMPT");
	store.appendEvent(runId, {
		type: "adapter.call.started",
		runId,
		ts: `${ts}T10:00:01.500Z`,
		stepId: "review",
		participantId: "reviewer",
		agentId: "codex",
		cwd: "/c",
		inputBlob: inBlob,
	});
}

// An incomplete run abandoned with no failed step and no open call: just
// run.started, then nothing terminal.
function seedAbandoned(runId: string, ts: string): void {
	store.appendEvent(runId, {
		type: "run.started",
		runId,
		ts: `${ts}T10:00:00.000Z`,
		manifestId: "m4",
		cwd: "/c",
		surface: "mcp",
	});
}

describe("chit audit list", () => {
	test("reports no runs for an empty store", () => {
		const c = capture();
		expect(runAudit(["list"], c.io, store)).toBe(0);
		expect(c.out()).toMatch(/no audit runs/);
	});

	test("lists runs newest-first and labels an incomplete run", () => {
		seedComplete("R1", "2026-05-29");
		seedIncomplete("R2", "2026-05-30"); // newer
		const c = capture();
		expect(runAudit(["list"], c.io, store)).toBe(0);
		const out = c.out();
		expect(out.indexOf("R2")).toBeLessThan(out.indexOf("R1")); // newest first
		expect(out).toMatch(/R2.*incomplete/s);
		expect(out).toMatch(/R1.*ok/s);
		expect(out).toMatch(/reported cost: \$0\.0500/);
	});

	test("names an open call inline so it is diagnosable without a show", () => {
		seedOpenCall("R3", "2026-05-30");
		const c = capture();
		expect(runAudit(["list"], c.io, store)).toBe(0);
		expect(c.out()).toMatch(/R3.*incomplete open=review\/codex/s);
	});

	test("--json emits the run summaries", () => {
		seedComplete("R1", "2026-05-29");
		seedOpenCall("R3", "2026-05-30");
		const c = capture();
		runAudit(["list", "--json"], c.io, store);
		const parsed = JSON.parse(c.out());
		expect(parsed).toHaveLength(2);
		const complete = parsed.find((p: { runId: string }) => p.runId === "R1");
		const open = parsed.find((p: { runId: string }) => p.runId === "R3");
		expect(complete).toMatchObject({ runId: "R1", surface: "converge", status: "ok" });
		expect(complete.openCall).toBeUndefined();
		expect(open.openCall).toMatchObject({ stepId: "review", agentId: "codex" });
	});
});

describe("chit audit show", () => {
	test("renders the header, status, usage, and timeline", () => {
		seedComplete("R1", "2026-05-29");
		const c = capture();
		expect(runAudit(["show", "R1"], c.io, store)).toBe(0);
		const out = c.out();
		expect(out).toMatch(/run R1/);
		expect(out).toMatch(/manifest: m/);
		expect(out).toMatch(/status: ok/);
		expect(out).toMatch(/reported cost: \$0\.0500/);
		expect(out).toMatch(/run\.started/);
		expect(out).toMatch(/adapter\.call\.completed\s+a ok 100ms/);
		expect(out).toMatch(/run\.completed\s+ok 2000ms/);
		// Without --blobs, bodies are not printed.
		expect(out).not.toContain("THE PROMPT");
	});

	test("a failed-step incomplete run names the failed step", () => {
		seedIncomplete("R2", "2026-05-30");
		const c = capture();
		runAudit(["show", "R2"], c.io, store);
		expect(c.out()).toMatch(/status: incomplete \(failed step: a: boom\)/);
		expect(c.out()).toMatch(/step\.failed\s+a 50ms\s+boom/);
	});

	test("an open-call incomplete run names the open call, agent, and start time", () => {
		seedOpenCall("R3", "2026-05-30");
		const c = capture();
		runAudit(["show", "R3"], c.io, store);
		expect(c.out()).toMatch(
			/status: incomplete \(open call: review reviewer\/codex since 2026-05-30T10:00:01\.500Z; no adapter\.call\.completed\)/,
		);
	});

	test("an abandoned incomplete run (no open call, no failed step) says so", () => {
		seedAbandoned("R4", "2026-05-30");
		const c = capture();
		runAudit(["show", "R4"], c.io, store);
		expect(c.out()).toMatch(/status: incomplete \(abandoned before terminal run\.completed\)/);
	});

	test("a cancelled call that recorded completed is a failed step, not an open call", () => {
		// The MCP cancel path records adapter.call.completed (status cancelled) AND
		// step.failed, so the call is matched. That is a failed step, distinct from a
		// call killed mid-flight (started, never completed).
		store.appendEvent("R5", {
			type: "run.started",
			runId: "R5",
			ts: "2026-05-30T10:00:00.000Z",
			manifestId: "m",
			cwd: "/c",
			surface: "mcp",
		});
		const inBlob = store.writeBlob("R5", "P");
		store.appendEvent("R5", {
			type: "adapter.call.started",
			runId: "R5",
			ts: "2026-05-30T10:00:01.000Z",
			stepId: "x",
			participantId: "p",
			agentId: "ag",
			cwd: "/c",
			inputBlob: inBlob,
		});
		const outBlob = store.writeBlob("R5", "aborted by client");
		store.appendEvent("R5", {
			type: "adapter.call.completed",
			runId: "R5",
			ts: "2026-05-30T10:00:02.000Z",
			stepId: "x",
			outputBlob: outBlob,
			durationMs: 1000,
			status: "cancelled",
		});
		store.appendEvent("R5", {
			type: "step.failed",
			runId: "R5",
			ts: "2026-05-30T10:00:02.100Z",
			stepId: "x",
			error: "aborted by client",
			durationMs: 1000,
		});
		const c = capture();
		runAudit(["show", "R5"], c.io, store);
		expect(c.out()).toMatch(/status: incomplete \(failed step: x: aborted by client\)/);
		expect(c.out()).not.toContain("open call");
	});

	test("--blobs prints the prompt and output bodies", () => {
		seedComplete("R1", "2026-05-29");
		const c = capture();
		runAudit(["show", "R1", "--blobs"], c.io, store);
		expect(c.out()).toContain("THE PROMPT");
		expect(c.out()).toContain("THE OUTPUT");
	});

	function seedWithEvent(): void {
		const raw = '{"type":"item.completed","item":{"type":"command_execution"}}';
		store.appendEvent("EV1", {
			type: "run.started",
			runId: "EV1",
			ts: "2026-05-31T10:00:00.000Z",
			manifestId: "m",
			cwd: "/c",
			surface: "converge",
		});
		const rawBlob = store.writeBlob("EV1", raw);
		store.appendEvent("EV1", {
			type: "adapter.event",
			runId: "EV1",
			ts: "2026-05-31T10:00:01.000Z",
			stepId: "a",
			eventType: "item.completed",
			rawBlob,
		});
		store.appendEvent("EV1", {
			type: "run.completed",
			runId: "EV1",
			ts: "2026-05-31T10:00:02.000Z",
			status: "ok",
			durationMs: 10,
		});
	}

	test("default receipt hides adapter.event rows and notes the count", () => {
		seedWithEvent();
		const c = capture();
		runAudit(["show", "EV1"], c.io, store);
		expect(c.out()).not.toContain("adapter.event");
		expect(c.out()).toMatch(/1 raw adapter events hidden; pass --verbose/);
	});

	test("--verbose --blobs renders a preserved adapter.event and its raw body", () => {
		seedWithEvent();
		const c = capture();
		runAudit(["show", "EV1", "--verbose", "--blobs"], c.io, store);
		expect(c.out()).toMatch(/adapter\.event\s+a item\.completed/);
		expect(c.out()).toContain("command_execution"); // raw body printed
		expect(c.out()).not.toContain("hidden"); // no note under --verbose
	});

	test("--json emits the raw events", () => {
		seedComplete("R1", "2026-05-29");
		const c = capture();
		runAudit(["show", "R1", "--json"], c.io, store);
		const parsed = JSON.parse(c.out());
		expect(Array.isArray(parsed)).toBe(true);
		expect(parsed[0]).toMatchObject({ type: "run.started", runId: "R1" });
	});

	test("a missing run reports a clean error and exit 1", () => {
		const c = capture();
		expect(runAudit(["show", "ghost"], c.io, store)).toBe(1);
		expect(c.err()).toMatch(/chit audit:/);
	});
});

describe("chit audit arg parsing", () => {
	test("show without a runId is a usage error (exit 2)", () => {
		const c = capture();
		expect(runAudit(["show"], c.io, store)).toBe(2);
		expect(c.err()).toMatch(/requires a <runId>/);
	});

	test("an unknown subcommand is a usage error (exit 2)", () => {
		const c = capture();
		expect(runAudit(["bogus"], c.io, store)).toBe(2);
		expect(c.err()).toMatch(/unknown audit command/);
	});

	test("no args prints help and exits 2", () => {
		const c = capture();
		expect(runAudit([], c.io, store)).toBe(2);
		expect(c.out()).toMatch(/chit audit <command>/);
	});
});

describe("chit audit show: recorded participant config", () => {
	test("renders the config snapshot recorded at run start", () => {
		store.appendEvent("RC", {
			type: "run.started",
			runId: "RC",
			ts: "2026-05-31T10:00:00.000Z",
			manifestId: "m",
			cwd: "/c",
			surface: "converge",
			participants: {
				reviewer: {
					agentId: "codex-deep",
					adapter: "codex-exec",
					session: "per_scope",
					permissions: { filesystem: "read_only" },
					enforcesReadOnly: true,
					config: { model: "gpt-5.5", reasoningEffort: "xhigh" },
				},
			},
		});
		const c = capture();
		runAudit(["show", "RC"], c.io, store);
		expect(c.out()).toMatch(/participants \(recorded config\):/);
		expect(c.out()).toMatch(/reviewer\s+agent=codex-deep.*adapter=codex-exec/);
		expect(c.out()).toContain("model=gpt-5.5");
		expect(c.out()).toContain("effort=xhigh");
	});

	test("says recorded config is unavailable for a run without the snapshot", () => {
		// seedComplete's run.started predates the snapshot (no participants field).
		seedComplete("R1", "2026-05-29");
		const c = capture();
		runAudit(["show", "R1"], c.io, store);
		expect(c.out()).toContain("recorded config unavailable (older audit run)");
	});
});

describe("chit audit: only the configured store is read (no legacy fallback)", () => {
	function seedRun(s: AuditStore, runId: string, ts: string, manifestId: string): void {
		s.appendEvent(runId, {
			type: "run.started",
			runId,
			ts: `${ts}T10:00:00.000Z`,
			manifestId,
			cwd: "/c",
			surface: "cli",
		});
		s.appendEvent(runId, {
			type: "run.completed",
			runId,
			ts: `${ts}T10:00:01.000Z`,
			status: "ok",
			durationMs: 1000,
		});
	}

	test("list shows only runs in the given store", () => {
		seedRun(store, "NEW1", "2026-05-31", "m");
		const c = capture();
		runAudit(["list"], c.io, store);
		expect(c.out()).toContain("NEW1");
	});

	test("show reports not-found for a run absent from the store", () => {
		const c = capture();
		expect(runAudit(["show", "GONE"], c.io, store)).toBe(1);
		expect(c.err()).toContain("no audit log");
	});
});
