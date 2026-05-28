import { getAdapterDescriptor } from "./agents/registry.ts";
import type { NormalizedRegistry } from "./agents/types.ts";
import type { NormalizedManifest } from "./manifest/types.ts";

// Returns the names of capabilities the manifest requires that the surface
// does not provide. Empty array means the manifest is compatible with the
// surface.
export function findMissingCapabilities(
	manifest: NormalizedManifest,
	surfaceCaps: ReadonlySet<string>,
): string[] {
	const missing: string[] = [];
	for (const cap of Object.keys(manifest.requires)) {
		if (!surfaceCaps.has(cap)) missing.push(cap);
	}
	return missing;
}

export interface UnknownAgentRef {
	participantId: string;
	agentId: string;
}

// Returns the participants whose agent reference does not exist in the
// registry. Shared so every surface (CLI, claude-skill, future MCP) catches
// this at install/run time instead of only failing once an adapter is built.
export function findUnknownAgents(
	manifest: NormalizedManifest,
	registry: NormalizedRegistry,
): UnknownAgentRef[] {
	const out: UnknownAgentRef[] = [];
	for (const [pid, p] of Object.entries(manifest.participants)) {
		if (!(p.agent in registry.agents)) {
			out.push({ participantId: pid, agentId: p.agent });
		}
	}
	return out;
}

export interface EnforcementGap {
	participantId: string;
	agentId: string;
	permission: string;
}

// Walks the manifest's participants and identifies the ones whose declared
// permissions cannot be enforced by their chosen adapter. Today only
// `filesystem: read_only` is checked.
//
// Shared between every surface so install-time governance behavior stays
// uniform whether the manifest is being installed as a CLI manifest, a Claude
// skill, an MCP tool, or anything later.
export function findEnforcementGaps(
	manifest: NormalizedManifest,
	registry: NormalizedRegistry,
): EnforcementGap[] {
	const gaps: EnforcementGap[] = [];
	for (const [pid, p] of Object.entries(manifest.participants)) {
		if (p.permissions.filesystem !== "read_only") continue;
		const agent = registry.agents[p.agent];
		if (!agent) continue;
		const desc = getAdapterDescriptor(agent.adapter);
		if (!desc?.capabilities.enforces_filesystem_read_only) {
			gaps.push({
				participantId: pid,
				agentId: p.agent,
				permission: "filesystem: read_only",
			});
		}
	}
	return gaps;
}

export function formatEnforcementGaps(gaps: EnforcementGap[]): string {
	return gaps
		.map(
			(g) =>
				`  - participant "${g.participantId}" (agent "${g.agentId}") requires ${g.permission}, but its adapter cannot enforce it`,
		)
		.join("\n");
}

// Invocation-layer warning: a per-run governance signal produced by the
// surface (CLI, claude-skill, future MCP), NOT by the runtime. Lives in
// shared.ts so any browser-side consumer (Studio) can render warnings
// without pulling node-only code. Warnings are data; surfaces decide how
// to render them.
export interface InvocationWarning {
	kind: "permission_unenforced";
	participantId: string;
	agentId: string;
	message: string;
}

export interface InvocationWarningOptions {
	// True iff the user explicitly opted into running with adapters that
	// can't enforce declared permissions (--allow-unenforced-permissions).
	// Without the opt-in, the strict-path refusal upstream prevents the
	// run; warnings here would be moot.
	allowUnenforcedPermissions: boolean;
}

// Compute the warnings a surface should surface for this invocation.
// Today: one warning per enforcement gap when allowUnenforcedPermissions
// is true. Future kinds (fingerprint_mismatch, etc.) plug in here.
export function collectInvocationWarnings(
	manifest: NormalizedManifest,
	registry: NormalizedRegistry,
	options: InvocationWarningOptions,
): InvocationWarning[] {
	const warnings: InvocationWarning[] = [];
	if (options.allowUnenforcedPermissions) {
		for (const gap of findEnforcementGaps(manifest, registry)) {
			warnings.push({
				kind: "permission_unenforced",
				participantId: gap.participantId,
				agentId: gap.agentId,
				message: `participant "${gap.participantId}" (agent "${gap.agentId}") declares ${gap.permission}; adapter cannot enforce it`,
			});
		}
	}
	return warnings;
}
