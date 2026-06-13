// The seam for running a check. Mirrors the Adapter seam: a narrow interface so
// the converge loop is tested with a fake (deterministic, no subprocesses) while
// the bin can wire the real argv runner. A check is argv-only, so the real runner
// spawns command+args directly with nothing to shell-escape.

import type { Check } from "./manifest.ts";
import { spawnCapture } from "./proc.ts";

// A hung check (an accidentally interactive command, an infinite test) must not
// block the loop. A timed-out check is reported as a failure, so the loop keeps
// its bound and feeds the timeout forward like any other failing check.
const CHECK_TIMEOUT_MS = 5 * 60_000;

export interface CheckResult {
	ok: boolean;
	exitCode: number;
	output: string;
}

export interface CheckRunner {
	run(check: Check, cwd: string): Promise<CheckResult>;
}

export interface FakeCheckRunner extends CheckRunner {
	calls: Array<{ check: Check; cwd: string }>;
}

// Scripted by call index so a test can make a check fail on iteration 1 and pass
// on iteration 2 -- the shape that proves the loop actually re-runs and converges.
export function fakeCheckRunner(
	script: (check: Check, callIndex: number) => CheckResult = () => ({ ok: true, exitCode: 0, output: "" }),
): FakeCheckRunner {
	const calls: Array<{ check: Check; cwd: string }> = [];
	return {
		calls,
		async run(check, cwd) {
			const result = script(check, calls.length);
			calls.push({ check, cwd });
			return result;
		},
	};
}

export const argvCheckRunner: CheckRunner = {
	async run(check, cwd) {
		const r = await spawnCapture([check.command, ...check.args], { cwd, timeoutMs: CHECK_TIMEOUT_MS });
		if (r.timedOut) {
			return { ok: false, exitCode: 124, output: `check timed out after ${CHECK_TIMEOUT_MS}ms` };
		}
		return { ok: r.exitCode === 0, exitCode: r.exitCode ?? -1, output: `${r.stdout}${r.stderr}`.trim() };
	},
};
