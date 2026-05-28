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

export type TraceEvent =
	| { type: "step.started"; stepId: string }
	| { type: "step.completed"; stepId: string }
	| { type: "step.failed"; stepId: string; error: string };

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
