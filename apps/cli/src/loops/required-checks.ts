// chit runs a loop's declared required checks ITSELF -- ground-truth verification,
// not a reviewer's self-report. Each check is spawned as argv with NO shell: the
// command and its args go straight to the process, so a metacharacter in an arg is a
// literal argument and can never be interpreted (no `;`, `&&`, `|`, glob, or quoting
// semantics). Deliberately narrow, matching the schema: the run worktree as cwd, the
// inherited process env (no overrides), a per-check timeout, and bounded captured
// output. No shell, no env injection, no retries -- this is chit-executed
// verification, not a CI runner.

import type { LoopCheck, RequiredCheck } from "@chit-run/core";

export const DEFAULT_CHECK_TIMEOUT_MS = 120_000;
// The loop log must not balloon with full build output, so each result keeps only a
// bounded tail (a failing command's tail usually holds the actual error).
const MAX_OUTPUT_CHARS = 2_000;

// The outcome of one chit-executed check. `passed`/`failed` mean the process ran and
// exited 0 / non-zero; `blocked` means chit could NOT verify (it never started, timed
// out, or was cancelled) -- which the loop must treat differently from a real failure.
export interface CheckResult {
	// The exact command as a display string ("bun test") -- the ground truth of what
	// ran. Always present, even when the check declared a friendly name.
	command: string;
	// The check's declared friendly label, if any ("tests"). Never replaces `command`.
	name?: string;
	status: "passed" | "failed" | "blocked";
	exitCode?: number; // present only when the process actually ran (passed/failed)
	durationMs: number;
	timedOut: boolean;
	output: string; // bounded tail of combined stdout+stderr, or the start/timeout note
}

// The exact argv as a display string -- the ground truth of what ran.
function commandDisplay(check: RequiredCheck): string {
	return [check.command, ...check.args].join(" ");
}

// The identity fields every result carries: the ground-truth command, plus the
// friendly name when the check declared one.
function baseOf(check: RequiredCheck): { command: string; name?: string } {
	const base: { command: string; name?: string } = { command: commandDisplay(check) };
	if (check.name !== undefined) base.name = check.name;
	return base;
}

// A small grace after the process exits for its pipes to flush, so a well-behaved
// command's full output is captured -- but capped, never awaited: a surviving grandchild
// can hold a pipe open past the process's own exit, and the runner must not hang on it.
const DRAIN_GRACE_MS = 100;

// Stream a pipe into a running bounded tail: keep ONLY the last MAX_OUTPUT_CHARS in
// memory (so a noisy command can never balloon memory before truncation) and remember
// whether anything was dropped. read()/truncated() expose the live state, so the timeout
// path can take the tail-so-far without waiting for EOF.
function streamBoundedTail(stream: ReadableStream<Uint8Array>): {
	done: Promise<void>;
	read: () => string;
	truncated: () => boolean;
	cancel: () => void;
} {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let tail = "";
	let dropped = false;
	const append = (chunk: string): void => {
		if (!chunk) return;
		tail += chunk;
		if (tail.length > MAX_OUTPUT_CHARS) {
			tail = tail.slice(tail.length - MAX_OUTPUT_CHARS);
			dropped = true;
		}
	};
	const done = (async () => {
		try {
			for (;;) {
				const { done: d, value } = await reader.read();
				if (d) break;
				append(decoder.decode(value, { stream: true }));
			}
			append(decoder.decode());
		} catch {
			// reader cancelled or stream errored: keep whatever tail we captured
		}
	})();
	return {
		done,
		read: () => tail,
		truncated: () => dropped,
		cancel: () => {
			void reader.cancel().catch(() => {});
		},
	};
}

// Combine the two bounded tails into the recorded output: trailing whitespace trimmed, a
// truncation marker prepended when either stream dropped content (or the combined tail
// still exceeds the cap). Same recorded shape as before, but bounded as it streamed.
function combineOutput(
	out: { read: () => string; truncated: () => boolean },
	err: { read: () => string; truncated: () => boolean },
): string {
	let text = `${out.read()}${err.read()}`;
	let truncated = out.truncated() || err.truncated();
	if (text.length > MAX_OUTPUT_CHARS) {
		text = text.slice(text.length - MAX_OUTPUT_CHARS);
		truncated = true;
	}
	const trimmed = text.trimEnd();
	return truncated
		? `...(output truncated to last ${MAX_OUTPUT_CHARS} chars)\n${trimmed}`
		: trimmed;
}

// Run one required check. Never throws: a command that cannot start is `blocked`
// (chit could not verify), distinct from a command that ran and failed.
export async function runRequiredCheck(
	check: RequiredCheck,
	opts: { cwd: string; signal?: AbortSignal; now?: () => number },
): Promise<CheckResult> {
	const now = opts.now ?? Date.now;
	const base = baseOf(check);
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
			...base,
			status: "blocked",
			durationMs: now() - start,
			timedOut: false,
			output: `could not start: ${(e as Error).message}`,
		};
	}

	// Kill the whole process, ignoring an "already exited" throw from a late timer/abort.
	const safeKill = (): void => {
		try {
			proc.kill("SIGKILL");
		} catch {
			// the process already exited; nothing to kill
		}
	};

	let timedOut = false;
	// Stream both pipes immediately with bounded memory (draining also prevents a full
	// pipe buffer from deadlocking the child).
	const out = streamBoundedTail(proc.stdout);
	const err = streamBoundedTail(proc.stderr);

	// A HARD timeout: SIGKILL cannot be caught or ignored, so the process is gone -- and
	// `proc.exited` therefore resolves -- within timeoutMs no matter how the command
	// handles signals. (SIGTERM, the default, can be trapped and would not be a real
	// timeout.) An abort behaves the same.
	const timer = setTimeout(() => {
		timedOut = true;
		safeKill();
	}, timeoutMs);
	const onAbort = () => safeKill();
	if (opts.signal) {
		if (opts.signal.aborted) safeKill();
		else opts.signal.addEventListener("abort", onAbort, { once: true });
	}

	try {
		const exitCode = await proc.exited;
		// The process is gone (the timeout/abort SIGKILL guarantees this resolves). Let the
		// pipes flush so a well-behaved command's full output is captured, but CAP the wait:
		// a surviving grandchild can hold a pipe open past the process's exit, and we must
		// never hang on it. The bounded tail captured so far is what we record. Clear the
		// grace timer once the drains win, so it never keeps the CLI/worker alive at exit.
		let graceTimer: ReturnType<typeof setTimeout> | undefined;
		const grace = new Promise<void>((res) => {
			graceTimer = setTimeout(res, DRAIN_GRACE_MS);
		});
		await Promise.race([Promise.all([out.done, err.done]), grace]);
		clearTimeout(graceTimer);
		const durationMs = now() - start;
		const output = combineOutput(out, err);

		if (timedOut) {
			return {
				...base,
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
				...base,
				status: "blocked",
				durationMs,
				timedOut: false,
				output: "cancelled before completion",
			};
		}
		return {
			...base,
			status: exitCode === 0 ? "passed" : "failed",
			exitCode,
			durationMs,
			timedOut: false,
			output,
		};
	} finally {
		clearTimeout(timer);
		if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
		// Release the pipe readers so a stream still held open (grandchild) does not leak.
		out.cancel();
		err.cancel();
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
				...baseOf(check),
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

// Map chit's executed results into the recorded LoopCheck shape: `command` carries the
// ground-truth argv, `name` the friendly label, and `reason` the bounded output tail
// for a non-passed check ONLY (a passed check needs no reason -- no output noise in
// the log; the exit code stays internal to CheckResult rather than buried in prose).
export function checkResultsToLoopChecks(results: CheckResult[]): LoopCheck[] {
	return results.map((r) => {
		const check: LoopCheck = { command: r.command, status: r.status };
		if (r.name !== undefined) check.name = r.name;
		if (r.status !== "passed") check.reason = r.output;
		return check;
	});
}

// The precedence resolver for required checks: the FIRST declared level wins
// (closest-declared-wins, never a merge). An explicit [] counts as declared -- it
// overrides a lower level AWAY -- so only `undefined` falls through. The single source
// of precedence for every surface: run vs manifest, and batch task vs batch vs manifest.
export function pickRequiredChecks(
	...levels: (RequiredCheck[] | undefined)[]
): RequiredCheck[] | undefined {
	for (const level of levels) {
		if (level !== undefined) return level;
	}
	return undefined;
}

// Resolve a chit_start run's effective checks: the run-level input REPLACES the
// manifest policy's (never merges), and applies ONLY to a loop -- a one-shot run given
// checks is rejected with a clear error, not silently ignored (a deliberate contract,
// since silently ignoring them would mislead the caller into thinking checks will run).
export function resolveRunRequiredChecks(
	policyKind: "loop" | "one-shot",
	runLevel: RequiredCheck[] | undefined,
	manifestLevel: RequiredCheck[] | undefined,
): { ok: true; checks: RequiredCheck[] | undefined } | { ok: false; error: string } {
	if (runLevel !== undefined && policyKind !== "loop") {
		return {
			ok: false,
			error: "required_checks applies only to a loop run; this manifest declares a one-shot policy",
		};
	}
	return { ok: true, checks: pickRequiredChecks(runLevel, manifestLevel) };
}
