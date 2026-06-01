import type { AdapterUsage } from "@chit-run/core";
import type {
	AdapterCallRequest,
	AdapterCallResult,
	AdapterEvent,
	RuntimeAdapter,
} from "../runtime/types.ts";
import { findSensitiveValues, sanitize } from "./sanitize.ts";
import { nonNegInt } from "./usage.ts";

// Default hard ceiling for a single adapter call (15 minutes). Motivated by a
// real wedge where a child stayed alive at 0% CPU emitting nothing for 20+
// minutes, hanging the whole run.
const DEFAULT_CALL_TIMEOUT_MS = 15 * 60_000;

export interface CodexExecConfig {
	model?: string;
	reasoningEffort?: string;
	env?: Record<string, string>;
	// Hard per-call ceiling in ms. When the timer fires the child is killed and
	// the call rejects with a timeout error. Unset means DEFAULT_CALL_TIMEOUT_MS.
	callTimeoutMs?: number;
	// No-progress watchdog: kill the child if NO stdout arrives for this many ms,
	// catching a wedged session earlier than the hard ceiling. OFF by default
	// (undefined): legitimate reasoning waits on the model API with zero stdout
	// (a multi-second-plus silent gap), which is indistinguishable from a wedge
	// except by elapsed time, so this must exceed the longest expected quiet gap.
	// Opt in per agent (e.g. an unattended converge loop) rather than globally.
	noProgressTimeoutMs?: number;
}

interface CodexJsonEvent {
	type: string;
	thread_id?: string;
	item?: { id?: string; type?: string; text?: string };
	// Verified shape (codex-cli 0.135.0): a `turn.completed` event carries a
	// usage block. One exec emits a single turn.completed in practice (observed
	// even with a tool call), but parseJsonlStream sums across them defensively.
	// No cost is reported by this CLI.
	usage?: {
		input_tokens?: unknown;
		cached_input_tokens?: unknown;
		output_tokens?: unknown;
		reasoning_output_tokens?: unknown;
	};
}

// Codex sessions are opaque to the runtime; the adapter shapes them as
// { threadId: string }. Anything else (corrupt payload, future field shape)
// is treated as "no prior session" and triggers a fresh call rather than
// crashing the run.
function getCodexThreadId(session: unknown): string | undefined {
	if (typeof session !== "object" || session === null) return undefined;
	const obj = session as { threadId?: unknown };
	return typeof obj.threadId === "string" ? obj.threadId : undefined;
}

export class CodexExecAdapter implements RuntimeAdapter {
	constructor(private readonly config: CodexExecConfig) {}

	async call(req: AdapterCallRequest): Promise<AdapterCallResult> {
		const sensitive = findSensitiveValues(this.config.env);
		try {
			const priorThreadId = getCodexThreadId(req.session);
			const cmd = this.buildCommand(priorThreadId);

			const proc = Bun.spawn({
				cmd,
				cwd: req.cwd,
				env: { ...process.env, ...(this.config.env ?? {}) },
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
			});
			// Client cancellation: kill the child so it stops burning rather than
			// running orphaned. The caller discriminates on signal.aborted, not on
			// the thrown error, so this need not be a specific error type.
			const onAbort = () => proc.kill();
			req.signal?.addEventListener("abort", onAbort, { once: true });
			// Hard timeout watchdog: a wedged child (alive, no output) would
			// otherwise leave the awaits below pending forever. proc.kill() only
			// reaches the DIRECT child, not its descendant tree - same limitation
			// the cancel path above has; process-tree killing is out of scope.
			const timeoutMs = this.config.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
			let timedOut = false;
			const timer = setTimeout(() => {
				timedOut = true;
				proc.kill();
			}, timeoutMs);
			// No-progress watchdog: a separate, usually shorter clock that fires when
			// no stdout has arrived for noProgressTimeoutMs. armNoProgress() resets it
			// (called per stdout chunk), so it measures the gap since the last output.
			// Disabled when unset, so the default behavior is the hard timeout alone.
			const noProgressMs = this.config.noProgressTimeoutMs;
			let noProgress = false;
			let progressTimer: ReturnType<typeof setTimeout> | undefined;
			const armNoProgress = (): void => {
				if (noProgressMs === undefined) return;
				if (progressTimer) clearTimeout(progressTimer);
				progressTimer = setTimeout(() => {
					noProgress = true;
					proc.kill();
				}, noProgressMs);
			};
			const disarmNoProgress = (): void => {
				if (progressTimer) clearTimeout(progressTimer);
				progressTimer = undefined;
			};
			try {
				proc.stdin.write(req.input);
				proc.stdin.end();
				// Start the no-progress clock now, so a child that emits nothing at all
				// is still caught. It is disarmed the moment stdout closes (below).
				armNoProgress();

				const [stdoutText, stderrText, exitCode] = await Promise.all([
					// Read stdout incrementally, surfacing each JSONL line to onEvent AS IT
					// ARRIVES (codex flushes events live, e.g. thread.started early then
					// turn.completed seconds later), so audit timestamps reflect real
					// arrival, not a single post-exit flush. Returns the full text for the
					// parse below; always drains stdout (the parse needs it and an undrained
					// pipe blocks the child). A run that emits events then fails still
					// preserves them, since each line is surfaced as it is read. armNoProgress
					// resets the no-progress watchdog on each chunk; disarm once stdout
					// closes so the child's exit delay never trips it.
					readCodexStdout(proc.stdout, req.onEvent, armNoProgress).finally(disarmNoProgress),
					new Response(proc.stderr).text(),
					proc.exited,
				]);

				// A killed proc exits non-zero; check abort/timeout/no-progress first so
				// none is misreported as a normal failure. Each kills the child but
				// produces a distinct error.
				if (req.signal?.aborted) throw new Error("aborted by client");
				if (timedOut) throw new Error(`codex exec timed out after ${timeoutMs}ms`);
				if (noProgress) throw new Error(`codex exec made no progress for ${noProgressMs}ms`);

				if (exitCode !== 0) {
					const cleaned = sanitize(stderrText || stdoutText, sensitive);
					const tail = cleaned.trim().split("\n").slice(-5).join("\n");
					throw new Error(`codex exec exited ${exitCode}: ${tail.slice(0, 500)}`);
				}

				const { threadId: newThreadId, agentText, usage } = parseJsonlStream(stdoutText);
				if (!agentText) {
					throw new Error("no agent_message in codex output");
				}

				// On resume, codex doesn't always re-emit thread.started; preserve the
				// prior id so the coordinator can still reach the session next time.
				const effectiveThreadId = newThreadId ?? priorThreadId;
				return {
					output: agentText,
					session: effectiveThreadId ? { threadId: effectiveThreadId } : undefined,
					...(usage && { usage }),
				};
			} finally {
				clearTimeout(timer);
				disarmNoProgress();
				req.signal?.removeEventListener("abort", onAbort);
			}
		} catch (e) {
			const message = sanitize((e as Error).message || String(e), sensitive);
			throw new Error(message);
		}
	}

	private buildCommand(priorThreadId: string | undefined): string[] {
		// `codex exec resume` accepts --skip-git-repo-check (verified against the
		// real CLI). Without it, resume fails outside a trusted git directory
		// with "Not inside a trusted directory". It does NOT accept --sandbox
		// (the sandbox setting is inherited from the original session config),
		// and -m / -c are also dropped: resume inherits the original model and
		// reasoning effort; passing them on resume errors in some codex versions.
		if (priorThreadId) {
			return ["codex", "exec", "resume", "--json", "--skip-git-repo-check", priorThreadId, "-"];
		}

		const cmd = ["codex", "exec", "--json"];
		if (this.config.model) cmd.push("-m", this.config.model);
		if (this.config.reasoningEffort) {
			cmd.push("-c", `model_reasoning_effort="${this.config.reasoningEffort}"`);
		}
		cmd.push("--sandbox", "read-only", "--skip-git-repo-check", "-");
		return cmd;
	}
}

// Read codex's stdout to completion, returning the full text for the parse while
// surfacing each parseable JSONL line to onEvent AS IT ARRIVES. This preserves
// the observable Codex event stream (tool calls, command executions, reasoning
// summaries), not just the final answer, with real arrival timing. onEvent is
// optional: an unaudited run does no per-line work and just accumulates the
// text. Lines split on "\n"; a final line with no trailing newline is still
// surfaced. Each line is emitted as it is read, before the caller's failure
// checks, so a run that emits events then fails still preserves them.
async function readCodexStdout(
	stream: ReadableStream<Uint8Array>,
	onEvent: ((event: AdapterEvent) => void) | undefined,
	onProgress?: () => void,
): Promise<string> {
	const decoder = new TextDecoder();
	let full = "";
	let pending = "";
	const emitLine = (raw: string): void => {
		const trimmed = raw.trim();
		if (!trimmed) return;
		let evt: { type?: unknown };
		try {
			evt = JSON.parse(trimmed) as { type?: unknown };
		} catch {
			return;
		}
		if (typeof evt.type !== "string") return;
		// Observational: a caller's onEvent that throws must not abort the stdout
		// drain, the parse, or the run (same best-effort principle as the audit
		// recorder's writes). Swallow so live reading is as safe as a post-read pass.
		try {
			onEvent?.({ type: evt.type, raw: trimmed });
		} catch {
			// ignore: a misbehaving observer never breaks the run
		}
	};
	const drainCompleteLines = (): void => {
		let nl = pending.indexOf("\n");
		while (nl !== -1) {
			emitLine(pending.slice(0, nl));
			pending = pending.slice(nl + 1);
			nl = pending.indexOf("\n");
		}
	};
	for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
		// Stdout arrived: reset the no-progress watchdog regardless of audit (this
		// is a liveness signal, not an event-recording one).
		onProgress?.();
		const text = decoder.decode(chunk, { stream: true });
		if (!text) continue;
		full += text;
		// Unaudited runs skip all line work; they only need the accumulated text.
		if (!onEvent) continue;
		pending += text;
		drainCompleteLines();
	}
	const tail = decoder.decode();
	if (tail) full += tail;
	if (onEvent) {
		if (tail) pending += tail;
		drainCompleteLines();
		if (pending.trim()) emitLine(pending);
	}
	return full;
}

function parseJsonlStream(stdout: string): {
	threadId?: string;
	agentText?: string;
	usage?: AdapterUsage;
} {
	let threadId: string | undefined;
	let agentText: string | undefined;
	// Accumulate usage across turn.completed events, per field. A field is summed
	// only across turns where it appears, and stays ABSENT if no turn reported it
	// (an absent field is not the same as zero). One turn is the observed case.
	const sum: { input?: number; cached?: number; output?: number; reasoning?: number } = {};
	// Only non-negative integers count; an invalid field is dropped so the summed
	// usage always satisfies the AdapterUsage schema invariants.
	const add = (key: keyof typeof sum, val: unknown): void => {
		const n = nonNegInt(val);
		if (n !== undefined) sum[key] = (sum[key] ?? 0) + n;
	};
	for (const line of stdout.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		let evt: CodexJsonEvent;
		try {
			evt = JSON.parse(trimmed) as CodexJsonEvent;
		} catch {
			continue;
		}
		if (evt.type === "thread.started" && typeof evt.thread_id === "string") {
			threadId = evt.thread_id;
		}
		if (
			evt.type === "item.completed" &&
			evt.item?.type === "agent_message" &&
			typeof evt.item.text === "string"
		) {
			agentText = evt.item.text;
		}
		if (evt.type === "turn.completed" && evt.usage) {
			add("input", evt.usage.input_tokens);
			add("cached", evt.usage.cached_input_tokens);
			add("output", evt.usage.output_tokens);
			add("reasoning", evt.usage.reasoning_output_tokens);
		}
	}
	const usage: AdapterUsage = {};
	if (sum.input !== undefined) usage.inputTokens = sum.input;
	if (sum.cached !== undefined) usage.cachedInputTokens = sum.cached;
	if (sum.output !== undefined) usage.outputTokens = sum.output;
	if (sum.reasoning !== undefined) usage.reasoningTokens = sum.reasoning;
	return {
		threadId,
		agentText,
		usage: Object.keys(usage).length > 0 ? usage : undefined,
	};
}
