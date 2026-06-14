// Guarded real-Claude smoke. The suite is fake-backed by design (deterministic, free),
// so these tests hit the real `claude` CLI ONLY when CHIT_REAL_SMOKE=1. They guard the
// one thing fakes cannot: the adapter's filesystem->permission mapping must let a
// read-only routine INSPECT and return useful output. (Regression: read-only once mapped
// to `--permission-mode plan`, which under `-p` can route the answer through ExitPlanMode
// and return 0 chars -- a real composed flow's planning step produced empty output that
// way, which then failed the downstream step's required input.)
//
// Run from the repo root, where chit.config.json + examples/ live:
//   CHIT_REAL_SMOKE=1 bun test src/real-smoke.test.ts

import { describe, expect, test } from "bun:test";
import { claudeCliAdapter } from "./adapter.ts";
import { loadConfig } from "./config.ts";
import { resolveRoutine } from "./routine.ts";
import { type RunDeps, runOneShot } from "./run.ts";

const REAL = process.env.CHIT_REAL_SMOKE === "1";
const CWD = process.cwd();

function realDeps(): RunDeps {
	return { adapter: claudeCliAdapter, cwd: CWD, now: () => Date.now(), newRunId: () => "smoke" };
}

(REAL ? describe : describe.skip)("real-claude smoke: read-only routines return output", () => {
	test(
		"feature-griller returns non-empty output",
		async () => {
			const routine = resolveRoutine(loadConfig(CWD), "feature-griller", CWD);
			const r = await runOneShot(routine, { idea: "add a dark mode toggle" }, realDeps());
			expect(r.status).toBe("completed");
			expect((r.output ?? "").length).toBeGreaterThan(50);
		},
		180_000,
	);

	test(
		"planning returns non-empty output",
		async () => {
			const routine = resolveRoutine(loadConfig(CWD), "planning", CWD);
			const r = await runOneShot(routine, { goal: "add a dark mode toggle" }, realDeps());
			expect(r.status).toBe("completed");
			expect((r.output ?? "").length).toBeGreaterThan(50);
		},
		180_000,
	);
});
