import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import type { RunReceipt } from "./run.ts";
import { loadReceipt, saveReceipt } from "./store.ts";

const dir = mkdtempSync(join(tmpdir(), "chit-min-store-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const receipt: RunReceipt = {
	runId: "r1",
	routineId: "griller",
	policy: "one-shot",
	digest: "sha256:abc",
	inputs: { idea: "dark mode" },
	startedAt: 1,
	finishedAt: 5,
	elapsedMs: 4,
	status: "completed",
	steps: [{ id: "out", kind: "format", status: "ok", startedAt: 1, elapsedMs: 1 }],
	output: "the report",
};

describe("receipt store", () => {
	test("saves and loads a receipt round-trip", () => {
		const path = saveReceipt(dir, receipt);
		expect(path).toContain("r1.json");
		expect(loadReceipt(dir, "r1")).toEqual(receipt);
	});

	test("loading an unknown run throws a helpful error", () => {
		expect(() => loadReceipt(dir, "ghost")).toThrow(/no run "ghost" found/);
	});
});
