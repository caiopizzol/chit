import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type LoopLogIO, runLoopLog } from "./loop-log.ts";

let cwd: string;
let stateDir: string;
let savedXdg: string | undefined;
beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "chit-loop-cli-"));
	// Loop logs live under the state dir now; redirect it to a temp dir so tests
	// stay isolated from the real ~/.local/state.
	stateDir = mkdtempSync(join(tmpdir(), "chit-loop-cli-state-"));
	savedXdg = process.env.XDG_STATE_HOME;
	process.env.XDG_STATE_HOME = stateDir;
});
afterEach(() => {
	if (savedXdg === undefined) delete process.env.XDG_STATE_HOME;
	else process.env.XDG_STATE_HOME = savedXdg;
	rmSync(cwd, { recursive: true, force: true });
	rmSync(stateDir, { recursive: true, force: true });
});

function run(...argv: string[]): { code: number; out: string; err: string } {
	const out: string[] = [];
	const err: string[] = [];
	const io: LoopLogIO = { out: (s) => out.push(s), err: (s) => err.push(s) };
	const code = runLoopLog([...argv, "--cwd", cwd], io);
	return { code, out: out.join(""), err: err.join("") };
}

const startL1 = () =>
	run("start", "--scope", "s", "--task", "t", "--max-iterations", "3", "--loop-id", "L1");

const appendL1 = () =>
	run(
		"append",
		"--loop-id",
		"L1",
		"--summary",
		"did x",
		"--changed-files",
		'["a.ts","b.ts"]',
		"--checks-run",
		"tests",
		"--verdict",
		"revise",
		"--finding-count",
		"2",
		"--decision",
		"revise",
		"--duration-ms",
		"18000",
	);

describe("loop-log CLI: happy path", () => {
	test("start -> append -> show -> stop round-trips", () => {
		const s = startL1();
		expect(s.code).toBe(0);
		expect(JSON.parse(s.out)).toMatchObject({ loopId: "L1" });

		const a = appendL1();
		expect(a.code).toBe(0);
		expect(JSON.parse(a.out)).toEqual({ n: 1, path: expect.any(String) });

		const showJson = run("show", "--loop-id", "L1", "--json");
		expect(showJson.code).toBe(0);
		expect(JSON.parse(showJson.out).map((r: { type: string }) => r.type)).toEqual([
			"loop",
			"iteration",
		]);

		const stop = run("stop", "--loop-id", "L1", "--status", "converged", "--reason", "done");
		expect(stop.code).toBe(0);
		expect(JSON.parse(stop.out)).toMatchObject({ iterations: 1 });

		const showText = run("show", "--loop-id", "L1");
		expect(showText.code).toBe(0);
		expect(showText.out).toContain("stopped: converged");
	});
});

describe("loop-log CLI: rejects store-owned and unknown flags", () => {
	test("append refuses --n (the store owns the iteration number)", () => {
		startL1();
		const r = run(
			"append",
			"--loop-id",
			"L1",
			"--n",
			"5",
			"--summary",
			"x",
			"--changed-files",
			"[]",
			"--checks-run",
			"t",
			"--verdict",
			"proceed",
			"--finding-count",
			"0",
			"--decision",
			"proceed",
			"--duration-ms",
			"1",
		);
		expect(r.code).toBe(2);
		expect(r.err).toMatch(/unknown flag --n/);
	});

	test("stop refuses --iterations (the store computes it)", () => {
		startL1();
		const r = run(
			"stop",
			"--loop-id",
			"L1",
			"--iterations",
			"9",
			"--status",
			"converged",
			"--reason",
			"x",
		);
		expect(r.code).toBe(2);
		expect(r.err).toMatch(/unknown flag --iterations/);
	});
});

describe("loop-log CLI: usage and store errors map to exit codes", () => {
	test("missing required flag -> exit 2", () => {
		const r = run("start", "--task", "t", "--max-iterations", "3");
		expect(r.code).toBe(2);
		expect(r.err).toMatch(/requires --scope/);
	});

	test("unknown subcommand -> exit 2", () => {
		const r = run("frobnicate");
		expect(r.code).toBe(2);
		expect(r.err).toMatch(/unknown subcommand/);
	});

	test("no subcommand -> exit 2 with help on stderr", () => {
		const out: string[] = [];
		const err: string[] = [];
		const code = runLoopLog([], { out: (s) => out.push(s), err: (s) => err.push(s) });
		expect(code).toBe(2);
		expect(err.join("")).toMatch(/loop-log <start\|append\|stop\|show>/);
	});

	test("append to a missing loop -> exit 1 (store error)", () => {
		const r = run(
			"append",
			"--loop-id",
			"ghost",
			"--summary",
			"x",
			"--changed-files",
			"[]",
			"--checks-run",
			"t",
			"--verdict",
			"proceed",
			"--finding-count",
			"0",
			"--decision",
			"proceed",
			"--duration-ms",
			"1",
		);
		expect(r.code).toBe(1);
		expect(r.err).toMatch(/no loop log/);
	});

	test("an invalid verdict enum -> exit 1 (model validation)", () => {
		startL1();
		const r = run(
			"append",
			"--loop-id",
			"L1",
			"--summary",
			"x",
			"--changed-files",
			"[]",
			"--checks-run",
			"t",
			"--verdict",
			"maybe",
			"--finding-count",
			"0",
			"--decision",
			"proceed",
			"--duration-ms",
			"1",
		);
		expect(r.code).toBe(1);
		expect(r.err).toMatch(/verdict/);
	});

	test("--changed-files that is not a JSON array -> exit 2", () => {
		startL1();
		const r = run(
			"append",
			"--loop-id",
			"L1",
			"--summary",
			"x",
			"--changed-files",
			"a.ts,b.ts",
			"--checks-run",
			"t",
			"--verdict",
			"proceed",
			"--finding-count",
			"0",
			"--decision",
			"proceed",
			"--duration-ms",
			"1",
		);
		expect(r.code).toBe(2);
		expect(r.err).toMatch(/changed-files/);
	});

	test("an unexpected fs error exits 1 with a clean message, not a raw stack", () => {
		// Point the state dir under a regular file, so creating the loop dir throws
		// a raw ENOTDIR (not a LoopStoreError); it must still surface cleanly.
		const filePath = join(stateDir, "not-a-dir");
		writeFileSync(filePath, "x");
		process.env.XDG_STATE_HOME = filePath;
		const out: string[] = [];
		const err: string[] = [];
		const code = runLoopLog(
			["start", "--scope", "s", "--task", "t", "--max-iterations", "3", "--cwd", cwd],
			{ out: (s) => out.push(s), err: (s) => err.push(s) },
		);
		expect(code).toBe(1);
		expect(err.join("")).toMatch(/^chit loop-log: /);
	});
});
