import type { AdapterUsage, FilesystemPermission } from "@chit-run/core";
import type {
	AdapterCallRequest,
	AdapterCallResult,
	AdapterEvent,
	RuntimeAdapter,
} from "../runtime/types.ts";
import { findSensitiveValues, sanitize } from "./sanitize.ts";
import { nonNegInt, nonNegNum } from "./usage.ts";

// Default hard ceiling for a single adapter call (15 minutes). Motivated by a
// real wedge where a child stayed alive at 0% CPU emitting nothing for 20+
// minutes, hanging the whole run.
const DEFAULT_CALL_TIMEOUT_MS = 15 * 60_000;

export interface ClaudeCliConfig {
	model?: string;
	// Maps to claude's `--effort <level>` flag. Named reasoningEffort to match the
	// registry field and CodexExecConfig (codex spells the same idea
	// model_reasoning_effort). The valid level set varies by claude version, so the
	// value is passed through unvalidated; the CLI rejects an unknown level clearly.
	reasoningEffort?: string;
	passModelOnResume?: boolean;
	env?: Record<string, string>;
	// Hard per-call ceiling in ms. When the timer fires the child is killed and
	// the call rejects with a timeout error. Unset means DEFAULT_CALL_TIMEOUT_MS.
	callTimeoutMs?: number;
	// No-progress watchdog: kill the child if NO stdout arrives for this many ms,
	// catching a wedged session earlier than the hard ceiling. OFF by default
	// (undefined): legitimate reasoning waits on the model API with zero stdout,
	// indistinguishable from a wedge except by elapsed time, so this must exceed
	// the longest expected quiet gap. Opt in per agent rather than globally.
	noProgressTimeoutMs?: number;
	// Strict MCP isolation: by default the spawned `claude --print` is launched
	// with --strict-mcp-config and an empty MCP config, so it loads NONE of the
	// user's global MCP servers (the session reports mcp_servers: []). This does
	// NOT disable Claude's built-in tools, and it does NOT stop the user's local
	// hooks/skills/plugins (a live stream-json probe still shows hook events) -
	// only MCP server config is isolated. A safety boundary now that `chit
	// converge` lets Claude edit autonomously. Opt out (set false) only for a
	// user-defined advisor that genuinely needs MCP.
	strictMcp?: boolean;
}

interface ClaudePrintResult {
	session_id?: string;
	result?: string;
	is_error?: boolean;
	subtype?: string;
	// Verified shape (claude 2.1.x stream-json): the FINAL `result` event carries
	// a top-level `usage` block plus an authoritative `total_cost_usd`. Read
	// tolerantly: the CLI may add/rename fields across versions, and any absent
	// field is omitted.
	usage?: {
		input_tokens?: unknown;
		output_tokens?: unknown;
		cache_read_input_tokens?: unknown;
	};
	total_cost_usd?: unknown;
}

// Extract token/cost usage from a claude --print result, tolerantly. Returns a
// partial AdapterUsage with only the fields the CLI actually reported, or
// undefined if it reported none. claude already aggregates usage across its
// internal turns, so the top-level block is the per-call total (no summing).
//
// cachedInputTokens maps to cache_read_input_tokens (input served from cache).
// cache_creation_input_tokens is intentionally not surfaced as a token field;
// its cost is already captured in the authoritative total_cost_usd. No total or
// reasoning token is reported by this CLI, so those stay absent rather than
// guessed.
function extractClaudeUsage(parsed: ClaudePrintResult): AdapterUsage | undefined {
	const usage: AdapterUsage = {};
	const u = parsed.usage;
	if (u) {
		const input = nonNegInt(u.input_tokens);
		if (input !== undefined) usage.inputTokens = input;
		const output = nonNegInt(u.output_tokens);
		if (output !== undefined) usage.outputTokens = output;
		const cached = nonNegInt(u.cache_read_input_tokens);
		if (cached !== undefined) usage.cachedInputTokens = cached;
	}
	const cost = nonNegNum(parsed.total_cost_usd);
	if (cost !== undefined) usage.estimatedCostUsd = cost;
	return Object.keys(usage).length > 0 ? usage : undefined;
}

// Claude sessions are opaque to the runtime; the adapter shapes them as
// { sessionId: string }. Anything else is treated as "no prior session" so
// corrupt state files don't break runs.
function getClaudeSessionId(session: unknown): string | undefined {
	if (typeof session !== "object" || session === null) return undefined;
	const obj = session as { sessionId?: unknown };
	return typeof obj.sessionId === "string" ? obj.sessionId : undefined;
}

export class ClaudeCliAdapter implements RuntimeAdapter {
	constructor(private readonly config: ClaudeCliConfig) {}

	async call(req: AdapterCallRequest): Promise<AdapterCallResult> {
		const sensitive = findSensitiveValues(this.config.env);
		try {
			const priorSessionId = getClaudeSessionId(req.session);
			const cmd = this.buildCommand(priorSessionId, req.filesystem);

			// CLAUDECODE=0 prevents the spawned claude from detecting it's running
			// inside Claude Code, which would trigger recursive harness behavior.
			// Force-applied AFTER config.env so user config can't accidentally
			// disable the guard.
			const proc = Bun.spawn({
				cmd,
				cwd: req.cwd,
				env: { ...process.env, ...(this.config.env ?? {}), CLAUDECODE: "0" },
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
					// Read stdout incrementally, surfacing each stream-json line to onEvent
					// AS IT ARRIVES (claude streams system/stream_event deltas, then the
					// assistant message, then the result), so audit timestamps reflect real
					// arrival, not a single post-exit flush. Returns the full text for the
					// parse below; always drains stdout (the parse needs it and an undrained
					// pipe blocks the child). A run that emits events then fails still
					// preserves them, since each line is surfaced as it is read. armNoProgress
					// resets the no-progress watchdog on each chunk; disarm once stdout
					// closes so the child's exit delay never trips it.
					readClaudeStdout(proc.stdout, req.onEvent, armNoProgress).finally(disarmNoProgress),
					new Response(proc.stderr).text(),
					proc.exited,
				]);

				// A killed proc exits non-zero; check abort/timeout first so neither is
				// misreported as a normal failure. External cancel and timeout both
				// kill the child but produce distinct errors.
				if (req.signal?.aborted) throw new Error("aborted by client");
				if (timedOut) throw new Error(`claude --print timed out after ${timeoutMs}ms`);
				if (noProgress) throw new Error(`claude --print made no progress for ${noProgressMs}ms`);

				if (exitCode !== 0) {
					// Rate limiting is the common nonzero exit in practice. Surface a concise,
					// operator-friendly error instead of dumping the raw stderr/stdout tail
					// (which is often a multi-line API error blob). The raw rate_limit_event
					// stays in the audit (onEvent recorded it live as it arrived); this only
					// shapes the thrown failure string.
					const rateLimit = detectClaudeRateLimit(`${stdoutText}\n${stderrText}`);
					if (rateLimit !== undefined) {
						throw new Error(
							`claude --print rate limited${rateLimit ? `: ${rateLimit}` : ` (exit ${exitCode})`}`,
						);
					}
					const cleaned = sanitize(stderrText || stdoutText, sensitive);
					const tail = cleaned.trim().split("\n").slice(-5).join("\n");
					throw new Error(`claude --print exited ${exitCode}: ${tail.slice(0, 500)}`);
				}

				const parsed = parseClaudeResult(stdoutText);
				if (!parsed) {
					throw new Error("claude stream produced no result event");
				}

				if (parsed.is_error || parsed.subtype !== "success") {
					throw new Error(
						parsed.result ?? `claude returned non-success subtype: ${parsed.subtype ?? "unknown"}`,
					);
				}
				if (!parsed.result) {
					throw new Error("claude --print returned no result field");
				}

				const effectiveSessionId = parsed.session_id ?? priorSessionId;
				const usage = extractClaudeUsage(parsed);
				return {
					output: parsed.result,
					session: effectiveSessionId ? { sessionId: effectiveSessionId } : undefined,
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

	private buildCommand(
		priorSessionId: string | undefined,
		filesystem: FilesystemPermission | undefined,
	): string[] {
		// stream-json requires --verbose alongside --print (verified against the
		// installed claude). --include-partial-messages surfaces the incremental
		// stream_event deltas so the audit layer preserves the full observable
		// event stream, not just the final result event.
		const cmd = [
			"claude",
			"--print",
			"--verbose",
			"--output-format",
			"stream-json",
			"--include-partial-messages",
		];
		// Filesystem read_only enforcement: plan mode blocks every write (file
		// edits AND write-capable Bash) while still allowing reads and read-only
		// shell. This is a Claude plan-mode PERMISSION, not an OS/filesystem
		// sandbox. Only added for read_only; the permissive "write" default (and an
		// omitted permission) keep today's behavior, where claude can write.
		// Verified against claude 2.1.98, which supports `--permission-mode plan`.
		if (filesystem === "read_only") {
			cmd.push("--permission-mode", "plan");
		}
		// Strict MCP isolation (default on): --strict-mcp-config makes Claude use
		// ONLY the inline config we pass, ignoring the user's global ~/.claude.json
		// and project MCP; the empty {"mcpServers":{}} means zero MCP servers. This
		// isolates MCP servers only: Claude's built-in tools still work, and the
		// user's local hooks/skills/plugins still fire (a stream-json probe shows
		// hook events even under strict MCP). Opt out via strictMcp:false.
		if (this.config.strictMcp !== false) {
			cmd.push("--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}');
		}
		// claude's --effort is per-invocation ("for the current session"), so unlike
		// codex (which drops -m/-c on resume) it is passed on EVERY call, resume
		// included (verified: --effort is accepted alongside --resume). The level is
		// passed through; the CLI validates it and errors clearly on an unknown one.
		if (this.config.reasoningEffort) {
			cmd.push("--effort", this.config.reasoningEffort);
		}
		if (priorSessionId) {
			cmd.push("--resume", priorSessionId);
			// Custom endpoints (Ollama, etc.) drop the model on resume and default
			// to claude-sonnet-* which the endpoint doesn't know about. Opt-in via
			// passModelOnResume so the model is re-asserted on every resume call.
			if (this.config.passModelOnResume && this.config.model) {
				cmd.push("--model", this.config.model);
			}
		} else if (this.config.model) {
			cmd.push("--model", this.config.model);
		}
		return cmd;
	}
}

// Read claude's stdout to completion, returning the full text for the parse
// while surfacing each parseable stream-json line to onEvent AS IT ARRIVES. This
// preserves the observable Claude event stream (system, stream_event deltas,
// assistant, rate_limit_event, result), not just the final answer, with real
// arrival timing. onEvent is optional: an unaudited run does no per-line work and
// just accumulates the text. Lines split on "\n"; a final line with no trailing
// newline is still surfaced. Each line is emitted as it is read, before the
// caller's failure checks, so a run that emits events then fails still preserves
// them. A caller's onEvent that throws is swallowed (observational), so it never
// aborts the stdout drain or fails the run.
async function readClaudeStdout(
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

// Scan the JSONL stream for the FINAL `result` event, which carries the same
// fields the single-JSON mode used to return wholesale (is_error, subtype,
// result, session_id, usage, total_cost_usd). Returns undefined when no result
// event is present so the caller can throw a clear error. Unparseable lines are
// skipped.
function parseClaudeResult(stdout: string): ClaudePrintResult | undefined {
	let result: ClaudePrintResult | undefined;
	for (const line of stdout.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		let evt: { type?: unknown };
		try {
			evt = JSON.parse(trimmed) as { type?: unknown };
		} catch {
			continue;
		}
		if (evt.type === "result") result = evt as ClaudePrintResult;
	}
	return result;
}

// A claude stream-json rate-limit event, read tolerantly. claude surfaces
// throttling as a `rate_limit_event`; the rate-limit detail may sit in a nested
// `rate_limit` object or at the top level depending on CLI version, so both are
// checked. Only a small set of known scalar fields is read.
interface RateLimitEvent {
	type?: unknown;
	rate_limit?: { status?: unknown; resetsAt?: unknown; retryAfter?: unknown };
	rate_limit_info?: {
		status?: unknown;
		resetsAt?: unknown;
		retryAfter?: unknown;
		resetInSeconds?: unknown;
		isUsingOverage?: unknown;
	};
	status?: unknown;
	resetsAt?: unknown;
	retryAfter?: unknown;
	resetInSeconds?: unknown;
	isUsingOverage?: unknown;
}

// Scan the stream for a rate-limit event and return a CONCISE detail string for
// the operator-facing error (e.g. "status=rejected, resets 2026-06-01T12:00:00Z"),
// "" when a rate-limit event is present but carries no usable detail, or
// undefined when there is no rate-limit event at all. It deliberately extracts
// only known scalar fields rather than echoing the JSON, so the thrown message
// can never balloon into a raw event dump. The last event wins (a later,
// definitive event overrides an earlier warning).
function detectClaudeRateLimit(stdout: string): string | undefined {
	const pickStr = (v: unknown): string | undefined =>
		typeof v === "string" && v.trim() !== ""
			? v.trim().replace(/\s+/g, " ").slice(0, 120)
			: undefined;
	const pickNum = (v: unknown): number | undefined =>
		typeof v === "number" && Number.isFinite(v) ? v : undefined;
	let found = false;
	let detail = "";
	for (const line of stdout.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		let evt: RateLimitEvent;
		try {
			evt = JSON.parse(trimmed) as RateLimitEvent;
		} catch {
			continue;
		}
		if (evt.type !== "rate_limit_event") continue;
		found = true;
		const rl: RateLimitEvent =
			evt.rate_limit_info && typeof evt.rate_limit_info === "object"
				? evt.rate_limit_info
				: evt.rate_limit && typeof evt.rate_limit === "object"
					? evt.rate_limit
					: evt;
		const parts: string[] = [];
		const status = pickStr(rl.status);
		if (status) parts.push(`status=${status}`);
		const resetsAt = pickStr(rl.resetsAt);
		if (resetsAt) parts.push(`resets ${resetsAt}`);
		const retryAfter = pickNum(rl.retryAfter) ?? pickNum(rl.resetInSeconds);
		if (retryAfter !== undefined) parts.push(`retry after ${retryAfter}s`);
		if (rl.isUsingOverage === false) parts.push("overage disabled");
		detail = parts.join(", ");
	}
	return found ? detail : undefined;
}
