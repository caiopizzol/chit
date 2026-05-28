import type { AdapterCallRequest, AdapterCallResult, RuntimeAdapter } from "../runtime/types.ts";
import { findSensitiveValues, sanitize } from "./sanitize.ts";

export interface ClaudeCliConfig {
	model?: string;
	passModelOnResume?: boolean;
	env?: Record<string, string>;
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
			proc.stdin.write(req.input);
			proc.stdin.end();

			const [stdoutText, stderrText, exitCode] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
				proc.exited,
			]);

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
		} catch (e) {
			const message = sanitize((e as Error).message || String(e), sensitive);
			throw new Error(message);
		}
	}

	private buildCommand(priorSessionId: string | undefined): string[] {
		const cmd = ["claude", "--print", "--output-format", "json"];
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
