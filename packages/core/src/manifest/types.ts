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
	role: string;
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
	dependencies: Record<string, string[]>;
	executionOrder: string[][];
}
