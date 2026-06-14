// The tests elsewhere call runCli(...) directly; these spawn the ACTUAL binary
// (`bun src/index.ts ...`) in a temp cwd and assert exit codes + output. That covers
// what only the process boundary can: argv parsing, process.exit codes, the bin's
// adapter-registry wiring, and the no-config / unknown-command paths an operator hits.
// The deterministic cases need no model; one guarded case runs a real routine.

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

const BIN = join(import.meta.dir, "index.ts");
const REPO = join(import.meta.dir, ".."); // repo root: has chit.config.json + examples/

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
	const r = Bun.spawnSync(["bun", BIN, ...args], { cwd });
	return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

describe("CLI process: the real binary (no model)", () => {
	test("init -> routines -> inspect end to end through the binary", () => {
		const cwd = tmp();
		let r = run(["init", "myrev"], cwd);
		expect(r.code).toBe(0);
		expect(r.out).toContain("created examples/myrev.json");
		expect(existsSync(join(cwd, "chit.config.json"))).toBe(true);

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
		writeFileSync(join(cwd, "chit.config.json"), JSON.stringify({ routines: { echo: { manifestPath: "echo.json" } }, agents: {} }));
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
		const r = Bun.spawnSync(["bun", BIN, "run", "echo"], { cwd, stdin: Buffer.from("Ada\n") });
		expect(r.exitCode).toBe(0);
		expect(r.stdout.toString()).toContain("hello Ada"); // the typed answer flowed into the format step
	});
});

(process.env.CHIT_REAL_SMOKE === "1" ? describe : describe.skip)("CLI process: a real run through the binary", () => {
	test("`bun src/index.ts run feature-griller` returns output and exits 0", () => {
		const r = Bun.spawnSync(["bun", BIN, "run", "feature-griller", "--input", "idea=add a status command"], { cwd: REPO });
		expect(r.exitCode).toBe(0);
		expect(r.stdout.toString().length).toBeGreaterThan(50);
	}, 600_000);
});
