// Pure editing helpers, no React. The dirty check and save gate are the two
// places where 2.2 could hide subtle bugs (untouched files marked dirty;
// saving while a preview is mid-flight), so they live here, unit-tested,
// rather than inline in the hook.

import type { GraphModel } from "@chit/core";
import { validationSeverity } from "@chit/core";

// Deep structural equality for JSON-shaped values. Object key order does not
// matter. Arrays compare element-wise in order.
export function deepEqual(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (a === null || b === null) return a === b;
	if (typeof a !== typeof b) return false;
	if (Array.isArray(a) || Array.isArray(b)) {
		if (!Array.isArray(a) || !Array.isArray(b)) return false;
		if (a.length !== b.length) return false;
		return a.every((v, i) => deepEqual(v, b[i]));
	}
	if (typeof a === "object" && typeof b === "object") {
		const ao = a as Record<string, unknown>;
		const bo = b as Record<string, unknown>;
		const ak = Object.keys(ao);
		const bk = Object.keys(bo);
		if (ak.length !== bk.length) return false;
		return ak.every((k) => k in bo && deepEqual(ao[k], bo[k]));
	}
	return false;
}

// Canonical on-disk form. MUST stay byte-identical to the server's
// canonicalize() in apps/studio/src/server/docs.ts: tab-indented JSON,
// key order from the object. Because both sides use JSON.stringify with the
// same args on the same object, the diff the client shows is exactly what
// the server will write, with no preview round trip.
export function canonicalize(draft: unknown): string {
	return JSON.stringify(draft, null, "\t");
}

// Dirty when draftSource diverges from the parsed raw. Compares parsed
// values, NOT text: an existing file may not match canonical formatting, so
// a text compare (canonicalRaw !== raw) would mark an untouched file dirty.
export function isDirty(draftSource: unknown, raw: string): boolean {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return true; // raw unparseable: any draft counts as a change
	}
	return !deepEqual(draftSource, parsed);
}

// Immutably set a participant field on a file-shape draft. role and session
// are top-level on the participant; filesystem is nested under permissions
// (created if absent). Returns a new draft; does not mutate the input. Pure
// so the nested-permissions shape is unit-tested rather than buried in the
// hook.
export function updateParticipantField(
	draft: Record<string, unknown>,
	participantId: string,
	field: "role" | "session" | "filesystem",
	value: string,
): Record<string, unknown> {
	const participants = (draft.participants ?? {}) as Record<string, Record<string, unknown>>;
	const current = participants[participantId] ?? {};
	let nextParticipant: Record<string, unknown>;
	if (field === "filesystem") {
		const perms = (current.permissions ?? {}) as Record<string, unknown>;
		nextParticipant = { ...current, permissions: { ...perms, filesystem: value } };
	} else {
		nextParticipant = { ...current, [field]: value };
	}
	return { ...draft, participants: { ...participants, [participantId]: nextParticipant } };
}

// Immutably set a top-level step field on a file-shape draft: `prompt` for
// call steps, `format` for format steps. Returns a new draft; does not mutate
// the input. Pure so it is unit-tested independently of the hook.
export function updateStepField(
	draft: Record<string, unknown>,
	stepId: string,
	field: "prompt" | "format",
	value: string,
): Record<string, unknown> {
	const steps = (draft.steps ?? {}) as Record<string, Record<string, unknown>>;
	const current = steps[stepId] ?? {};
	return { ...draft, steps: { ...steps, [stepId]: { ...current, [field]: value } } };
}

// The reference token a source node contributes when wired into a target
// template. Input sources contribute an input ref keyed by input name; call
// and format sources contribute a step-output ref keyed by step id.
export function referenceToken(
	sourceKind: "input" | "call" | "format",
	sourceName: string,
): string {
	if (sourceKind === "input") return `{{ inputs.${sourceName} }}`;
	return `{{ steps.${sourceName}.output }}`;
}

// Append a reference token to a template on its own line. Deterministic and
// always a valid placement; the user repositions via the template editor. An
// empty template becomes just the token (no leading blank lines).
export function appendReference(template: string, token: string): string {
	return template === "" ? token : `${template}\n\n${token}`;
}

// Insert a reference into the target step's template. The field is chosen
// explicitly by the target step's kind: call steps carry `prompt`, format
// steps carry `format`. Returns a new draft. Throws on an unknown step or a
// step that is neither call nor format (a malformed draft). Returns the draft
// unchanged if the token is already present (idempotent; avoids a duplicate
// token from a repeated connect).
export function insertReference(
	draft: Record<string, unknown>,
	targetStepId: string,
	token: string,
): Record<string, unknown> {
	const steps = (draft.steps ?? {}) as Record<string, Record<string, unknown>>;
	const step = steps[targetStepId];
	if (!step) throw new Error(`insertReference: unknown step "${targetStepId}"`);
	let field: "prompt" | "format";
	if ("call" in step) field = "prompt";
	else if ("format" in step) field = "format";
	else
		throw new Error(`insertReference: step "${targetStepId}" is neither a call nor a format step`);
	const current = String(step[field] ?? "");
	if (current.includes(token)) return draft;
	return updateStepField(draft, targetStepId, field, appendReference(current, token));
}

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// A regex matching every whitespace variant of a source reference token:
// `{{ inputs.X }}`, `{{inputs.X}}`, `{{  steps.X.output  }}`, etc. The name is
// regex-escaped. Mirrors the flexibility the parser allows, so deletion
// removes hand-written variants, not only the canonical token referenceToken
// produces.
function referencePattern(kind: "input" | "call" | "format", name: string): RegExp {
	const n = escapeRegExp(name);
	const inner = kind === "input" ? `inputs\\.${n}` : `steps\\.${n}\\.output`;
	return new RegExp(`\\{\\{\\s*${inner}\\s*\\}\\}`, "g");
}

// Remove every occurrence of a source reference from the target step's
// template, then conservatively collapse the blank lines the removal leaves
// (3+ newlines -> 2) and trim the edges. Returns the new draft and how many
// occurrences were removed (0 means the draft is returned unchanged). Pure /
// immutable. Throws on unknown / neither-call-nor-format steps. If removing
// the reference empties a required template, the result is an invalid
// manifest; the caller's parseManifest gate rejects it and leaves the draft
// in place.
export function removeReference(
	draft: Record<string, unknown>,
	targetStepId: string,
	refKind: "input" | "call" | "format",
	refName: string,
): { draft: Record<string, unknown>; removed: number } {
	const steps = (draft.steps ?? {}) as Record<string, Record<string, unknown>>;
	const step = steps[targetStepId];
	if (!step) throw new Error(`removeReference: unknown step "${targetStepId}"`);
	let field: "prompt" | "format";
	if ("call" in step) field = "prompt";
	else if ("format" in step) field = "format";
	else
		throw new Error(`removeReference: step "${targetStepId}" is neither a call nor a format step`);
	const current = String(step[field] ?? "");
	const pattern = referencePattern(refKind, refName);
	const matches = current.match(pattern);
	const removed = matches ? matches.length : 0;
	if (removed === 0) return { draft, removed: 0 };
	const next = current
		.replace(pattern, "")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	return { draft: updateStepField(draft, targetStepId, field, next), removed };
}

export interface SaveGate {
	dirty: boolean;
	previewPending: boolean;
	previewError: string | null;
	conflict: boolean;
	graphModel: GraphModel;
}

// Save is allowed only when there is something to save, no async work is in
// flight, the last preview parsed cleanly, there is no unresolved conflict,
// and validation is not at error severity. Warn (needs_override) is saveable.
export function canSave(g: SaveGate): boolean {
	if (!g.dirty) return false;
	if (g.previewPending) return false;
	if (g.previewError !== null) return false;
	if (g.conflict) return false;
	return validationSeverity(g.graphModel.validation) !== "error";
}
