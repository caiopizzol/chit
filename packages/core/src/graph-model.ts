import { getAdapterDescriptor } from "./agents/registry.ts";
import type { NormalizedAgent, NormalizedRegistry, ParticipantConfig } from "./agents/types.ts";
import type { AuditParticipantSnapshot } from "./audit/events.ts";
import type {
	FilesystemPermission,
	InputType,
	NormalizedManifest,
	SessionPolicy,
} from "./manifest/types.ts";
import {
	type EnforcementGap,
	findEnforcementGaps,
	findMissingCapabilities,
	findUnknownAgents,
	type UnknownAgentRef,
} from "./shared.ts";

// Surface capability declarations are constants here (not derived from
// runtime args) because `chit show` is a design-time inspector: the user
// names a surface by kind and we tell them whether the manifest installs.
// Runtime variations (e.g., CLI's --scope) are surfaced via SURFACE_NOTES.
const SURFACE_CAPABILITIES: Readonly<Record<string, ReadonlySet<string>>> = {
	"claude-skill": new Set(["can_show_markdown", "can_provide_stable_scope"]),
	cli: new Set(["can_show_markdown", "can_provide_stable_scope"]),
};

// Run-time caveats the inspection surface should display so "compatible"
// doesn't get misread as "runs with no flags." Each note carries a predicate
// against the manifest so we only surface caveats that actually apply to
// this manifest. Showing every static note on every manifest is noise.
interface SurfaceNoteRule {
	text: string;
	appliesTo: (m: NormalizedManifest) => boolean;
}

const SURFACE_NOTE_RULES: Readonly<Record<string, ReadonlyArray<SurfaceNoteRule>>> = {
	"claude-skill": [],
	cli: [
		{
			text: "can_provide_stable_scope requires --scope at run time",
			// Only surface the --scope caveat when the manifest actually needs
			// stable scope; stateless manifests don't care about this.
			appliesTo: (m) => "can_provide_stable_scope" in m.requires,
		},
	],
};

export type SurfaceKind = keyof typeof SURFACE_CAPABILITIES;

export interface GraphModel {
	manifest: { id: string; description: string; output: string };
	surface: { kind: string; capabilities: string[]; notes: string[] } | null;
	validation: ValidationReport | null;
	inputs: Record<string, { type: InputType; optional: boolean }>;
	participants: Record<string, ParticipantInfo>;
	nodes: GraphNode[];
	edges: GraphEdge[];
	executionOrder: string[][];
	requires: {
		declared: Record<string, true>;
		inferred: Record<string, true>;
		effective: Record<string, true>;
	};
}

export interface ValidationReport {
	capabilities: { compatible: boolean; missing: string[] };
	permissions: { status: "ok" | "needs_override" | "blocked"; gaps: EnforcementGap[] };
	// Unknown-agent references are install-blocking (no adapter can be built
	// without a registry entry), same severity as missing capabilities.
	agents: { resolved: boolean; unknown: UnknownAgentRef[] };
}

// Overall severity of the validation outcome, used to drive UI styling.
// - `error`: install would fail outright (missing capability or unknown agent)
// - `warn`:  installable with the right override flag (permissions only)
// - `ok`:    no issues
export type ValidationSeverity = "ok" | "warn" | "error";

export function validationSeverity(v: ValidationReport | null): ValidationSeverity {
	if (!v) return "ok";
	if (!v.capabilities.compatible) return "error";
	if (!v.agents.resolved) return "error";
	// `blocked` is an install-fail signal (no override path), same severity
	// as a missing capability. `needs_override` is recoverable via the
	// --allow-unenforced-permissions flag, so it stays at warn.
	if (v.permissions.status === "blocked") return "error";
	if (v.permissions.status !== "ok") return "warn";
	return "ok";
}

export interface ParticipantInfo {
	agentId: string;
	instructions: string;
	session: SessionPolicy;
	permissions: { filesystem: FilesystemPermission };
	adapter: string;
	enforcesReadOnly: boolean;
	config: ParticipantConfig;
}

export type GraphNode =
	| { id: string; kind: "input"; inputName: string }
	| {
			id: string;
			kind: "call";
			participantId: string;
			executionLevel: number;
			refs: string[];
			promptTemplate: string;
	  }
	| {
			id: string;
			kind: "format";
			executionLevel: number;
			refs: string[];
			promptTemplate: string;
			isOutput: boolean;
	  };

export interface GraphEdge {
	from: string;
	to: string;
	kind: "input-ref" | "step-ref";
}

export function isKnownSurface(kind: string): kind is SurfaceKind {
	return kind in SURFACE_CAPABILITIES;
}

export function buildGraphModel(
	manifest: NormalizedManifest,
	registry: NormalizedRegistry,
	surfaceKind?: string,
): GraphModel {
	const participants: Record<string, ParticipantInfo> = {};
	for (const [pid, p] of Object.entries(manifest.participants)) {
		const agent = registry.agents[p.agent];
		const adapterKind = agent?.adapter ?? "unknown";
		const desc = agent ? getAdapterDescriptor(agent.adapter) : undefined;
		participants[pid] = {
			agentId: p.agent,
			instructions: p.instructions,
			session: p.session,
			permissions: p.permissions,
			adapter: adapterKind,
			enforcesReadOnly: desc?.capabilities.enforces_filesystem_read_only ?? false,
			config: resolveParticipantConfig(agent),
		};
	}

	const stepLevel: Record<string, number> = {};
	for (let level = 0; level < manifest.executionOrder.length; level++) {
		const stepsAtLevel = manifest.executionOrder[level] ?? [];
		for (const stepId of stepsAtLevel) {
			stepLevel[stepId] = level;
		}
	}

	const nodes: GraphNode[] = [];
	for (const inputName of Object.keys(manifest.inputs)) {
		nodes.push({ id: `input:${inputName}`, kind: "input", inputName });
	}
	for (const [stepId, step] of Object.entries(manifest.steps)) {
		const refs = dedupeRefs(step.refs.map(refToNodeId));
		const executionLevel = stepLevel[stepId] ?? 0;
		if (step.kind === "call") {
			nodes.push({
				id: stepId,
				kind: "call",
				participantId: step.call,
				executionLevel,
				refs,
				promptTemplate: step.prompt,
			});
		} else {
			nodes.push({
				id: stepId,
				kind: "format",
				executionLevel,
				refs,
				promptTemplate: step.format,
				isOutput: stepId === manifest.output,
			});
		}
	}

	const edges: GraphEdge[] = [];
	for (const [stepId, step] of Object.entries(manifest.steps)) {
		const seen = new Set<string>();
		for (const ref of step.refs) {
			const sourceId = refToNodeId(ref);
			const key = `${sourceId}->${stepId}`;
			if (seen.has(key)) continue;
			seen.add(key);
			edges.push({
				from: sourceId,
				to: stepId,
				kind: ref.kind === "input" ? "input-ref" : "step-ref",
			});
		}
	}

	let surface: GraphModel["surface"] = null;
	let validation: ValidationReport | null = null;
	if (surfaceKind !== undefined) {
		if (!isKnownSurface(surfaceKind)) {
			throw new Error(
				`unknown surface "${surfaceKind}" (known: ${Object.keys(SURFACE_CAPABILITIES).join(", ")})`,
			);
		}
		const caps = SURFACE_CAPABILITIES[surfaceKind];
		if (!caps) {
			throw new Error(`internal: capabilities not registered for surface "${surfaceKind}"`);
		}
		const noteRules = SURFACE_NOTE_RULES[surfaceKind] ?? [];
		const notes = noteRules.filter((r) => r.appliesTo(manifest)).map((r) => r.text);
		surface = { kind: surfaceKind, capabilities: [...caps].sort(), notes };
		const missing = findMissingCapabilities(manifest, caps);
		const gaps = findEnforcementGaps(manifest, registry);
		const unknown = findUnknownAgents(manifest, registry);
		validation = {
			capabilities: { compatible: missing.length === 0, missing },
			permissions: {
				status: gaps.length === 0 ? "ok" : "needs_override",
				gaps,
			},
			agents: { resolved: unknown.length === 0, unknown },
		};
	}

	const inputs: GraphModel["inputs"] = {};
	for (const [name, schema] of Object.entries(manifest.inputs)) {
		inputs[name] = { type: schema.type, optional: schema.optional };
	}

	return {
		manifest: {
			id: manifest.id,
			description: manifest.description,
			output: manifest.output,
		},
		surface,
		validation,
		inputs,
		participants,
		nodes,
		edges,
		executionOrder: manifest.executionOrder.map((level) => [...level]),
		requires: {
			declared: { ...manifest.declaredRequires },
			inferred: { ...manifest.inferredRequires },
			effective: { ...manifest.requires },
		},
	};
}

// Resolve the per-participant config snapshot to persist at run start, so an
// audited run records exactly what config it ran with (the registry can change
// afterward). Reuses buildGraphModel's participant resolution and drops the role
// text: role already appears in the rendered prompt blobs, and leaving it out
// keeps the run.started event small and less sensitive.
export function resolveParticipantSnapshots(
	manifest: NormalizedManifest,
	registry: NormalizedRegistry,
): Record<string, AuditParticipantSnapshot> {
	const { participants } = buildGraphModel(manifest, registry);
	const snapshots: Record<string, AuditParticipantSnapshot> = {};
	for (const [pid, p] of Object.entries(participants)) {
		snapshots[pid] = {
			agentId: p.agentId,
			adapter: p.adapter,
			session: p.session,
			permissions: p.permissions,
			enforcesReadOnly: p.enforcesReadOnly,
			config: p.config,
		};
	}
	return snapshots;
}

// Resolve the effective config chit will run a participant's agent with, for
// display. Undefined fields mean the adapter / CLI default applies. strictMcp and
// passModelOnResume only apply to claude-cli (omitted otherwise, mirroring the
// adapter and fingerprint rules). env is redacted to sorted key names, never
// values. An unknown agent (not in the registry) yields an empty config.
function resolveParticipantConfig(agent: NormalizedAgent | undefined): ParticipantConfig {
	if (!agent) return {};
	const config: ParticipantConfig = {};
	if (agent.model !== undefined) config.model = agent.model;
	if (agent.reasoningEffort !== undefined) config.reasoningEffort = agent.reasoningEffort;
	if (agent.adapter === "claude-cli") {
		// Effective on/off: undefined and true both mean strict-on; only an explicit
		// false is off. Matches the adapter default and the fingerprint's treatment.
		config.strictMcp = agent.strictMcp !== false;
		config.passModelOnResume = agent.passModelOnResume;
	}
	if (agent.callTimeoutMs !== undefined) config.callTimeoutMs = agent.callTimeoutMs;
	if (agent.noProgressTimeoutMs !== undefined) {
		config.noProgressTimeoutMs = agent.noProgressTimeoutMs;
	}
	if (agent.env !== undefined) {
		const keys = Object.keys(agent.env).sort();
		if (keys.length > 0) config.envKeys = keys;
	}
	return config;
}

function refToNodeId(ref: { kind: "input" | "step_output"; name: string }): string {
	return ref.kind === "input" ? `input:${ref.name}` : ref.name;
}

function dedupeRefs(refs: string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const r of refs) {
		if (!seen.has(r)) {
			seen.add(r);
			out.push(r);
		}
	}
	return out;
}
