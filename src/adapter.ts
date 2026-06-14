// The one seam between the product model and a real model call. Keeping it a
// narrow interface is what lets the run flow be tested with a fake (no network,
// no cost, deterministic) while the bin wires the real one.
//
// The real adapter shells out to the already-installed `claude` CLI rather than
// reimplementing an HTTP client or managing API keys -- the whole point of the
// proof is the product shape, not a new runtime.

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
		const permission =
			req.filesystem === "read-write"
				? ["--permission-mode", "acceptEdits"]
				: req.filesystem === "read-only"
					? ["--permission-mode", "default", "--disallowedTools", "Edit", "Write", "NotebookEdit", "Bash"]
					: ["--tools", ""];
		// `--model` goes BEFORE the permission flags: the read-only mapping ends in a
		// variadic `--disallowedTools`, which would otherwise swallow the model args.
		const model = req.model !== undefined && req.model !== "default" ? ["--model", req.model] : [];
		const args = ["claude", "-p", ...model, ...permission];
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

// A registry of real adapters keyed by adapter type (the `adapter` field of an
// agent config). The bin wires { claude: claudeCliAdapter }; adding another backend
// is one more entry, not a redesign.
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
			return adapter.call({ ...req, ...(agentCfg.model !== undefined && { model: agentCfg.model }) });
		},
	};
}
