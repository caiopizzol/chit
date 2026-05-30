import type { AdapterCallRequest, AdapterCallResult, RuntimeAdapter } from "../runtime/types.ts";
import { findSensitiveValues, sanitize } from "./sanitize.ts";

// Default hard ceiling for a single adapter call (15 minutes). Motivated by a
// real wedge where a child stayed alive at 0% CPU emitting nothing for 20+
// minutes, hanging the whole run.
const DEFAULT_CALL_TIMEOUT_MS = 15 * 60_000;

export interface ClaudeCliConfig {
	model?: string;
	passModelOnResume?: boolean;
	env?: Record<string, string>;
	// Hard per-call ceiling in ms. When the timer fires the child is killed and
	// the call rejects with a timeout error. Unset means DEFAULT_CALL_TIMEOUT_MS.
	callTimeoutMs?: number;
	// Strict MCP isolation: by default the spawned `claude --print` is launched
	// with --strict-mcp-config and an empty MCP config so it loads NONE of the
	// user's global MCP servers/tools/hooks. This is a safety boundary now that
	// `chit converge` lets Claude edit autonomously. Opt out (set false) only for
	// a user-defined advisor that genuinely needs MCP.
	strictMcp?: boolean;
}

interface ClaudePrintResult {
	session_id?: string;
	result?: string;
	is_error?: boolean;
	subtype?: string;
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
			const cmd = this.buildCommand(priorSessionId);

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
			try {
				proc.stdin.write(req.input);
				proc.stdin.end();

				const [stdoutText, stderrText, exitCode] = await Promise.all([
					new Response(proc.stdout).text(),
					new Response(proc.stderr).text(),
					proc.exited,
				]);

				// A killed proc exits non-zero; check abort/timeout first so neither is
				// misreported as a normal failure. External cancel and timeout both
				// kill the child but produce distinct errors.
				if (req.signal?.aborted) throw new Error("aborted by client");
				if (timedOut) throw new Error(`claude --print timed out after ${timeoutMs}ms`);

				if (exitCode !== 0) {
					const cleaned = sanitize(stderrText || stdoutText, sensitive);
					const tail = cleaned.trim().split("\n").slice(-5).join("\n");
					throw new Error(`claude --print exited ${exitCode}: ${tail.slice(0, 500)}`);
				}

				let parsed: ClaudePrintResult;
				try {
					parsed = JSON.parse(stdoutText.trim()) as ClaudePrintResult;
				} catch (e) {
					throw new Error(`claude --print output was not valid JSON: ${(e as Error).message}`);
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
				return {
					output: parsed.result,
					session: effectiveSessionId ? { sessionId: effectiveSessionId } : undefined,
				};
			} finally {
				clearTimeout(timer);
				req.signal?.removeEventListener("abort", onAbort);
			}
		} catch (e) {
			const message = sanitize((e as Error).message || String(e), sensitive);
			throw new Error(message);
		}
	}

	private buildCommand(priorSessionId: string | undefined): string[] {
		const cmd = ["claude", "--print", "--output-format", "json"];
		// Strict MCP isolation (default on): --strict-mcp-config makes Claude use
		// ONLY the inline config we pass, ignoring the user's global ~/.claude.json
		// and project MCP; the empty {"mcpServers":{}} means zero MCP servers. So a
		// chit-spawned autonomous Claude inherits none of the user's MCP
		// servers/tools/hooks. Opt out via strictMcp:false.
		if (this.config.strictMcp !== false) {
			cmd.push("--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}');
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
