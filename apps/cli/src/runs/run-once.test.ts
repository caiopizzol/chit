import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type NormalizedRegistry, parseManifest } from "@chit-run/core";
import { AuditStore } from "../audit/store.ts";
import type { AdapterCallRequest, AdapterMap } from "../runtime/types.ts";
import { runManifestOnce, validateOneShotAuth } from "./run-once.ts";

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

describe("validateOneShotAuth", () => {
	// A registry where the manifest's agent resolves (echo present). The empty
	// REGISTRY above makes every agent unknown, which is the rejection case.
	const KNOWN = { agents: { echo: {} } } as unknown as NormalizedRegistry;
	const SCOPED = parseManifest({
		schema: 1,
		id: "scoped-run",
		description: "scoped run",
		inputs: { q: { type: "string" } },
		participants: { e: { agent: "echo", role: "echo back", session: "per_scope" } },
		steps: { a: { call: "e", prompt: "{{ inputs.q }}" } },
		output: "a",
	});

	test("rejects an unknown agent", () => {
		const r = validateOneShotAuth(MANIFEST, REGISTRY, { allowUnenforced: false });
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toContain("unknown agent");
	});

	test("refuses an unenforceable permission unless allowed, then warns", () => {
		// The fake echo agent has no enforcing adapter, so the manifest's default
		// read_only filesystem permission is an enforcement gap.
		const refused = validateOneShotAuth(MANIFEST, KNOWN, { allowUnenforced: false });
		expect(refused.ok).toBe(false);
		if (!refused.ok) expect(refused.error).toContain("cannot enforce");
		const allowed = validateOneShotAuth(MANIFEST, KNOWN, { allowUnenforced: true });
		expect(allowed.ok).toBe(true);
		if (allowed.ok) expect(allowed.warnings.length).toBeGreaterThan(0);
	});

	test("a per_scope manifest requires a scope", () => {
		// allowUnenforced so the enforcement gap does not mask the scope check.
		expect(validateOneShotAuth(SCOPED, KNOWN, { allowUnenforced: true }).ok).toBe(false);
		expect(validateOneShotAuth(SCOPED, KNOWN, { scope: "s", allowUnenforced: true }).ok).toBe(true);
	});
});
