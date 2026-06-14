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

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { claudeCliAdapter, dispatchingAdapter } from "./adapter.ts";
import { argvCheckRunner } from "./check-runner.ts";
import { loadConfig } from "./config.ts";
import { runConvergeInSandbox } from "./converge-run.ts";
import { parseManifest } from "./manifest.ts";
import { type ResolvedRoutine, resolveRoutine } from "./routine.ts";
import { type RunDeps, runOneShot } from "./run.ts";
import { gitWorktreeSandboxFactory } from "./sandbox.ts";

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
		600_000,
	);

	test(
		"planning returns non-empty output",
		async () => {
			const routine = resolveRoutine(loadConfig(CWD), "planning", CWD);
			const r = await runOneShot(routine, { goal: "add a dark mode toggle" }, realDeps());
			expect(r.status).toBe("completed");
			expect((r.output ?? "").length).toBeGreaterThan(50);
		},
		600_000,
	);
});

(REAL ? describe : describe.skip)("real-claude smoke: configurable agents", () => {
	test(
		"two claude profiles with different MODELS back different steps; the receipt records each binding; builder edits only the sandbox",
		async () => {
			const repo = mkdtempSync(join(tmpdir(), "chit-agents-"));
			try {
				const sh = (c: string) => Bun.spawnSync(["sh", "-c", c], { cwd: repo });
				sh("git init -q && git config user.email t@t.co && git config user.name t");
				writeFileSync(join(repo, "note.md"), "draft\n");
				sh("git add -A && git commit -q -m init");

				const manifest = parseManifest(
					{
						id: "two-agents",
						inputs: {},
						participants: {
							builder: { agent: "builder", instructions: "Append one short line to note.md and nothing else.", filesystem: "read-write" },
							critic: { agent: "critic", instructions: "You only read and comment. Do NOT edit any file.", filesystem: "read-only" },
						},
						steps: [
							{ id: "build", call: "builder", prompt: "Append a single line to note.md." },
							{ id: "review", call: "critic", prompt: "Review the diff:\n{{ diff }}\nReply with OK." },
							{ id: "verify", check: [{ command: "sh", args: ["-c", "true"] }] },
						],
						repeat: { until: "checks-pass", maxIterations: 1 },
					},
					"two-agents",
				);
				const agents = { builder: { adapter: "claude", model: "sonnet" }, critic: { adapter: "claude", model: "haiku" } };
				const routine: ResolvedRoutine = { id: "two-agents", manifestPath: "m.json", manifestAbs: "/m.json", manifest, digest: "sha256:x", agents };
				const adapter = dispatchingAdapter(agents, { claude: claudeCliAdapter });
				const res = await runConvergeInSandbox(routine, {}, {
					sandboxFactory: gitWorktreeSandboxFactory,
					adapter,
					checkRunner: argvCheckRunner,
					cwd: repo,
					now: () => Date.now(),
					newRunId: () => "agent-smoke",
					apply: false,
				});
				expect(res.receipt.status).toBe("converged");
				const steps = res.receipt.iterations[0]?.steps ?? [];
				expect(steps.find((s) => s.id === "build")).toMatchObject({ agent: "builder", adapter: "claude", model: "sonnet" });
				expect(steps.find((s) => s.id === "review")).toMatchObject({ agent: "critic", adapter: "claude", model: "haiku" });
				expect(readFileSync(join(repo, "note.md"), "utf-8")).toBe("draft\n"); // dry run: builder edited only the sandbox
			} finally {
				rmSync(repo, { recursive: true, force: true });
			}
		},
		600_000,
	);
});

(REAL ? describe : describe.skip)("real-claude smoke: read-only is actually read-only", () => {
	test(
		"a read-only call cannot create a file, not even via the shell",
		async () => {
			const cwd = mkdtempSync(join(tmpdir(), "chit-ro-smoke-"));
			try {
				await claudeCliAdapter.call({
					agent: "claude",
					instructions: "You may inspect the cwd, but you must not modify anything.",
					prompt: "Create a file named created.txt in your current directory containing the word HELLO.",
					filesystem: "read-only",
					cwd,
				});
				expect(existsSync(join(cwd, "created.txt"))).toBe(false);
			} finally {
				rmSync(cwd, { recursive: true, force: true });
			}
		},
		600_000,
	);
});
