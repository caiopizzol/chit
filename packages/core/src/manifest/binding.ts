// The manifest execution binding an approval carries for every DIRECT manifest
// reference (a plan step's manifestPath, a batch task's / batch-level manifest_path)
// and, later, for a recipe-resolved manifest. Binding only the path string left a
// hole: the file content (and the participants the config resolves it to) could
// change between the approved dry run and the launch. The binding closes it by
// carrying the manifest CONTENT digest plus the safe participant execution summary,
// so "what was reviewed is what runs" holds for the execution surface, not just the
// plan text.
//
// This module is browser-safe (types + pure comparison only). Reading manifest
// bytes (filesystem or git tree) and computing the sha256 happen in the CLI layer;
// core only defines the bound shape and the drift comparison every gate shares.

import type { AuditParticipantSnapshot } from "../audit/events.ts";
import { canonicalJson } from "../canonical-json.ts";

// One participant's safe execution summary: the SAME redacted snapshot shape the
// audit run.started event and job records already use (agent id, adapter, session,
// permissions, and config with model/effort/timeouts/envKeys -- key NAMES only,
// never env values, prompts, or outputs), plus the config role the participant
// resolved through, when it referenced one. Reusing AuditParticipantSnapshot keeps
// approval payloads and receipts from inventing a second provenance vocabulary.
export interface BoundParticipantSummary extends AuditParticipantSnapshot {
	// The config role the manifest participant referenced (resolve provenance).
	role?: string;
	// Which config layer defined the resolved agent (provenance, when available).
	agentOrigin?: "builtin" | "global" | "repo";
}

// Where the bound manifest bytes were read from, which is also where they must be
// re-read at confirm and launch:
//   "git"  - a repo-relative path, read from the git TREE at the bound commit (the
//            content the run executes, never the caller checkout's working tree).
//   "file" - an absolute/global path, read from the filesystem at that exact path.
export type ManifestBindingSource = "git" | "file";

// The effective execution surface an approval binds for one manifest reference.
// manifestPath is the operator-facing identity (repo-relative, or absolute);
// manifestDigest is sha256 over the manifest bytes ("sha256:<hex>"); participants
// is the safe execution summary resolved against the config at binding time.
export interface ManifestBinding {
	manifestPath: string;
	source: ManifestBindingSource;
	manifestDigest: string;
	participants: Record<string, BoundParticipantSummary>;
}

// Why a re-resolved binding no longer matches the approved one, or undefined when
// they match. Shared by the confirm gate (refusal) and the launch gate (needs_human
// pause) so both report the same drift the same way. Compares by VALUE through the
// canonical serialization, so key order never reads as drift.
export function describeManifestBindingDrift(
	approved: ManifestBinding,
	current: ManifestBinding,
): string | undefined {
	if (approved.manifestPath !== current.manifestPath) {
		return `manifest path changed: approved ${JSON.stringify(approved.manifestPath)}, now ${JSON.stringify(current.manifestPath)}`;
	}
	if (approved.manifestDigest !== current.manifestDigest) {
		return `manifest content changed: approved digest ${approved.manifestDigest}, now ${current.manifestDigest}`;
	}
	const participantDrift = describeParticipantSummaryDrift(
		approved.participants,
		current.participants,
	);
	if (participantDrift !== undefined) return participantDrift;
	return undefined;
}

export function describeParticipantSummaryDrift(
	approved: Record<string, BoundParticipantSummary>,
	current: Record<string, BoundParticipantSummary>,
): string | undefined {
	if (canonicalJson(approved) === canonicalJson(current)) return undefined;
	const changed = participantDriftIds(approved, current);
	return `participant execution summary changed (${changed.join(", ")}): the config now resolves this manifest to a different agent/model/permission surface`;
}

// The participant ids whose summary differs (changed, added, or removed), so a
// drift message names WHAT moved without dumping both summaries.
function participantDriftIds(
	approved: Record<string, BoundParticipantSummary>,
	current: Record<string, BoundParticipantSummary>,
): string[] {
	const ids = new Set([...Object.keys(approved), ...Object.keys(current)]);
	const changed: string[] = [];
	for (const id of [...ids].sort()) {
		const a = approved[id];
		const c = current[id];
		if (a === undefined || c === undefined || canonicalJson(a) !== canonicalJson(c)) {
			changed.push(id);
		}
	}
	return changed;
}
