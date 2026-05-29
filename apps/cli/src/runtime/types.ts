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
}

export interface AdapterCallResult {
	output: string;
	// New session payload to persist for this participant. Absent means
	// "no session to persist" (e.g., stateless adapters or this-call-failed).
	session?: unknown;
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
	| { type: "step.completed"; stepId: string; output: string; durationMs: number }
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
