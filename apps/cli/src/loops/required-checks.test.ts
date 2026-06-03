import { describe, expect, test } from "bun:test";
import { type CheckResult, runRequiredCheck, runRequiredChecks } from "./required-checks.ts";

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
