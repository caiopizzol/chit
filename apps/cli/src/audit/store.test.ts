import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdapterCallCompletedEvent, AuditEvent, RunStartedEvent } from "@chit/core";
import { AuditStore, AuditStoreError, defaultAuditDir } from "./store.ts";

let baseDir: string;
let store: AuditStore;

beforeEach(() => {
	baseDir = mkdtempSync(join(tmpdir(), "chit-audit-"));
	store = new AuditStore(baseDir);
});
afterEach(() => {
	rmSync(baseDir, { recursive: true, force: true });
});

const runStarted = (runId: string): RunStartedEvent => ({
	type: "run.started",
	runId,
	ts: "2026-05-30T10:00:00.000Z",
	manifestId: "m-abc",
	cwd: "/abs/chit",
	surface: "converge",
});

const callCompleted = (runId: string, outputBlob: string): AdapterCallCompletedEvent => ({
	type: "adapter.call.completed",
	runId,
	ts: "2026-05-30T10:00:10.000Z",
	stepId: "s1",
	outputBlob,
	durationMs: 8000,
	status: "ok",
});

describe("audit store: blobs (content-addressed)", () => {
	test("writeBlob returns a sha256 hex ref and readBlob round-trips the body", () => {
		const body = "a full rendered prompt\nwith newlines";
		const ref = store.writeBlob("R1", body);
		expect(ref).toMatch(/^[0-9a-f]{64}$/);
		expect(store.readBlob("R1", ref)).toBe(body);
	});

	test("identical bodies share one blob (write-once)", () => {
		const ref1 = store.writeBlob("R1", "same body");
		const ref2 = store.writeBlob("R1", "same body");
		expect(ref2).toBe(ref1);
		const blobs = readdirSync(join(baseDir, "runs", "R1", "blobs"));
		expect(blobs).toEqual([ref1]);
	});

	test("different bodies get different refs", () => {
		expect(store.writeBlob("R1", "one")).not.toBe(store.writeBlob("R1", "two"));
	});

	test("writeBlob overwrites a stale/partial blob at the same content address", () => {
		const body = "the correct body";
		const ref = store.writeBlob("R1", body);
		// Simulate a truncated/garbage prior write left under the content address
		// (e.g. an interrupted process). A subsequent write of the real body must
		// restore correct content rather than trust the stale file.
		writeFileSync(join(baseDir, "runs", "R1", "blobs", ref), "partial garbage");
		expect(store.writeBlob("R1", body)).toBe(ref);
		expect(store.readBlob("R1", ref)).toBe(body);
	});

	test("a write leaves no leftover temp files under blobs/", () => {
		const ref = store.writeBlob("R1", "body");
		expect(readdirSync(join(baseDir, "runs", "R1", "blobs"))).toEqual([ref]);
	});

	test("blobs are per-run: a ref written under one run is not readable under another", () => {
		const ref = store.writeBlob("R1", "body");
		expect(() => store.readBlob("R2", ref)).toThrow(AuditStoreError);
	});

	test("readBlob rejects a non-hex / traversal ref before touching the filesystem", () => {
		expect(() => store.readBlob("R1", "../../etc/passwd")).toThrow(/invalid blob ref/);
		expect(() => store.readBlob("R1", "DEADBEEF")).toThrow(/invalid blob ref/);
		expect(() => store.readBlob("R1", "a".repeat(63))).toThrow(/invalid blob ref/);
	});

	test("readBlob throws cleanly for a well-formed but absent ref", () => {
		expect(() => store.readBlob("R1", "f".repeat(64))).toThrow(/no blob/);
	});
});

describe("audit store: events", () => {
	test("appendEvent + readEvents round-trips events in order", () => {
		const ref = store.writeBlob("R1", "output body");
		const events: AuditEvent[] = [runStarted("R1"), callCompleted("R1", ref)];
		for (const e of events) store.appendEvent("R1", e);
		expect(store.readEvents("R1")).toEqual(events);
	});

	test("appendEvent rejects an event whose runId does not match the run", () => {
		expect(() => store.appendEvent("R1", runStarted("R2"))).toThrow(/does not match run/);
	});

	test("appendEvent validates before any fs side effect: no file, no phantom run dir", () => {
		const bad = { ...runStarted("R1"), surface: "desktop" } as unknown as AuditEvent;
		expect(() => store.appendEvent("R1", bad)).toThrow();
		// Validation runs before mkdir, so neither the log nor the run dir exists.
		expect(() => store.readEvents("R1")).toThrow(/no audit log/);
		expect(store.listRuns()).toEqual([]);
	});

	test("readEvents throws cleanly for a run with no log", () => {
		expect(() => store.readEvents("R1")).toThrow(/no audit log/);
	});
});

describe("audit store: run ids and listing", () => {
	test("an unsafe runId is rejected on every path it would build", () => {
		expect(() => store.openRun("../escape")).toThrow(/invalid run id/);
		expect(() => store.writeBlob("..", "x")).toThrow(/invalid run id/);
		expect(() => store.appendEvent(".hidden", runStarted(".hidden"))).toThrow(/invalid run id/);
		expect(() => store.readEvents("")).toThrow(/invalid run id/);
	});

	test("listRuns is empty before anything is written and lists created runs", () => {
		expect(store.listRuns()).toEqual([]);
		store.appendEvent("R1", runStarted("R1"));
		store.openRun("R2");
		expect(store.listRuns().sort()).toEqual(["R1", "R2"]);
	});

	test("defaultAuditDir lands under handoff/audit (honoring XDG_STATE_HOME)", () => {
		const prev = process.env.XDG_STATE_HOME;
		process.env.XDG_STATE_HOME = "/tmp/xdg-test";
		try {
			expect(defaultAuditDir()).toBe("/tmp/xdg-test/handoff/audit");
		} finally {
			if (prev === undefined) delete process.env.XDG_STATE_HOME;
			else process.env.XDG_STATE_HOME = prev;
		}
	});
});
