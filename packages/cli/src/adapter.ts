// The one seam between the product model and a real model call. Keeping it a
// narrow interface is what lets the run flow be tested with a fake (no network,
// no cost, deterministic) while the bin wires the real one.
//
// The real adapter shells out to the already-installed `claude` CLI rather than
// reimplementing an HTTP client or managing API keys -- the whole point of the
// proof is the product shape, not a new runtime.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentConfig } from "./config.ts";
import type { Filesystem } from "./manifest.ts";
import { spawnCapture } from "./proc.ts";

export interface AdapterRequest {
	// The participant's agent id (a profile, e.g. "builder"). The dispatcher resolves
	// it to a configured adapter + model; an underlying adapter just records it.
	agent: string;
	// Resolved model for this call (from the agent's config); undefined / "default"
	// means the adapter's default model.
	model?: string;
	// Resolved profile options. They are adapter-specific and validated before the
	// run starts; adapters that do not understand a field simply never receive it.
	effort?: "low" | "medium" | "high" | "max";
	reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh";
	instructions: string;
	prompt: string;
	// Surfaced and passed through so the model is explicit, but NOT yet sandboxed
	// in this proof -- enforcement is the hardened runtime's job.
	filesystem: Filesystem;
	cwd: string;
	// Per-call timeout (ms) the executor derives from the routine's limits; the call
	// is killed past it. Undefined means no bound (the routine opted out with "none").
	timeoutMs?: number;
	// Operator-cancellation signal. When it aborts, the in-flight call is killed so a
	// Ctrl-C stops promptly rather than waiting out the timeout.
	signal?: AbortSignal;
}

export interface AdapterResult {
	output: string;
}

export interface Adapter {
	call(req: AdapterRequest): Promise<AdapterResult>;
}

// Records calls and returns a canned reply, for deterministic tests.
export interface FakeAdapter extends Adapter {
	calls: AdapterRequest[];
}

export function fakeAdapter(reply: (req: AdapterRequest) => string = () => "ok"): FakeAdapter {
	const calls: AdapterRequest[] = [];
	return {
		calls,
		async call(req) {
			calls.push(req);
			return { output: reply(req) };
		},
	};
}

export function claudeCliArgs(req: Pick<AdapterRequest, "model" | "filesystem" | "effort">): string[] {
	const permission =
		req.filesystem === "read-write"
			? ["--permission-mode", "acceptEdits"]
			: req.filesystem === "read-only"
				? ["--permission-mode", "default", "--disallowedTools", "Edit", "Write", "NotebookEdit", "Bash"]
				: ["--tools", ""];
	// `--model` and `--effort` go BEFORE the permission flags: the read-only mapping
	// ends in a variadic `--disallowedTools`, which would otherwise swallow later args.
	const model = req.model !== undefined && req.model !== "default" ? ["--model", req.model] : [];
	const effort = req.effort !== undefined ? ["--effort", req.effort] : [];
	return ["claude", "-p", ...model, ...effort, ...permission];
}

// The real claude adapter. Composes instructions + prompt and pipes them to `claude -p`
// (print mode: one non-interactive response, then exit), reading stdout as the
// participant's output. Runs in the routine's cwd. For write-capable participants
// we use acceptEdits, but live converge passes a sandbox cwd, never the caller cwd.
// The agent id is not checked here -- the dispatcher only routes "claude"-adapter
// agents to this adapter.
export const claudeCliAdapter: Adapter = {
	async call(req) {
		const composed = `${req.instructions}\n\n---\n\n${req.prompt}`;
		// filesystem -> claude permission:
		//   read-write -> acceptEdits (auto-apply edits; converge passes a sandbox cwd).
		//   read-only  -> default mode with every WRITE tool disallowed (Edit/Write/NotebookEdit
		//                 AND Bash -- a shell can `echo > file`, so leaving it in made read-only
		//                 not actually read-only). The model still inspects via Read/Grep/Glob/LS
		//                 and answers NORMALLY. NOT plan mode -- plan mode is the plan-then-approve
		//                 flow and under `-p` it can route its answer through ExitPlanMode, yielding
		//                 empty stdout (a real composed flow saw a planning step produce 0 chars).
		//   none       -> no tools at all.
		const args = claudeCliArgs(req);
		const r = await spawnCapture(args, {
			cwd: req.cwd,
			stdin: composed,
			...(req.timeoutMs !== undefined && { timeoutMs: req.timeoutMs }),
			...(req.signal !== undefined && { signal: req.signal }),
		});
		if (r.aborted) {
			throw new Error("claude call cancelled");
		}
		if (r.timedOut) {
			throw new Error(`claude call timed out after ${req.timeoutMs}ms`);
		}
		if (r.exitCode !== 0) {
			throw new Error(`claude exited ${r.exitCode}: ${r.stderr.trim() || "(no stderr)"}`);
		}
		return { output: r.stdout.trim() };
	},
};

export function codexCliArgs(req: Pick<AdapterRequest, "model" | "filesystem" | "reasoningEffort">, outFile: string): string[] {
	const sandbox = req.filesystem === "read-write" ? "workspace-write" : "read-only";
	const model = req.model !== undefined && req.model !== "default" ? ["--model", req.model] : [];
	const reasoning =
		req.reasoningEffort !== undefined ? ["-c", `model_reasoning_effort="${req.reasoningEffort}"`] : [];
	return ["codex", "exec", "--sandbox", sandbox, "--skip-git-repo-check", "--ephemeral", ...model, ...reasoning, "-o", outFile, "-"];
}

// A second real adapter: the gemini CLI. Verified empirically (the same checks claude
// needed): `gemini -p` returns its answer on stdout; `--approval-mode plan` is genuinely
// read-only -- it returns output AND cannot write a file (unlike claude's plan mode it
// does not blank stdout); `--approval-mode yolo` auto-approves writes. `--skip-trust` is
// required to run headless. `--model` selects the model (omitted for the default).
export const geminiCliAdapter: Adapter = {
	async call(req) {
		const composed = `${req.instructions}\n\n---\n\n${req.prompt}`;
		// filesystem -> approval mode: read-write auto-approves edits (yolo); read-only and
		// none use plan (read-only -- returns output but cannot modify the tree).
		const approval = req.filesystem === "read-write" ? ["--approval-mode", "yolo"] : ["--approval-mode", "plan"];
		const model = req.model !== undefined && req.model !== "default" ? ["--model", req.model] : [];
		const args = ["gemini", "--skip-trust", ...model, ...approval, "-p", composed];
		const r = await spawnCapture(args, {
			cwd: req.cwd,
			...(req.timeoutMs !== undefined && { timeoutMs: req.timeoutMs }),
			...(req.signal !== undefined && { signal: req.signal }),
		});
		if (r.aborted) {
			throw new Error("gemini call cancelled");
		}
		if (r.timedOut) {
			throw new Error(`gemini call timed out after ${req.timeoutMs}ms`);
		}
		if (r.exitCode !== 0) {
			throw new Error(`gemini exited ${r.exitCode}: ${r.stderr.trim() || "(no stderr)"}`);
		}
		return { output: r.stdout.trim() };
	},
};

// A third real adapter: the codex CLI. Uses `codex exec` (the non-interactive surface)
// and reads the FINAL message from `--output-last-message` (a clean single-message file),
// NOT stdout -- stdout carries progress + a token-count footer, so parsing it is fragile.
// Verified empirically against codex-cli 0.139.0:
//   read-only      -> --sandbox read-only      (returns text; CANNOT write -- confirmed)
//   read-write     -> --sandbox workspace-write (writes in the cwd; converge passes a sandbox
//                     worktree, so codex's sandbox is a second boundary, not the primary one)
//   none           -> rejected: codex exec has no true no-tools mode, and mapping it to
//                     read-only would silently grant fs read that `none` promises to withhold.
// `--skip-git-repo-check` lets a read-only call run in a non-repo cwd (e.g. a grilling temp dir);
// `--ephemeral` keeps no session history; `--model` selects a model (omitted for the default).
export const codexCliAdapter: Adapter = {
	async call(req) {
		if (req.filesystem === "none") {
			throw new Error('codex has no no-tools mode, so a `filesystem: "none"` participant cannot use the codex adapter (use read-only, or bind it to another adapter)');
		}
		const composed = `${req.instructions}\n\n---\n\n${req.prompt}`;
		// One ephemeral temp dir per call for the final-message file; removed in `finally`.
		const dir = mkdtempSync(join(tmpdir(), "chit-codex-"));
		const outFile = join(dir, "last.txt");
		try {
			const args = ["codex", "exec", "--cd", req.cwd, ...codexCliArgs(req, outFile).slice(2)];
			const r = await spawnCapture(args, {
				cwd: req.cwd,
				stdin: composed,
				...(req.timeoutMs !== undefined && { timeoutMs: req.timeoutMs }),
				...(req.signal !== undefined && { signal: req.signal }),
			});
			if (r.aborted) {
				throw new Error("codex call cancelled");
			}
			if (r.timedOut) {
				throw new Error(`codex call timed out after ${req.timeoutMs}ms`);
			}
			if (r.exitCode !== 0) {
				throw new Error(`codex exited ${r.exitCode}: ${r.stderr.trim() || "(no stderr)"}`);
			}
			// The final message is in the -o file; fall back to stdout only if it is absent.
			let output: string;
			try {
				output = readFileSync(outFile, "utf-8").trim();
			} catch {
				output = r.stdout.trim();
			}
			return { output };
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	},
};

// A registry of real adapters keyed by adapter type (the `adapter` field of an
// agent config). The bin wires { claude, gemini, codex }; adding another backend is one
// more entry, not a redesign.
export type AdapterRegistry = Record<string, Adapter>;

// The binding seam: the executors call ONE adapter (this one). It resolves each
// call's agent id to the configured adapter + model, then routes to the real adapter.
// Errors here are config errors -- an unknown agent id, or an adapter type that is
// named in the config but not wired into the registry.
export function dispatchingAdapter(agents: Record<string, AgentConfig>, registry: AdapterRegistry): Adapter {
	return {
		async call(req) {
			const agentCfg = agents[req.agent];
			if (agentCfg === undefined) {
				throw new Error(`no agent "${req.agent}" is configured (add it under "agents" in chit.config.json)`);
			}
			const adapter = registry[agentCfg.adapter];
			if (adapter === undefined) {
				throw new Error(
					`agent "${req.agent}" uses adapter "${agentCfg.adapter}", which is not available (wired adapters: ${Object.keys(registry).join(", ") || "none"})`,
				);
			}
			return adapter.call({
				...req,
				...(agentCfg.model !== undefined && { model: agentCfg.model }),
				...(agentCfg.effort !== undefined && { effort: agentCfg.effort }),
				...(agentCfg.reasoningEffort !== undefined && { reasoningEffort: agentCfg.reasoningEffort }),
			});
		},
	};
}
