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
