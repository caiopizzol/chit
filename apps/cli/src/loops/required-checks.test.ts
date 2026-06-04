import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RequiredCheck } from "@chit-run/core";
import {
	type CheckResult,
	checkResultsToLoopChecks,
	pickRequiredChecks,
	resolveRunRequiredChecks,
	runRequiredCheck,
	runRequiredChecks,
} from "./required-checks.ts";

// These spawn real POSIX binaries (true/false/printf/sleep/seq), which is the point:
// the runner's contract is about real process semantics (argv, exit codes, timeout),
// not something a mock would prove.
const CWD = process.cwd();

describe("runRequiredCheck", () => {
	test("a command that exits 0 -> passed with exit code 0", async () => {
		const r = await runRequiredCheck({ command: "true", args: [] }, { cwd: CWD });
		expect(r.status).toBe("passed");
		expect(r.exitCode).toBe(0);
		expect(r.timedOut).toBe(false);
	});

	test("a command that exits non-zero -> failed with the exit code", async () => {
		const r = await runRequiredCheck({ command: "false", args: [] }, { cwd: CWD });
		expect(r.status).toBe("failed");
		expect(r.exitCode).toBe(1);
		expect(r.timedOut).toBe(false);
	});

	test("args are passed as argv, NOT interpreted by a shell (the load-bearing invariant)", async () => {
		// The arg is one string full of shell metacharacters. Through a shell, the `;`
		// and `&&` would run `echo PWNED` and `rm -rf /`; as argv it is a single literal
		// argument that printf prints verbatim inside the brackets. Exact equality proves
		// no shell touched it.
		const r = await runRequiredCheck(
			{ command: "printf", args: ["[%s]", "x; echo PWNED && rm -rf /"] },
			{ cwd: CWD },
		);
		expect(r.status).toBe("passed");
		expect(r.output).toBe("[x; echo PWNED && rm -rf /]");
	});

	test("a command that cannot start -> blocked (could not start), never failed", async () => {
		// blocked, not failed: chit could not verify, so the loop must not read this as a
		// real test failure that the implementer can fix by editing code.
		const r = await runRequiredCheck(
			{ command: "chit-no-such-binary-xyz", args: [] },
			{ cwd: CWD },
		);
		expect(r.status).toBe("blocked");
		expect(r.exitCode).toBeUndefined();
		expect(r.output).toContain("could not start");
	});

	test("a command that exceeds its timeout -> blocked + timedOut", async () => {
		const r = await runRequiredCheck(
			{ command: "sleep", args: ["5"], timeoutMs: 80 },
			{ cwd: CWD },
		);
		expect(r.status).toBe("blocked");
		expect(r.timedOut).toBe(true);
		expect(r.output).toContain("timed out after 80ms");
	});

	test("the timeout is HARD: a SIGTERM-ignoring process with a pipe-holding child still returns promptly", async () => {
		// `trap "" TERM` makes the shell ignore SIGTERM; `sleep 5` is an orphanable
		// grandchild that keeps the stdout pipe open past the shell's death. A soft (SIGTERM)
		// kill plus an unbounded stream read would wait ~5s; the hard SIGKILL timeout and the
		// capped post-exit pipe flush must return in well under that.
		const t0 = Date.now();
		const r = await runRequiredCheck(
			{ command: "sh", args: ["-c", 'trap "" TERM; sleep 5'], timeoutMs: 150 },
			{ cwd: CWD },
		);
		const elapsed = Date.now() - t0;
		expect(r.status).toBe("blocked");
		expect(r.timedOut).toBe(true);
		expect(r.output).toContain("timed out after 150ms");
		expect(elapsed).toBeLessThan(2000); // a trapped SIGTERM would have hung ~5s
	});

	test("a timeout KILLS THE PROCESS TREE, not just the direct child", async () => {
		// The shell backgrounds a long sleep (a grandchild of the runner), records ITS pid,
		// then waits. On timeout chit must group-kill the whole tree, so the grandchild is
		// dead afterward -- not orphaned and left running.
		const dir = mkdtempSync(join(tmpdir(), "chit-rc-tree-"));
		const pidFile = join(dir, "child.pid");
		const r = await runRequiredCheck(
			{ command: "sh", args: ["-c", `sleep 30 & echo $! > "${pidFile}"; wait`], timeoutMs: 150 },
			{ cwd: CWD },
		);
		expect(r.status).toBe("blocked");
		expect(r.timedOut).toBe(true);
		await Bun.sleep(150); // let the kernel reap the group
		const childPid = Number(readFileSync(pidFile, "utf8").trim());
		expect(Number.isInteger(childPid)).toBe(true);
		let alive = true;
		try {
			process.kill(childPid, 0); // signal 0 = existence probe
		} catch {
			alive = false;
		}
		try {
			process.kill(childPid, "SIGKILL"); // best-effort cleanup if the fix regressed
		} catch {
			// already gone
		}
		rmSync(dir, { recursive: true, force: true });
		expect(alive).toBe(false); // the whole tree was reaped, not just the direct child
	});

	test("a process that exits 0 before its timeout is passed, even if a child holds the pipe past it", async () => {
		// sh exits 0 almost immediately; the backgrounded `sleep` keeps the stdout pipe open,
		// so the post-exit drain grace runs. timeoutMs is short enough that the grace crosses
		// it -- the timeout must already be disarmed (the process is done), so this is passed,
		// NOT a false blocked/timedOut.
		const r = await runRequiredCheck(
			{ command: "sh", args: ["-c", "sleep 2 & exit 0"], timeoutMs: 50 },
			{ cwd: CWD },
		);
		expect(r.status).toBe("passed");
		expect(r.exitCode).toBe(0);
		expect(r.timedOut).toBe(false);
	});

	test("trailing whitespace does not evict real content from the bounded tail", async () => {
		// "ERR" then far more than MAX trailing newlines. The old trimEnd-then-tail kept
		// "ERR"; the streamed bounded tail must too (trailing whitespace is trimmed, not
		// counted as content), so the record is the real tail, not just a truncation marker.
		const r = await runRequiredCheck(
			{
				command: "sh",
				args: ["-c", 'printf ERR; i=0; while [ $i -lt 3000 ]; do printf "\\n"; i=$((i+1)); done'],
			},
			{ cwd: CWD },
		);
		expect(r.status).toBe("passed");
		expect(r.output).toBe("ERR");
	});

	test("stdout's trailing whitespace is internal when stderr follows (combine, then trim)", async () => {
		// stdout ends in a newline, then stderr has content. In the combined output that
		// newline is INTERNAL, so it must survive -- matching boundedTail(stdout + stderr),
		// not a per-stream trim that would record "OUTERR".
		const r = await runRequiredCheck(
			{ command: "sh", args: ["-c", 'printf "OUT\\n"; printf ERR >&2; exit 1'] },
			{ cwd: CWD },
		);
		expect(r.status).toBe("failed");
		expect(r.output).toBe("OUT\nERR");
	});

	test("whitespace between stdout and stderr content counts toward truncation", async () => {
		// "A", far more than MAX newlines, then stderr "B". The newlines are internal (B
		// follows), so the combined output is truncated and ends at the real tail (B) with a
		// marker -- not the bare "AB".
		const r = await runRequiredCheck(
			{
				command: "sh",
				args: [
					"-c",
					'printf A; i=0; while [ $i -lt 3000 ]; do printf "\\n"; i=$((i+1)); done; printf B >&2',
				],
			},
			{ cwd: CWD },
		);
		expect(r.output).toContain("truncated");
		expect(r.output.endsWith("B")).toBe(true);
	});

	test("output is bounded to a tail (does not balloon the loop log)", async () => {
		// seq floods ~1MB of stdout; the result keeps only a bounded tail.
		const r = await runRequiredCheck({ command: "seq", args: ["1", "200000"] }, { cwd: CWD });
		expect(r.status).toBe("passed");
		expect(r.output.length).toBeLessThanOrEqual(2100);
		expect(r.output).toContain("truncated");
		expect(r.output.trimEnd().endsWith("200000")).toBe(true); // it is the TAIL
	});

	test("duration is computed from the injected clock (deterministic for later slices)", async () => {
		// now() is called once at start and once at end; +50 each call -> a 50ms delta.
		let t = 1000;
		const r = await runRequiredCheck(
			{ command: "true", args: [] },
			{ cwd: CWD, now: () => (t += 50) },
		);
		expect(r.durationMs).toBe(50);
	});
});

describe("runRequiredChecks", () => {
	test("runs every check in order and returns a result per check", async () => {
		const rs: CheckResult[] = await runRequiredChecks(
			[
				{ command: "true", args: [] },
				{ command: "false", args: [] },
				{ command: "true", args: [] },
			],
			{ cwd: CWD },
		);
		// All run even though the middle one failed -- so a revise round sees every
		// failure at once, not one per iteration.
		expect(rs.map((r) => r.status)).toEqual(["passed", "failed", "passed"]);
	});

	test("an already-aborted signal blocks every check without spawning", async () => {
		const controller = new AbortController();
		controller.abort();
		const rs = await runRequiredChecks([{ command: "true", args: [] }], {
			cwd: CWD,
			signal: controller.signal,
		});
		expect(rs[0]?.status).toBe("blocked");
		expect(rs[0]?.output).toContain("cancelled");
	});
});

describe("command vs name + checkResultsToLoopChecks", () => {
	test("command is the argv display (ground truth); name is the separate label", async () => {
		const r = await runRequiredCheck(
			{ command: "true", args: ["--quiet"], name: "liveness" },
			{ cwd: CWD },
		);
		expect(r.command).toBe("true --quiet"); // what actually ran
		expect(r.name).toBe("liveness"); // the friendly label, kept separate, not a substitute
	});

	test("a check with no name has none (command still carries the truth)", async () => {
		const r = await runRequiredCheck({ command: "true", args: [] }, { cwd: CWD });
		expect(r.command).toBe("true");
		expect(r.name).toBeUndefined();
	});

	test("the mapper records command + name, and reason only for non-passed", () => {
		const checks = checkResultsToLoopChecks([
			{
				command: "bun test",
				name: "tests",
				status: "passed",
				durationMs: 1,
				timedOut: false,
				output: "ok",
			},
			{
				command: "bun run lint",
				status: "failed",
				exitCode: 1,
				durationMs: 1,
				timedOut: false,
				output: "3 problems",
			},
			{
				command: "bun run e2e",
				status: "blocked",
				durationMs: 1,
				timedOut: true,
				output: "timed out after 80ms",
			},
		]);
		expect(checks).toEqual([
			{ command: "bun test", name: "tests", status: "passed" }, // passed -> no reason recorded
			{ command: "bun run lint", status: "failed", reason: "3 problems" },
			{ command: "bun run e2e", status: "blocked", reason: "timed out after 80ms" },
		]);
	});
});

describe("resolveRunRequiredChecks (run-level override + one-shot reject)", () => {
	const A: RequiredCheck = { command: "bun", args: ["test"] };
	const B: RequiredCheck = { command: "bun", args: ["run", "typecheck"] };

	test("a one-shot run given checks is rejected (not silently ignored)", () => {
		const r = resolveRunRequiredChecks("one-shot", [A], undefined);
		if (r.ok) throw new Error("expected reject");
		expect(r.error).toContain("applies only to a loop");
	});

	test("a one-shot run with NO run-level checks is fine (nothing to apply)", () => {
		expect(resolveRunRequiredChecks("one-shot", undefined, undefined)).toEqual({
			ok: true,
			checks: undefined,
		});
	});

	test("loop run-level checks REPLACE the manifest's (never merge)", () => {
		expect(resolveRunRequiredChecks("loop", [A], [B])).toEqual({ ok: true, checks: [A] });
	});

	test("loop with no run-level checks falls back to the manifest's", () => {
		expect(resolveRunRequiredChecks("loop", undefined, [B])).toEqual({ ok: true, checks: [B] });
	});

	test("loop run-level [] replaces -- overrides the manifest's checks AWAY", () => {
		expect(resolveRunRequiredChecks("loop", [], [B])).toEqual({ ok: true, checks: [] });
	});
});

describe("pickRequiredChecks (the one precedence primitive)", () => {
	const A: RequiredCheck = { command: "a", args: [] };
	const B: RequiredCheck = { command: "b", args: [] };
	const C: RequiredCheck = { command: "c", args: [] };

	test("the FIRST declared level wins (closest-declared, never a merge)", () => {
		expect(pickRequiredChecks(undefined, [A], [B])).toEqual([A]); // skips undefined, takes [A]
		expect(pickRequiredChecks([A], [B], [C])).toEqual([A]); // [A], not [A, B, C]
	});

	test("an explicit [] counts as declared and overrides lower levels AWAY", () => {
		expect(pickRequiredChecks([], [B])).toEqual([]); // empty wins, not [B]
	});

	test("all undefined -> undefined (nothing declared)", () => {
		expect(pickRequiredChecks(undefined, undefined)).toBeUndefined();
	});
});
