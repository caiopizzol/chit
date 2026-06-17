// Guarded real-Claude smoke. The suite is fake-backed by design (deterministic, free),
// so these tests hit the real `claude` CLI ONLY when CHIT_REAL_SMOKE=1. They guard the
// one thing fakes cannot: the adapter's filesystem->permission mapping must let a
// read-only routine INSPECT and return useful output. (Regression: read-only once mapped
// to `--permission-mode plan`, which under `-p` can route the answer through ExitPlanMode
// and return 0 chars -- a real composed flow's planning step produced empty output that
// way, which then failed the downstream step's required input.)
//
// Run with:
//   CHIT_REAL_SMOKE=1 bun test src/real-smoke.test.ts

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeCliAdapter, codexCliAdapter, dispatchingAdapter, geminiCliAdapter } from "./adapter.ts";
import { argvCheckRunner } from "./check-runner.ts";
import { parseConfig } from "./config.ts";
import { runConvergeInSandbox } from "./converge-run.ts";
import { parseManifest } from "./manifest.ts";
import { type ResolvedRoutine, resolveRoutine } from "./routine.ts";
import { type RunDeps, runOneShot } from "./run.ts";
import { gitWorktreeSandboxFactory } from "./sandbox.ts";

const REAL = process.env.CHIT_REAL_SMOKE === "1";
const CWD = join(import.meta.dir, "..");
const EXAMPLE_CONFIG = parseConfig(
	JSON.parse(readFileSync(join(CWD, "examples/chit.config.json"), "utf-8")),
	"examples/chit.config.json",
);

function realDeps(): RunDeps {
	return { adapter: claudeCliAdapter, cwd: CWD, now: () => Date.now(), newRunId: () => "smoke" };
}

(REAL ? describe : describe.skip)("real-claude smoke: read-only routines return output", () => {
	test("investigate returns non-empty output", async () => {
		const routine = resolveRoutine(EXAMPLE_CONFIG, "investigate", CWD);
		const r = await runOneShot(routine, { bug: "dark mode toggle fails to persist" }, realDeps());
		expect(r.status).toBe("completed");
		expect((r.output ?? "").length).toBeGreaterThan(50);
	}, 600_000);

	test("plan returns non-empty output", async () => {
		const routine = resolveRoutine(EXAMPLE_CONFIG, "plan", CWD);
		const r = await runOneShot(routine, { task: "add a dark mode toggle" }, realDeps());
		expect(r.status).toBe("completed");
		expect((r.output ?? "").length).toBeGreaterThan(50);
	}, 600_000);
});

(REAL ? describe : describe.skip)("real-claude smoke: configurable agents", () => {
	test("two claude profiles with different MODELS back different steps; the receipt records each binding; builder edits only the sandbox", async () => {
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
					agents: {
						builder: {
							profile: "builder",
							instructions: "Append one short line to note.md and nothing else.",
							filesystem: "read-write",
						},
						critic: {
							profile: "critic",
							instructions: "You only read and comment. Do NOT edit any file.",
							filesystem: "read-only",
						},
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
			const routine: ResolvedRoutine = {
				id: "two-agents",
				manifestPath: "m.json",
				manifestAbs: "/m.json",
				manifest,
				digest: "sha256:x",
				agents,
			};
			const adapter = dispatchingAdapter(agents, { claude: claudeCliAdapter });
			const res = await runConvergeInSandbox(
				routine,
				{},
				{
					sandboxFactory: gitWorktreeSandboxFactory,
					adapter,
					checkRunner: argvCheckRunner,
					cwd: repo,
					now: () => Date.now(),
					newRunId: () => "agent-smoke",
					apply: false,
				},
			);
			expect(res.receipt.status).toBe("converged");
			const steps = res.receipt.iterations[0]?.steps ?? [];
			expect(steps.find((s) => s.id === "build")).toMatchObject({
				agent: "builder",
				adapter: "claude",
				model: "sonnet",
			});
			expect(steps.find((s) => s.id === "review")).toMatchObject({
				agent: "critic",
				adapter: "claude",
				model: "haiku",
			});
			expect(readFileSync(join(repo, "note.md"), "utf-8")).toBe("draft\n"); // dry run: builder edited only the sandbox
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	}, 600_000);
});

(REAL ? describe : describe.skip)("real second adapter: gemini", () => {
	test("a gemini read-only call cannot create a file", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "chit-gemini-ro-"));
		try {
			await geminiCliAdapter.call({
				agent: "critic",
				instructions: "You may inspect the cwd, but you must not modify anything.",
				prompt: "Create a file named created.txt in your current directory containing the word HELLO.",
				filesystem: "read-only",
				cwd,
			});
			expect(existsSync(join(cwd, "created.txt"))).toBe(false);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	}, 600_000);

	test("builder on claude (read-write, sandboxed) + critic on gemini (read-only); trace shows both bindings", async () => {
		const repo = mkdtempSync(join(tmpdir(), "chit-mixed-"));
		try {
			const sh = (c: string) => Bun.spawnSync(["sh", "-c", c], { cwd: repo });
			sh("git init -q && git config user.email t@t.co && git config user.name t");
			writeFileSync(join(repo, "note.md"), "draft\n");
			sh("git add -A && git commit -q -m init");

			const manifest = parseManifest(
				{
					id: "mixed",
					inputs: {},
					agents: {
						builder: {
							profile: "builder",
							instructions: "Append one short line to note.md and nothing else.",
							filesystem: "read-write",
						},
						critic: {
							profile: "critic",
							instructions: "You only read and comment. Do NOT edit any file.",
							filesystem: "read-only",
						},
					},
					steps: [
						{ id: "build", call: "builder", prompt: "Append a single line to note.md." },
						{ id: "review", call: "critic", prompt: "Review the diff:\n{{ diff }}\nReply with OK." },
						{ id: "verify", check: [{ command: "sh", args: ["-c", "true"] }] },
					],
					repeat: { until: "checks-pass", maxIterations: 1 },
				},
				"mixed",
			);
			// builder -> claude (read-write), critic -> gemini (read-only): two real backends
			const agents = { builder: { adapter: "claude" }, critic: { adapter: "gemini" } };
			const routine: ResolvedRoutine = {
				id: "mixed",
				manifestPath: "m.json",
				manifestAbs: "/m.json",
				manifest,
				digest: "sha256:x",
				agents,
			};
			const adapter = dispatchingAdapter(agents, { claude: claudeCliAdapter, gemini: geminiCliAdapter });
			const res = await runConvergeInSandbox(
				routine,
				{},
				{
					sandboxFactory: gitWorktreeSandboxFactory,
					adapter,
					checkRunner: argvCheckRunner,
					cwd: repo,
					now: () => Date.now(),
					newRunId: () => "mixed-smoke",
					apply: false,
				},
			);
			expect(res.receipt.status).toBe("converged");
			const steps = res.receipt.iterations[0]?.steps ?? [];
			expect(steps.find((s) => s.id === "build")).toMatchObject({ agent: "builder", adapter: "claude" });
			expect(steps.find((s) => s.id === "review")).toMatchObject({ agent: "critic", adapter: "gemini" });
			expect(readFileSync(join(repo, "note.md"), "utf-8")).toBe("draft\n"); // dry run: origin untouched
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	}, 600_000);
});

(REAL ? describe : describe.skip)("real-claude smoke: read-only is actually read-only", () => {
	test("a read-only call cannot create a file, not even via the shell", async () => {
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
	}, 600_000);
});

// Codex input-validation that needs no model (always runs): `none` has no codex mapping.
describe("codex adapter: filesystem none is rejected (no real call)", () => {
	test("rejects a `none` agent before spawning anything", async () => {
		await expect(
			codexCliAdapter.call({ agent: "x", instructions: "i", prompt: "p", filesystem: "none", cwd: tmpdir() }),
		).rejects.toThrow(/no no-tools mode/);
	});
});

// The reviewer's verification gate for the third adapter, against the real `codex` CLI.
(REAL ? describe : describe.skip)("real third adapter: codex", () => {
	test("a read-only call returns text", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "chit-codex-ro-"));
		try {
			const r = await codexCliAdapter.call({
				agent: "x",
				instructions: "You answer concisely.",
				prompt: "Reply with exactly the word BANANA and nothing else.",
				filesystem: "read-only",
				cwd,
			});
			expect(r.output.length).toBeGreaterThan(0);
			expect(r.output).toContain("BANANA");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	}, 600_000);

	test("a read-only call cannot create a file", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "chit-codex-ro2-"));
		try {
			await codexCliAdapter.call({
				agent: "x",
				instructions: "You may inspect the cwd, but you must not modify anything.",
				prompt: "Create a file named created.txt containing the word HELLO in your current directory.",
				filesystem: "read-only",
				cwd,
			});
			expect(existsSync(join(cwd, "created.txt"))).toBe(false);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	}, 600_000);

	test("a workspace-write call can create a file in a git repo", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "chit-codex-rw-"));
		try {
			const sh = (c: string) => Bun.spawnSync(["sh", "-c", c], { cwd });
			sh("git init -q && git config user.email t@t.co && git config user.name t");
			await codexCliAdapter.call({
				agent: "builder",
				instructions: "You implement small, well-scoped changes.",
				prompt: "Create a file named created.txt containing exactly the word HELLO.",
				filesystem: "read-write",
				cwd,
			});
			expect(existsSync(join(cwd, "created.txt"))).toBe(true);
			expect(readFileSync(join(cwd, "created.txt"), "utf-8")).toContain("HELLO");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	}, 600_000);

	test("a sandboxed chit run with a codex builder produces a diff, dry-run discards it, and the receipt records adapter:codex", async () => {
		const repo = mkdtempSync(join(tmpdir(), "chit-codex-sandbox-"));
		try {
			const sh = (c: string) => Bun.spawnSync(["sh", "-c", c], { cwd: repo });
			sh("git init -q && git config user.email t@t.co && git config user.name t");
			writeFileSync(join(repo, "note.md"), "draft\n");
			sh("git add -A && git commit -q -m init");

			const manifest = parseManifest(
				{
					id: "codex-build",
					inputs: {},
					agents: {
						builder: {
							profile: "builder",
							instructions: "Append one short line to note.md and nothing else.",
							filesystem: "read-write",
						},
					},
					steps: [
						{ id: "build", call: "builder", prompt: "Append a single line to note.md." },
						{ id: "verify", check: [{ command: "sh", args: ["-c", "test -f note.md"] }] },
					],
					repeat: { until: "checks-pass", maxIterations: 1 },
				},
				"codex-build",
			);
			const agents = { builder: { adapter: "codex" } };
			const routine: ResolvedRoutine = {
				id: "codex-build",
				manifestPath: "m.json",
				manifestAbs: "/m.json",
				manifest,
				digest: "sha256:x",
				agents,
			};
			const adapter = dispatchingAdapter(agents, { codex: codexCliAdapter });
			const res = await runConvergeInSandbox(
				routine,
				{},
				{
					sandboxFactory: gitWorktreeSandboxFactory,
					adapter,
					checkRunner: argvCheckRunner,
					cwd: repo,
					now: () => Date.now(),
					newRunId: () => "codex-smoke",
					apply: false,
				},
			);
			expect(res.receipt.status).toBe("converged");
			expect(res.diff.length).toBeGreaterThan(0); // codex edited the sandbox -> a real diff
			expect(res.receipt.iterations[0]?.steps.find((s) => s.id === "build")).toMatchObject({
				agent: "builder",
				adapter: "codex",
			});
			expect(readFileSync(join(repo, "note.md"), "utf-8")).toBe("draft\n"); // dry run: origin untouched
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	}, 600_000);
});
