import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type NormalizedRegistry, parseManifest } from "@chit-run/core";
import { AuditStore } from "../audit/store.ts";
import type { AdapterCallRequest, AdapterMap } from "../runtime/types.ts";
import { runManifestOnce } from "./run-once.ts";

// A minimal one-shot manifest: two parallel call steps + a format step, so a run
// exercises a real DAG. No declared policy -> one-shot (a single pass).
const MANIFEST = parseManifest({
	schema: 1,
	id: "echo-run",
	description: "echo run",
	inputs: { q: { type: "string" } },
	participants: { e: { agent: "echo", role: "echo back", session: "stateless" } },
	steps: {
		a: { call: "e", prompt: "{{ inputs.q }}" },
		b: { call: "e", prompt: "{{ inputs.q }}" },
		out: { format: "{{ steps.a.output }} | {{ steps.b.output }}" },
	},
	output: "out",
});

// The registry is only consulted for participant snapshots (audit) and for
// building real adapters; tests inject adapters and tolerate empty config.
const REGISTRY = { agents: {} } as unknown as NormalizedRegistry;

// A fake adapter map so a run touches no real agents.
function echoAdapters(behavior?: (req: AdapterCallRequest) => string): AdapterMap {
	return {
		echo: {
			call: async (req: AdapterCallRequest) => ({
				output: behavior ? behavior(req) : `ran ${req.stepId}`,
			}),
		},
	} as unknown as AdapterMap;
}

let stateDir: string;
let savedXdg: string | undefined;

beforeEach(() => {
	stateDir = mkdtempSync(join(tmpdir(), "chit-runonce-"));
	savedXdg = process.env.XDG_STATE_HOME;
	process.env.XDG_STATE_HOME = stateDir;
});
afterEach(() => {
	if (savedXdg === undefined) delete process.env.XDG_STATE_HOME;
	else process.env.XDG_STATE_HOME = savedXdg;
	rmSync(stateDir, { recursive: true, force: true });
});

describe("runManifestOnce", () => {
	test("runs the whole DAG once and returns the output (no audit)", async () => {
		const r = await runManifestOnce(MANIFEST, {
			inputs: { q: "hi" },
			registry: REGISTRY,
			invocationCwd: "/tmp/x",
			surface: "mcp",
			adapters: echoAdapters(),
		});
		expect(r.ok).toBe(true);
		expect(r.output).toBe("ran a | ran b");
		expect(r.auditRunId).toBeUndefined(); // audit was off
	});

	test("audited run records a transcript and returns its run id", async () => {
		const auditStore = new AuditStore(join(stateDir, "audit"));
		const r = await runManifestOnce(MANIFEST, {
			inputs: { q: "hi" },
			registry: REGISTRY,
			invocationCwd: "/tmp/x",
			surface: "mcp",
			audit: true,
			adapters: echoAdapters(),
			auditStore,
		});
		expect(r.ok).toBe(true);
		expect(r.auditRunId).toBeDefined();
		// The run is in the store (the audit ref points at a real, readable run).
		expect(auditStore.listRuns()).toContain(r.auditRunId as string);
	});

	test("a failing step yields ok:false with the failed step id", async () => {
		const r = await runManifestOnce(MANIFEST, {
			inputs: { q: "hi" },
			registry: REGISTRY,
			invocationCwd: "/tmp/x",
			surface: "mcp",
			adapters: {
				echo: {
					call: async () => {
						throw new Error("boom");
					},
				},
			} as unknown as AdapterMap,
		});
		expect(r.ok).toBe(false);
		// One of the two parallel call steps failed first.
		expect(r.failedStep === "a" || r.failedStep === "b").toBe(true);
		expect(r.error).toContain("boom");
	});

	test("does not loop: a one-shot run is a single pass (output is the format step)", async () => {
		let calls = 0;
		const r = await runManifestOnce(MANIFEST, {
			inputs: { q: "hi" },
			registry: REGISTRY,
			invocationCwd: "/tmp/x",
			surface: "mcp",
			adapters: echoAdapters((req) => {
				calls++;
				return `ran ${req.stepId}`;
			}),
		});
		expect(r.ok).toBe(true);
		// Exactly the two call steps ran once each (the format step makes no call).
		expect(calls).toBe(2);
	});
});
