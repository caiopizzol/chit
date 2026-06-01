import type { AdapterUsage, FilesystemPermission } from "@chit-run/core";

// One intra-call event from the underlying CLI stream. Both adapters emit these
// live: each reads stdout incrementally and calls AdapterCallRequest.onEvent per
// parsed line as it arrives (Codex JSONL, Claude stream-json), so the audit
// wrapper preserves them with real arrival timestamps.
export interface AdapterEvent {
	// The raw event type reported by the CLI (e.g. Codex "item.completed", a
	// Claude stream-json event subtype).
	type: string;
	// The raw event payload (a single JSONL line / serialized event), verbatim.
	// The audit wrapper blobs this; nothing inspects its structure here.
	raw: string;
}

export interface AdapterCallRequest {
	participantId: string;
	agentId: string;
	stepId: string;
	input: string;
	cwd: string;
	// Opaque-to-runtime session payload from a prior call for this
	// (scope, manifest, participant, fingerprint). Adapters interpret their
	// own shape (e.g., Codex threadId, Claude sessionId). Absent for the first
	// call, or for participants whose session policy is not `per_scope`.
	session?: unknown;
	// If provided, an adapter must kill its child process when this aborts and
	// reject (rather than return). Optional: the CLI runtime does not pass one,
	// so its behavior is unchanged. Used by the MCP stepwise surface to make a
	// running step cancellable.
	signal?: AbortSignal;
	// An adapter that surfaces intra-call events calls this per event, live, as
	// each line is read. Optional: the CLI runtime passes none (so a plain run
	// does no per-event work), while the audit wrapper sets it to record
	// adapter.event. Both adapters implement it.
	onEvent?: (event: AdapterEvent) => void;
	// The calling participant's declared filesystem permission. Adapters that can
	// enforce read_only consult it per call: claude-cli runs with
	// `--permission-mode plan` when read_only (codex-exec always sandboxes, so it
	// ignores this). Threaded per call, not baked into the adapter, so one adapter
	// instance can serve participants with different permissions. Optional: when
	// omitted the adapter keeps its permissive default (claude can write).
	filesystem?: FilesystemPermission;
}

export interface AdapterCallResult {
	output: string;
	// New session payload to persist for this participant. Absent means
	// "no session to persist" (e.g., stateless adapters or this-call-failed).
	session?: unknown;
	// Token/cost accounting for this call, when the adapter's CLI reports it.
	// Optional: a missing usage is not an error (an older CLI, or a call that
	// failed before any usage was emitted). Uses the shared @chit-run/core type so
	// the trace, the audit event, and loop aggregation all speak one shape.
	usage?: AdapterUsage;
}

export interface RuntimeAdapter {
	call(req: AdapterCallRequest): Promise<AdapterCallResult>;
}

export type AdapterMap = Record<string, RuntimeAdapter>;

// Trace events carry enough to reconstruct what each step did: the kind, and
// for call steps the participant/agent/session-policy and the rendered prompt
// actually sent to the adapter (otherwise invisible, since the prompt is
// interpolated at run time). completed/failed carry wall-clock duration.
// result.trace always collects the full payload; the CLI `--trace` renderer
// shows previews of prompt/output, not full dumps.
export type TraceEvent =
	| {
			type: "step.started";
			stepId: string;
			kind: "call" | "format";
			participantId?: string;
			agentId?: string;
			session?: string;
			prompt?: string;
	  }
	| {
			type: "step.completed";
			stepId: string;
			output: string;
			durationMs: number;
			// Token/cost for a call step, when the adapter reported it. Absent for
			// format steps and for calls whose CLI did not report usage.
			usage?: AdapterUsage;
	  }
	| { type: "step.failed"; stepId: string; error: string; durationMs: number };

export interface ExecuteOptions {
	inputs: Record<string, unknown>;
	adapters: AdapterMap;
	invocationCwd: string;
	onTrace?: (event: TraceEvent) => void;
	// If provided, threaded to every adapter call so an in-flight run can be
	// cancelled: an adapter must kill its child and reject when this aborts.
	// Optional, so the plain CLI run path (which passes none) is unchanged. The
	// MCP converge surface passes one to make a running iteration Esc-cancellable.
	signal?: AbortSignal;
}

export type RunResult =
	| { ok: true; output: string; outputs: Record<string, string>; trace: TraceEvent[] }
	| {
			ok: false;
			failedStep: string;
			error: string;
			outputs: Record<string, string>;
			trace: TraceEvent[];
	  };
