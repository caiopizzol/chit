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

	test("--json emits the run summaries", () => {
		seedComplete("R1", "2026-05-29");
		const c = capture();
		runAudit(["list", "--json"], c.io, store);
		const parsed = JSON.parse(c.out());
		expect(parsed).toHaveLength(1);
		expect(parsed[0]).toMatchObject({ runId: "R1", surface: "converge", status: "ok" });
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

	test("labels an incomplete run (no run.completed)", () => {
		seedIncomplete("R2", "2026-05-30");
		const c = capture();
		runAudit(["show", "R2"], c.io, store);
		expect(c.out()).toMatch(/status: incomplete \(no run\.completed/);
		expect(c.out()).toMatch(/step\.failed\s+a 50ms\s+boom/);
	});

	test("--blobs prints the prompt and output bodies", () => {
		seedComplete("R1", "2026-05-29");
		const c = capture();
		runAudit(["show", "R1", "--blobs"], c.io, store);
		expect(c.out()).toContain("THE PROMPT");
		expect(c.out()).toContain("THE OUTPUT");
	});

	test("renders a preserved adapter.event and its raw body with --blobs", () => {
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
		const c = capture();
		runAudit(["show", "EV1", "--blobs"], c.io, store);
		expect(c.out()).toMatch(/adapter\.event\s+a item\.completed/);
		expect(c.out()).toContain("command_execution"); // raw body printed
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
