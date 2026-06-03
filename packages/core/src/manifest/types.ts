export type Schema = 1;

export type InputType = "string" | "file[]";
export type SessionPolicy = "stateless" | "per_topology" | "per_scope";
export type FilesystemPermission = "read_only" | "write";

export interface NormalizedInput {
	type: InputType;
	optional: boolean;
}

export interface NormalizedParticipant {
	agent: string;
	// The persona / standing instructions prepended to every call this participant
	// makes. (Renamed from `role`: "role" now names the reusable role concept; this
	// field is the instruction text.)
	instructions: string;
	session: SessionPolicy;
	permissions: { filesystem: FilesystemPermission };
}

export interface TemplateRef {
	kind: "input" | "step_output";
	name: string;
}

export type NormalizedStep =
	| { kind: "call"; call: string; prompt: string; refs: TemplateRef[] }
	| { kind: "format"; format: string; refs: TemplateRef[] };

// How the runtime executes a manifest. A manifest without a `policy` normalizes
// to `{ kind: "one-shot" }` (a single DAG pass), so downstream code never has to
// guess. A `loop` policy declares the implement/check convergence shape: which
// steps are the implementer and reviewer, and the iteration budget. The reviewer
// verdict contract (proceed/revise/block) is fixed and NOT configurable here.
// A verification command chit runs ITSELF after a `proceed` review (ground truth,
// not a model claim). Structured so chit spawns it with NO shell: `command` + `args`
// go straight to the process (no quoting/injection surface). `name` labels it in the
// trace; `timeoutMs` bounds it. Deliberately minimal: no env, cwd, or shell strings.
export interface RequiredCheck {
	command: string;
	args: string[];
	name?: string;
	timeoutMs?: number;
}

export type NormalizedPolicy =
	| { kind: "one-shot" }
	| {
			kind: "loop";
			implementStep: string;
			reviewStep: string;
			maxIterations?: number;
			// chit-executed verification (see RequiredCheck). When present, chit runs these
			// after a `proceed` review and their result is authoritative over the reviewer's
			// self-report. Absent -> the loop falls back to reviewer-reported verification.
			requiredChecks?: RequiredCheck[];
	  };

export interface NormalizedManifest {
	schema: Schema;
	id: string;
	description: string;
	inputs: Record<string, NormalizedInput>;
	declaredRequires: Record<string, true>;
	inferredRequires: Record<string, true>;
	requires: Record<string, true>;
	participants: Record<string, NormalizedParticipant>;
	steps: Record<string, NormalizedStep>;
	output: string;
	policy: NormalizedPolicy;
	dependencies: Record<string, string[]>;
	executionOrder: string[][];
}
