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
	// The directory the check ran in (the run worktree) and the timeout applied to it
	// (the configured value, else the default). Both are known for every result -- even
	// a could-not-start blocked one -- so the mapped LoopCheck is always auditable.
	cwd: string;
	timeoutMs: number;
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
	full: () => string;
	truncated: () => boolean;
	cancel: () => void;
} {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let tail = ""; // committed content tail (trailing whitespace deferred), bounded to MAX
	let pendingWs = ""; // whitespace since the last content char: trailing until content follows
	let dropped = false;
	const cap = (s: string): string => {
		if (s.length > MAX_OUTPUT_CHARS) {
			dropped = true;
			return s.slice(s.length - MAX_OUTPUT_CHARS);
		}
		return s;
	};
	// Defer trailing whitespace so a flood of trailing newlines cannot evict real content
	// from the bounded window (preserving the old trimEnd-then-tail semantics, but streamed).
	const append = (chunk: string): void => {
		if (!chunk) return;
		const trailing = /\s*$/.exec(chunk)?.[0] ?? "";
		if (trailing.length === chunk.length) {
			// All whitespace: keep it bounded and pending. It is dropped at EOF if it stays
			// trailing (trailing whitespace is never counted as truncated content).
			pendingWs = (pendingWs + trailing).slice(-MAX_OUTPUT_CHARS);
			return;
		}
		// Content arrived: the previously-pending whitespace is now internal, so commit it
		// with the content; the chunk's own trailing whitespace becomes the new pending.
		const content = chunk.slice(0, chunk.length - trailing.length);
		tail = cap(tail + pendingWs + content);
		pendingWs = trailing.length > MAX_OUTPUT_CHARS ? trailing.slice(-MAX_OUTPUT_CHARS) : trailing;
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
		// The stream's bounded output INCLUDING its own trailing whitespace. Trailing-vs-
		// internal is decided by the COMBINER (stdout's trailing whitespace is internal when
		// stderr has content), so this stream cannot trim it away on its own.
		full: () => tail + pendingWs,
		truncated: () => dropped,
		cancel: () => {
			void reader.cancel().catch(() => {});
		},
	};
}

// Combine the two bounded streams into the recorded output, reproducing the old
// boundedTail(stdout + stderr): concatenate FIRST -- stdout's trailing whitespace is
// internal once stderr has content -- then trim the true trailing whitespace and keep the
// last MAX chars. Memory stays bounded because each stream already capped its contribution.
// The per-stream `truncated` flag still marks the case where a stream dropped content while
// streaming even though the trimmed combination fits (e.g. a huge log with a short tail).
function combineOutput(
	out: { full: () => string; truncated: () => boolean },
	err: { full: () => string; truncated: () => boolean },
): string {
	const trimmed = `${out.full()}${err.full()}`.trimEnd();
	if (trimmed.length > MAX_OUTPUT_CHARS) {
		return `...(output truncated to last ${MAX_OUTPUT_CHARS} chars)\n${trimmed.slice(trimmed.length - MAX_OUTPUT_CHARS)}`;
	}
	return out.truncated() || err.truncated()
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
	// The identity + execution context every result of this check carries, so the cwd and
	// applied timeout are recorded on every outcome path (start failure, timeout, exit).
	const meta = { ...base, cwd: opts.cwd, timeoutMs };
	const start = now();

	let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
	try {
		// Array form + no `env` option: argv straight to the process (no shell), child
		// inherits this process's environment unchanged. `detached` makes the child its own
		// process-group leader, so a timeout/abort can kill the WHOLE tree (its test workers,
		// spawned servers, ...) via a group signal, not just the direct process.
		proc = Bun.spawn([check.command, ...check.args], {
			cwd: opts.cwd,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			detached: true,
		});
	} catch (e) {
		return {
			...meta,
			status: "blocked",
			durationMs: now() - start,
			timedOut: false,
			output: `could not start: ${(e as Error).message}`,
		};
	}

	// Kill the check's whole process GROUP (the child leads its own group via `detached`),
	// so its descendants -- test workers, spawned servers -- die with it, not just the
	// direct process. SIGKILL is uncatchable. Ignore an "already gone" throw from a late
	// timer/abort.
	const safeKill = (): void => {
		try {
			process.kill(-proc.pid, "SIGKILL");
		} catch {
			// the group already exited; nothing to kill
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
		// Disarm the timeout NOW, synchronously, before the drain grace can run: the process
		// has exited, so a child still holding the pipe during the grace must not let the
		// timer fire and flip a clean exit into a false `blocked`/timedOut.
		clearTimeout(timer);
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
				...meta,
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
				...meta,
				status: "blocked",
				durationMs,
				timedOut: false,
				output: "cancelled before completion",
			};
		}
		return {
			...meta,
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
				cwd: opts.cwd,
				timeoutMs: check.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS,
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

// The reason recorded for a non-passing check: the bounded output tail when the process
// printed anything, else a synthesized note. A process can fail (or be blocked) while
// printing NOTHING -- `false` exits 1 with no output -- and an empty reason would leave
// the operator with no failure detail beyond the exit code, so name the exit code (or the
// bare status when even that is absent) instead of recording "".
function nonPassReason(r: CheckResult): string {
	if (r.output !== "") return r.output;
	if (r.exitCode !== undefined) return `exit ${r.exitCode} with no stdout or stderr output`;
	return `${r.status} with no output`;
}

// Map chit's executed results into the recorded LoopCheck shape: `command` carries the
// ground-truth argv, `name` the friendly label, and the execution metadata (cwd, elapsed,
// timeout, exit code) makes the run auditable. `reason` carries the bounded output tail
// for a non-passed check ONLY -- a passed check needs no reason, so the log keeps no large
// output tail for a check that succeeded.
export function checkResultsToLoopChecks(results: CheckResult[]): LoopCheck[] {
	return results.map((r) => {
		const check: LoopCheck = {
			command: r.command,
			status: r.status,
			cwd: r.cwd,
			elapsedMs: r.durationMs,
			timeoutMs: r.timeoutMs,
		};
		if (r.name !== undefined) check.name = r.name;
		if (r.exitCode !== undefined) check.exitCode = r.exitCode;
		if (r.status !== "passed") check.reason = nonPassReason(r);
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
