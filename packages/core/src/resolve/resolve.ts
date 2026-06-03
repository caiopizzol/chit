// resolveManifest: the single participant resolver. Browser-safe (data only, no
// node, no fs). Turns a ManifestSpec (role refs and/or inline participants) plus the
// config's roles into a ResolvedManifest with every participant concrete. It does
// NOT check whether the resolved agent exists in the registry: that stays the
// existing findUnknownAgents validator's job, run on the resolved manifest. The two
// errors resolution owns are an unknown role reference and a participant left with no
// agent (a model-agnostic role used without a participant agent).

import type { NormalizedRole } from "../config/types.ts";
import { computeInferredRequires } from "../manifest/parse.ts";
import type { FilesystemPermission, SessionPolicy } from "../manifest/types.ts";
import type {
	ManifestSpec,
	ParticipantSpec,
	ResolvedManifest,
	ResolvedParticipant,
} from "./types.ts";

export class ResolveError extends Error {
	constructor(
		public readonly participantId: string,
		message: string,
	) {
		super(`participant "${participantId}": ${message}`);
		this.name = "ResolveError";
	}
}

// The role library a resolve needs. Accepts the whole NormalizedConfig or a bare
// roles map (the config's `roles`), so callers can pass either.
export interface ResolveContext {
	roles: Record<string, NormalizedRole>;
}

export function resolveManifest(spec: ManifestSpec, ctx: ResolveContext): ResolvedManifest {
	const participants: Record<string, ResolvedParticipant> = {};
	for (const [pid, p] of Object.entries(spec.participants)) {
		participants[pid] = resolveParticipant(pid, p, ctx.roles);
	}
	// Recompute inferred requirements from the RESOLVED participants. A role
	// reference can carry a per_scope session that parse (role-library-free) could
	// not see, so can_provide_stable_scope must be derived here, not trusted from the
	// spec. declaredRequires is the author's own and is preserved; requires is the
	// union, declared winning, exactly as parse builds it.
	const inferredRequires = computeInferredRequires(spec.inputs, participants);
	const requires: Record<string, true> = { ...inferredRequires, ...spec.declaredRequires };
	return { ...spec, participants, inferredRequires, requires };
}

function resolveParticipant(
	pid: string,
	spec: ParticipantSpec,
	roles: Record<string, NormalizedRole>,
): ResolvedParticipant {
	let role: NormalizedRole | undefined;
	if (spec.role !== undefined) {
		role = roles[spec.role];
		if (role === undefined) {
			throw new ResolveError(pid, `references unknown role "${spec.role}"`);
		}
	}

	// Shallow overlay: a participant field replaces the role's whole field. The role
	// supplies the rest. permissions falls back to read_only only when neither the
	// participant nor the role provided it (a role always carries it, so this default
	// only bites a bare inline participant that omitted it).
	const agent: string | undefined = spec.agent ?? role?.agent;
	const instructions: string | undefined = spec.instructions ?? role?.instructions;
	const session: SessionPolicy | undefined = spec.session ?? role?.session;
	const permissions: { filesystem: FilesystemPermission } = spec.permissions ??
		role?.permissions ?? { filesystem: "read_only" };

	// Completeness. agent is the field that legitimately goes missing (a model-agnostic
	// role used by a participant that supplied none). instructions/session are
	// guaranteed by a referenced role or by the inline parser, but check defensively.
	if (agent === undefined) {
		throw new ResolveError(
			pid,
			role !== undefined
				? `role "${spec.role}" has no default agent and the participant supplied none`
				: "has no agent",
		);
	}
	if (instructions === undefined) throw new ResolveError(pid, "has no instructions");
	if (session === undefined) throw new ResolveError(pid, "has no session");

	// Provenance: which role (if any) and which fields the participant supplied on top.
	const overrides: string[] = [];
	if (role !== undefined) {
		if (spec.agent !== undefined) overrides.push("agent");
		if (spec.instructions !== undefined) overrides.push("instructions");
		if (spec.session !== undefined) overrides.push("session");
		if (spec.permissions !== undefined) overrides.push("permissions");
	}

	return {
		agent,
		instructions,
		session,
		permissions,
		provenance: { ...(spec.role !== undefined && { role: spec.role }), overrides },
	};
}
