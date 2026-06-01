// Numeric guards for adapter usage extraction. The extracted usage is typed as
// @chit-run/core's AdapterUsage, which has RUNTIME invariants (token fields are
// non-negative integers; cost is finite and non-negative) enforced when an audit
// adapter.call.completed event is validated. Extractors must honor those same
// invariants so a CLI that reports a stray negative/fractional value never
// produces a usage object that later fails validateAuditEvent. Invalid fields
// are dropped tolerantly: a missing usage field is not an error.

// A token count: a non-negative integer, else undefined.
export function nonNegInt(v: unknown): number | undefined {
	return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : undefined;
}

// A cost: a finite, non-negative number (fractional allowed), else undefined.
export function nonNegNum(v: unknown): number | undefined {
	return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
}
