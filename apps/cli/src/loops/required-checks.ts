// chit runs a loop's declared required checks ITSELF -- ground-truth verification,
// not a reviewer's self-report. Each check is spawned as argv with NO shell: the
// command and its args go straight to the process, so a metacharacter in an arg is a
// literal argument and can never be interpreted (no `;`, `&&`, `|`, glob, or quoting
// semantics). Deliberately narrow, matching the schema: the run worktree as cwd, the
// inherited process env (no overrides), a per-check timeout, and bounded captured
// output. No shell, no env injection, no retries -- this is chit-executed
// verification, not a CI runner.

import type { RequiredCheck } from "@chit-run/core";

export const DEFAULT_CHECK_TIMEOUT_MS = 120_000;
// The loop log must not balloon with full build output, so each result keeps only a
// bounded tail (a failing command's tail usually holds the actual error).
const MAX_OUTPUT_CHARS = 2_000;

// The outcome of one chit-executed check. `passed`/`failed` mean the process ran and
// exited 0 / non-zero; `blocked` means chit could NOT verify (it never started, timed
// out, or was cancelled) -- which the loop must treat differently from a real failure.
export interface CheckResult {
	name: string; // display label: the check's `name`, else the command + args
	status: "passed" | "failed" | "blocked";
	exitCode?: number; // present only when the process actually ran (passed/failed)
	durationMs: number;
	timedOut: boolean;
	output: string; // bounded tail of combined stdout+stderr, or the start/timeout note
}

function label(check: RequiredCheck): string {
	return check.name ?? [check.command, ...check.args].join(" ");
}

// Keep only the last MAX_OUTPUT_CHARS, with a marker, so a huge log degrades to its
// (usually most relevant) tail instead of bloating the loop record.
function boundedTail(s: string): string {
	const t = s.trimEnd();
	if (t.length <= MAX_OUTPUT_CHARS) return t;
	return `...(output truncated to last ${MAX_OUTPUT_CHARS} chars)\n${t.slice(t.length - MAX_OUTPUT_CHARS)}`;
}

// Run one required check. Never throws: a command that cannot start is `blocked`
// (chit could not verify), distinct from a command that ran and failed.
export async function runRequiredCheck(
	check: RequiredCheck,
	opts: { cwd: string; signal?: AbortSignal; now?: () => number },
): Promise<CheckResult> {
	const now = opts.now ?? Date.now;
	const name = label(check);
	const timeoutMs = check.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;
	const start = now();

	let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
	try {
		// Array form + no `env` option: argv straight to the process (no shell), child
		// inherits this process's environment unchanged.
		proc = Bun.spawn([check.command, ...check.args], {
			cwd: opts.cwd,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
	} catch (e) {
		return {
			name,
			status: "blocked",
			durationMs: now() - start,
			timedOut: false,
			output: `could not start: ${(e as Error).message}`,
		};
	}

	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		proc.kill();
	}, timeoutMs);
	const onAbort = () => proc.kill();
	if (opts.signal) {
		if (opts.signal.aborted) proc.kill();
		else opts.signal.addEventListener("abort", onAbort, { once: true });
	}

	try {
		// Drain both pipes concurrently (a full pipe buffer would otherwise deadlock the
		// child), then await its exit.
		const stdoutP = new Response(proc.stdout).text();
		const stderrP = new Response(proc.stderr).text();
		const exitCode = await proc.exited;
		const [stdout, stderr] = await Promise.all([stdoutP, stderrP]);
		const durationMs = now() - start;
		const output = boundedTail(`${stdout}${stderr}`);

		if (timedOut) {
			return {
				name,
				status: "blocked",
				durationMs,
				timedOut: true,
				output: output
					? `timed out after ${timeoutMs}ms\n${output}`
					: `timed out after ${timeoutMs}ms`,
			};
		}
		if (opts.signal?.aborted) {
			return {
				name,
				status: "blocked",
				durationMs,
				timedOut: false,
				output: "cancelled before completion",
			};
		}
		return {
			name,
			status: exitCode === 0 ? "passed" : "failed",
			exitCode,
			durationMs,
			timedOut: false,
			output,
		};
	} finally {
		clearTimeout(timer);
		if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
	}
}

// Run every declared check, sequentially and in order. All run even after one fails,
// so the record and the prior_review feedback list ALL failures at once -- the
// implementer fixes them in a single revise round, not one check per iteration.
// Sequential keeps output uninterleaved and the result order deterministic.
export async function runRequiredChecks(
	checks: RequiredCheck[],
	opts: { cwd: string; signal?: AbortSignal; now?: () => number },
): Promise<CheckResult[]> {
	const results: CheckResult[] = [];
	for (const check of checks) {
		if (opts.signal?.aborted) {
			results.push({
				name: label(check),
				status: "blocked",
				durationMs: 0,
				timedOut: false,
				output: "cancelled before start",
			});
			continue;
		}
		results.push(await runRequiredCheck(check, opts));
	}
	return results;
}
