// The tests elsewhere call runCli(...) directly; these spawn the ACTUAL executable
// (`src/index.ts ...`) in a temp cwd and assert exit codes + output. That covers
// what only the process boundary can: argv parsing, process.exit codes, the bin's
// shebang, adapter-registry wiring, and the no-config / unknown-command paths an operator hits.
// The deterministic cases need no model; one guarded case runs a real routine.

import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BIN = join(import.meta.dir, "index.ts");
const REPO = join(import.meta.dir, "..");

const dirs: string[] = [];
function tmp(): string {
	const d = mkdtempSync(join(tmpdir(), "chit-cliproc-"));
	dirs.push(d);
	return d;
}
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function run(args: string[], cwd: string): { code: number | null; out: string; err: string } {
	const r = Bun.spawnSync([BIN, ...args], { cwd });
	return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

function exampleProject(): string {
	const cwd = tmp();
	cpSync(join(REPO, "examples"), join(cwd, "examples"), { recursive: true });
	cpSync(join(REPO, "examples/chit.config.json"), join(cwd, "chit.config.json"));
	return cwd;
}

describe("CLI process: the real binary (no model)", () => {
	test("init -> routines -> inspect end to end through the binary", () => {
		const cwd = tmp();
		let r = run(["init", "myrev"], cwd);
		expect(r.code).toBe(0);
		expect(r.out).toContain("created chit.config.json#routines.myrev");
		expect(existsSync(join(cwd, "chit.config.json"))).toBe(true);
		expect(existsSync(join(cwd, "examples/myrev.json"))).toBe(false);

		r = run(["routines"], cwd);
		expect(r.code).toBe(0);
		expect(r.out).toContain("myrev");

		r = run(["inspect", "myrev"], cwd);
		expect(r.code).toBe(0);
		expect(r.out).toContain("myrev");
		expect(r.out).toContain("claude -> claude"); // init registered the agent; the binding renders
	});

	test("no args prints usage with exit 0", () => {
		const r = run([], tmp());
		expect(r.code).toBe(0);
		expect(r.out).toMatch(/chit init|chit routines/);
	});

	test("an unknown command exits 2", () => {
		const r = run(["bogus"], tmp());
		expect(r.code).toBe(2);
		expect(r.err).toMatch(/unknown command/);
	});

	test("run on an unknown routine exits 1", () => {
		const cwd = tmp();
		run(["init", "x"], cwd); // create a valid config first
		const r = run(["run", "ghost"], cwd);
		expect(r.code).toBe(1);
		expect(r.err).toMatch(/unknown routine/);
	});

	test("run with no config exits 1 with a clear message", () => {
		const r = run(["run", "anything"], tmp());
		expect(r.code).toBe(1);
		expect(r.err).toMatch(/no config found/);
	});

	// The unit tests inject a fake askUser; only the real binary proves the stdin reader
	// (the bin's askOnStdin) is wired and feeds the answer forward. A model-less ask+format
	// routine keeps this deterministic -- no model needed.
	test("an ask step reads the operator's answer from stdin and feeds it forward", () => {
		const cwd = tmp();
		writeFileSync(
			join(cwd, "chit.config.json"),
			JSON.stringify({ routines: { echo: { file: "echo.json" } }, profiles: {} }),
		);
		writeFileSync(
			join(cwd, "echo.json"),
			JSON.stringify({
				id: "echo",
				inputs: {},
				steps: [
					{ id: "name", ask: "Who are you?" },
					{ id: "out", format: "hello {{ steps.name.output }}" },
				],
				output: "out",
			}),
		);
		const r = Bun.spawnSync([BIN, "run", "echo"], { cwd, stdin: Buffer.from("Ada\n") });
		expect(r.exitCode).toBe(0);
		expect(r.stdout.toString()).toContain("hello Ada"); // the typed answer flowed into the format step
	});

	test("a background run can be waited on through the real binary", () => {
		const cwd = tmp();
		writeFileSync(
			join(cwd, "chit.config.json"),
			JSON.stringify({ routines: { echo: { file: "echo.json" } }, profiles: {} }),
		);
		writeFileSync(
			join(cwd, "echo.json"),
			JSON.stringify({
				id: "echo",
				inputs: { name: { type: "string" } },
				steps: [{ id: "out", format: "hello {{ inputs.name }}" }],
				output: "out",
			}),
		);

		const bg = run(["run", "echo", "--input", "name=Ada", "--background"], cwd);
		expect(bg.code).toBe(0);
		const runId = bg.out.match(/started (run-[a-f0-9]+) in background/)?.[1];
		expect(runId).toBeDefined();

		const waited = run(["wait", runId as string], cwd);
		expect(waited.code).toBe(0);
		expect(waited.out).toContain(`${runId}  echo  completed`);
		expect(existsSync(join(cwd, ".chit", "runs", `${runId}.argv`))).toBe(false);
	});

	test("a background child clears Chit handoff env before spawned checks", () => {
		const cwd = tmp();
		const sh = (c: string) => Bun.spawnSync(["sh", "-c", c], { cwd });
		sh("git init -q && git config user.email t@t.co && git config user.name t");
		writeFileSync(
			join(cwd, "chit.config.json"),
			JSON.stringify({ routines: { nested: { file: "nested.json" } }, profiles: {} }),
		);
		writeFileSync(
			join(cwd, "nested.json"),
			JSON.stringify({
				id: "nested",
				inputs: {},
				steps: [{ id: "nested-chit", check: [{ command: BIN, args: ["--version"] }] }],
				repeat: { until: "checks-pass", maxIterations: 1 },
			}),
		);
		sh("git add -A && git commit -q -m init");

		const bg = run(["run", "nested", "--background"], cwd);
		expect(bg.code).toBe(0);
		const runId = bg.out.match(/started (run-[a-f0-9]+) in background/)?.[1];
		expect(runId).toBeDefined();

		const waited = run(["wait", runId as string], cwd);
		expect(waited.code).toBe(0);
		expect(waited.out).toContain(`${runId}  nested  converged`);
	});

	// The readiness barrier's reason for existing: a sandboxed background run captures its base
	// commit BEFORE the parent reports it started, so dirtying the tree the instant the command
	// returns cannot sink the run. Without the barrier this races (the child's preflight could see
	// the dirty tree and refuse); with it, the parent only returns after the child pinned its base.
	test("a background sandboxed run still succeeds when the tree is dirtied right after it returns", () => {
		const cwd = tmp();
		const sh = (c: string) => Bun.spawnSync(["sh", "-c", c], { cwd });
		sh("git init -q && git config user.email t@t.co && git config user.name t");
		writeFileSync(
			join(cwd, "chit.config.json"),
			JSON.stringify({ routines: { writer: { file: "writer.json" } }, profiles: {} }),
		);
		writeFileSync(
			join(cwd, "writer.json"),
			JSON.stringify({
				id: "writer",
				inputs: {},
				steps: [{ id: "make", check: [{ command: "sh", args: ["-c", "echo hello-from-check > out.txt"] }] }],
				repeat: { until: "checks-pass", maxIterations: 1 },
			}),
		);
		sh("git add -A && git commit -q -m init");

		const bg = run(["run", "writer", "--background"], cwd);
		expect(bg.code).toBe(0);
		const runId = bg.out.match(/started (run-[a-f0-9]+) in background/)?.[1];
		expect(runId).toBeDefined();

		// Dirty the origin the moment the background command returned. The barrier guarantees the
		// child already captured its base, so this must not affect the in-flight run.
		writeFileSync(join(cwd, "dirty.txt"), "uncommitted, written right after the run started\n");

		const waited = run(["wait", runId as string], cwd);
		expect(waited.code).toBe(0);
		expect(waited.out).toContain(`${runId}  writer  converged`);
		expect(existsSync(join(cwd, "out.txt"))).toBe(false); // dry run: the sandbox was discarded
	});

	test("`chit run --help` prints focused help through the real binary", () => {
		const r = run(["run", "--help"], tmp());
		expect(r.code).toBe(0);
		expect(r.out).toContain("chit run <routine> [options]");
		expect(r.err).toBe("");
	});

	test("help and version ignore a stale CHIT_PROJECT through the real binary", () => {
		const cwd = tmp();
		const env = { ...process.env, CHIT_PROJECT: "/no/such/chit/project" };

		let r = Bun.spawnSync([BIN, "--help"], { cwd, env });
		expect(r.exitCode).toBe(0);
		expect(r.stdout.toString()).toContain("chit routines");
		expect(r.stderr.toString()).toBe("");

		r = Bun.spawnSync([BIN, "--version"], { cwd, env });
		expect(r.exitCode).toBe(0);
		expect(r.stdout.toString()).toContain("chit ");
		expect(r.stderr.toString()).toBe("");
	});

	// A non-sandboxed loop through the real binary, no model: a format-only loop whose
	// { step, equals } exit is satisfied (or not) by an input. Proves the cwd-loop dispatch,
	// convergence, exit codes, and text output at the process boundary.
	test("a { step, equals } loop runs in the cwd, converges, and prints its result (no model, no sandbox)", () => {
		const cwd = tmp();
		writeFileSync(
			join(cwd, "chit.config.json"),
			JSON.stringify({ routines: { settle: { file: "settle.json" } }, profiles: {} }),
		);
		writeFileSync(
			join(cwd, "settle.json"),
			JSON.stringify({
				id: "settle",
				inputs: { answer: { type: "string" } },
				steps: [
					{ id: "decide", format: "{{ inputs.answer }}" },
					{ id: "result", format: "settled on {{ inputs.answer }}" },
				],
				repeat: { until: { step: "decide", equals: "yes" }, maxIterations: 2 },
				output: "result",
			}),
		);
		const ok = run(["run", "settle", "--input", "answer=yes"], cwd);
		expect(ok.code).toBe(0);
		expect(ok.out).toContain("run converged (1 iteration)");
		expect(ok.out).toContain("settled on yes");

		const no = run(["run", "settle", "--input", "answer=no"], cwd);
		expect(no.code).toBe(1);
		expect(no.err).toMatch(/did-not-converge/);
	});

	// The full review gate through the real binary, no model: a check that writes a file gives a
	// real diff. A dry run stores the exact patch and leaves the tree untouched; `chit apply`
	// re-plays that patch onto the real tree. (A model-less stand-in for grill -> ... -> impl.)
	test("dry-run stores a patch that `chit apply` re-plays to the real tree (no model)", () => {
		const cwd = tmp();
		const sh = (c: string) => Bun.spawnSync(["sh", "-c", c], { cwd });
		sh("git init -q && git config user.email t@t.co && git config user.name t");
		writeFileSync(
			join(cwd, "chit.config.json"),
			JSON.stringify({ routines: { writer: { file: "writer.json" } }, profiles: {} }),
		);
		writeFileSync(
			join(cwd, "writer.json"),
			JSON.stringify({
				id: "writer",
				inputs: {},
				steps: [{ id: "make", check: [{ command: "sh", args: ["-c", "echo hello-from-check > out.txt"] }] }],
				repeat: { until: "checks-pass", maxIterations: 1 },
			}),
		);
		sh("git add -A && git commit -q -m init");

		// dry run: converges, stores a patch, does NOT touch the origin
		const dry = run(["run", "writer"], cwd);
		expect(dry.code).toBe(0);
		expect(dry.out).toMatch(/chit apply run-/);
		expect(existsSync(join(cwd, "out.txt"))).toBe(false); // dry-run discarded the sandbox
		const runId = dry.out.match(/chit apply (run-[a-f0-9]+)/)?.[1];
		expect(runId).toBeDefined();

		// apply: re-plays exactly the stored patch onto the real tree
		const applied = run(["apply", runId as string], cwd);
		expect(applied.code).toBe(0);
		expect(applied.out).toContain(`applied run ${runId}`);
		expect(existsSync(join(cwd, "out.txt"))).toBe(true);
		expect(readFileSync(join(cwd, "out.txt"), "utf-8").trim()).toBe("hello-from-check");
	});

	test("a sandboxed run refuses a dirty origin (preflight), through the real binary", () => {
		const cwd = tmp();
		const sh = (c: string) => Bun.spawnSync(["sh", "-c", c], { cwd });
		sh("git init -q && git config user.email t@t.co && git config user.name t");
		writeFileSync(
			join(cwd, "chit.config.json"),
			JSON.stringify({ routines: { writer: { file: "writer.json" } }, profiles: {} }),
		);
		writeFileSync(
			join(cwd, "writer.json"),
			JSON.stringify({
				id: "writer",
				inputs: {},
				steps: [{ id: "make", check: [{ command: "sh", args: ["-c", "true"] }] }],
				repeat: { until: "checks-pass", maxIterations: 1 },
			}),
		);
		sh("git add -A && git commit -q -m init");
		writeFileSync(join(cwd, "dirty.txt"), "uncommitted\n"); // dirty the origin

		const r = run(["run", "writer"], cwd);
		expect(r.code).toBe(1);
		expect(r.err).toMatch(/Commit or stash/);
	});

	// Project addressing + JSON state through the real binary: a run's receipt in one dir is read
	// back as machine state from an unrelated cwd via --project and CHIT_PROJECT, and stdout is
	// pure JSON. This is the agent-from-any-cwd path the unit tests fake.
	test("--project and CHIT_PROJECT address another project's run state as JSON", () => {
		const proj = tmp();
		writeFileSync(
			join(proj, "chit.config.json"),
			JSON.stringify({ routines: { echo: { file: "echo.json" } }, profiles: {} }),
		);
		writeFileSync(
			join(proj, "echo.json"),
			JSON.stringify({
				id: "echo",
				inputs: { name: { type: "string" } },
				steps: [{ id: "out", format: "hello {{ inputs.name }}" }],
				output: "out",
			}),
		);
		// A foreground, model-less run writes a receipt in proj.
		const ran = run(["run", "echo", "--input", "name=Ada"], proj);
		expect(ran.code).toBe(0);
		const runId = ran.out.match(/run (run-[a-f0-9]+)/)?.[1];
		expect(runId).toBeDefined();

		// From an unrelated cwd, --project points status at proj; stdout parses as one state object.
		const other = tmp();
		const viaArg = run(["status", runId as string, "--project", proj, "--json"], other);
		expect(viaArg.code).toBe(0);
		expect(JSON.parse(viaArg.out)).toMatchObject({
			runId,
			routineId: "echo",
			phase: "finished",
			status: "completed",
			exitCode: 0,
		});

		// CHIT_PROJECT is the env fallback for the same addressing.
		const viaEnv = Bun.spawnSync([BIN, "status", runId as string, "--json"], {
			cwd: other,
			env: { ...process.env, CHIT_PROJECT: proj },
		});
		expect(viaEnv.exitCode).toBe(0);
		expect(JSON.parse(viaEnv.stdout.toString())).toMatchObject({ runId, phase: "finished" });
	});

	test("does not load a project .env into Chit or spawned checks", () => {
		const cwd = tmp();
		const sh = (c: string) => Bun.spawnSync(["sh", "-c", c], { cwd });
		sh("git init -q && git config user.email t@t.co && git config user.name t");
		writeFileSync(join(cwd, ".env"), "CHIT_ENV_LEAK_TEST=leaked\n");
		writeFileSync(
			join(cwd, "chit.config.json"),
			JSON.stringify({ routines: { envcheck: { file: "envcheck.json" } }, profiles: {} }),
		);
		writeFileSync(
			join(cwd, "envcheck.json"),
			JSON.stringify({
				id: "envcheck",
				inputs: {},
				steps: [{ id: "env", check: [{ command: "sh", args: ["-c", 'test -z "$CHIT_ENV_LEAK_TEST"'] }] }],
				repeat: { until: "checks-pass", maxIterations: 1 },
			}),
		);
		sh("git add -A && git commit -q -m init");

		const r = run(["run", "envcheck"], cwd);
		expect(r.code).toBe(0);
		expect(r.out).toContain("run converged");
	});
});

(process.env.CHIT_REAL_SMOKE === "1" ? describe : describe.skip)("CLI process: a real run through the binary", () => {
	test("`src/index.ts run plan` returns output and exits 0", () => {
		const r = Bun.spawnSync([BIN, "run", "plan", "--input", "task=add a status command"], {
			cwd: exampleProject(),
		});
		expect(r.exitCode).toBe(0);
		expect(r.stdout.toString().length).toBeGreaterThan(50);
	}, 600_000);
});
