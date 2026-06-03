import type { NormalizedRole } from "../config/types.ts";
import type {
	FilesystemPermission,
	NormalizedManifest,
	NormalizedParticipant,
	SessionPolicy,
} from "../manifest/types.ts";

// The participant resolver bridges a parsed manifest (which may reference roles or
// inline its participants) and the config (agents + roles) into a fully resolved
// manifest that execution, validation, show, and audit can consume. A distinct
// ResolvedManifest type is the point: only a resolved manifest can be run, so an
// unresolved one cannot reach execution by accident.
//
// Stage 4 builds the types + resolveManifest in isolation; parseManifest still emits
// the strict inline form (NormalizedParticipant), which is assignable to a
// ParticipantSpec, so the resolver already accepts real parsed manifests. Stage 5
// loosens parseManifest to emit role references and moves the consumers onto
// ResolvedManifest.

// A participant as written in a manifest: EITHER a reference to a named role (with
// optional shallow overrides) OR a fully inline participant. All fields are optional
// at this layer; resolution decides completeness. A NormalizedParticipant (all
// fields present, no role ref) is a valid ParticipantSpec.
export interface ParticipantSpec {
	role?: string;
	agent?: string;
	instructions?: string;
	session?: SessionPolicy;
	permissions?: { filesystem: FilesystemPermission };
}

// A parsed manifest whose participants may still be unresolved (role refs / partial
// overrides). Same as NormalizedManifest in every other field.
export type ManifestSpec = Omit<NormalizedManifest, "participants"> & {
	participants: Record<string, ParticipantSpec>;
};

// How a resolved participant got its values: which role (if any) it referenced, and
// which fields the participant itself supplied on top of that role. Surfaced by show
// and recorded (cheaply) by audit; the resolved values remain the source of truth.
export interface ResolveProvenance {
	role?: string;
	overrides: string[];
}

// A fully resolved participant: every field concrete (so it is a NormalizedParticipant)
// plus its provenance. Being a superset of NormalizedParticipant means every existing
// consumer that reads .agent / .instructions / .session / .permissions keeps working
// when it moves onto ResolvedManifest in Stage 5.
export type ResolvedParticipant = NormalizedParticipant & { provenance: ResolveProvenance };

// A manifest with every participant resolved. The only manifest execution can run.
export type ResolvedManifest = Omit<NormalizedManifest, "participants"> & {
	participants: Record<string, ResolvedParticipant>;
};

// Re-exported for resolver consumers.
export type { NormalizedRole };
