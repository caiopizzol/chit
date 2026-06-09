// The single canonicalizer the approval gates hash over. Browser-safe (no node imports,
// no hashing): it builds the canonical bytes only; the CLI/MCP layer computes the digest
// (node crypto), keeping core free of node dependencies. Both the native plan gate
// (plan/approval.ts) and the batch gate (batch/approval.ts) serialize their artifacts
// through canonicalJson so every caller derives the identical hash from an identical
// artifact -- there is exactly one canonicalizer.

// Deterministic canonical JSON: object keys are sorted at every depth, arrays keep their
// order, primitives serialize as JSON. So two values that differ only in key insertion
// order produce identical bytes -- the hash binds the VALUE, never the order it happened
// to be built in. undefined-valued keys are dropped (JSON.stringify drops them too), so an
// optional field being absent vs present-as-undefined can never perturb the hash.
function canonicalize(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalize);
	if (value !== null && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const key of Object.keys(value as Record<string, unknown>).sort()) {
			const v = (value as Record<string, unknown>)[key];
			if (v !== undefined) out[key] = canonicalize(v);
		}
		return out;
	}
	return value;
}

// The exact payload string an approval gate hashes. Stable across key order and equal for
// equal values (see canonicalize), so a dry-run hash and its confirmed-start recompute
// match iff the canonicalized artifact is unchanged.
export function canonicalJson(value: unknown): string {
	return JSON.stringify(canonicalize(value));
}
