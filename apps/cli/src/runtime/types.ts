import type { AdapterUsage } from "@chit/core";

// One intra-call event from the underlying CLI stream. NOT emitted yet: the
// streaming adapter redesign (a later slice) will call AdapterCallRequest.onEvent
// per event so the audit wrapper can preserve them (Codex JSONL, Claude
// stream-json). Declared now so adapters, the runtime, and the audit wrapper
// share one contract instead of churning it when streaming lands.
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
	// Reserved for the streaming slice: an adapter that can surface intra-call
	// events calls this per event. Optional and currently unused by every
	// adapter, so behavior is unchanged until streaming is wired.
	onEvent?: (event: AdapterEvent) => void;
}

export interface AdapterCallResult {
	output: string;
	// New session payload to persist for this participant. Absent means
	// "no session to persist" (e.g., stateless adapters or this-call-failed).
	session?: unknown;
	// Token/cost accounting for this call, when the adapter's CLI reports it.
	// Optional: a missing usage is not an error (an older CLI, or a call that
	// failed before any usage was emitted). Uses the shared @chit/core type so
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
