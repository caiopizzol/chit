import type { AdapterCallRequest, AdapterCallResult, RuntimeAdapter } from "../runtime/types.ts";
import { findSensitiveValues, sanitize } from "./sanitize.ts";

export interface CodexExecConfig {
	model?: string;
	reasoningEffort?: string;
	env?: Record<string, string>;
}

interface CodexJsonEvent {
	type: string;
	thread_id?: string;
	item?: { id?: string; type?: string; text?: string };
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
			try {
				proc.stdin.write(req.input);
				proc.stdin.end();

				const [stdoutText, stderrText, exitCode] = await Promise.all([
					new Response(proc.stdout).text(),
					new Response(proc.stderr).text(),
					proc.exited,
				]);

				// A killed proc exits non-zero; check abort first so cancellation is
				// not misreported as a normal failure.
				if (req.signal?.aborted) throw new Error("aborted by client");

				if (exitCode !== 0) {
					const cleaned = sanitize(stderrText || stdoutText, sensitive);
					const tail = cleaned.trim().split("\n").slice(-5).join("\n");
					throw new Error(`codex exec exited ${exitCode}: ${tail.slice(0, 500)}`);
				}

				const { threadId: newThreadId, agentText } = parseJsonlStream(stdoutText);
				if (!agentText) {
					throw new Error("no agent_message in codex output");
				}

				// On resume, codex doesn't always re-emit thread.started; preserve the
				// prior id so the coordinator can still reach the session next time.
				const effectiveThreadId = newThreadId ?? priorThreadId;
				return {
					output: agentText,
					session: effectiveThreadId ? { threadId: effectiveThreadId } : undefined,
				};
			} finally {
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

function parseJsonlStream(stdout: string): { threadId?: string; agentText?: string } {
	let threadId: string | undefined;
	let agentText: string | undefined;
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
	}
	return { threadId, agentText };
}
