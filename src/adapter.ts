// The one seam between the product model and a real model call. Keeping it a
// narrow interface is what lets the run flow be tested with a fake (no network,
// no cost, deterministic) while the bin wires the real one.
//
// The real adapter shells out to the already-installed `claude` CLI rather than
// reimplementing an HTTP client or managing API keys -- the whole point of the
// proof is the product shape, not a new runtime.

import type { Filesystem } from "./manifest.ts";
import { spawnCapture } from "./proc.ts";

export interface AdapterRequest {
	agent: string;
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

// The real adapter. Composes instructions + prompt and pipes them to `claude -p`
// (print mode: one non-interactive response, then exit), reading stdout as the
// participant's output. Runs in the routine's cwd. For write-capable participants
// we use acceptEdits, but live converge passes a sandbox cwd, never the caller cwd.
export const claudeCliAdapter: Adapter = {
	async call(req) {
		if (req.agent !== "claude") {
			throw new Error(`chit-minimal only wires the "claude" agent so far (got "${req.agent}")`);
		}
		const composed = `${req.instructions}\n\n---\n\n${req.prompt}`;
		// filesystem -> claude permission:
		//   read-write -> acceptEdits (auto-apply edits; converge passes a sandbox cwd).
		//   read-only  -> default mode with the edit tools disallowed: the model inspects
		//                 the repo and answers NORMALLY, but cannot edit. NOT plan mode --
		//                 plan mode is for the plan-then-approve flow and under `-p` it can
		//                 route its answer through ExitPlanMode, yielding empty stdout (a
		//                 real composed flow saw a planning step produce 0 chars that way).
		//   none       -> no tools at all.
		const args =
			req.filesystem === "read-write"
				? ["claude", "-p", "--permission-mode", "acceptEdits"]
				: req.filesystem === "read-only"
					? ["claude", "-p", "--permission-mode", "default", "--disallowedTools", "Edit", "Write", "NotebookEdit"]
					: ["claude", "-p", "--tools", ""];
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
