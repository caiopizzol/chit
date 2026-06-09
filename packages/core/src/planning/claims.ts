// Canonical batch claimedPath normalization, shared by batch planning surfaces so
// claim validation cannot drift. Pure and browser-safe (no node imports). The error
// carries a context-free message; each caller wraps it with its own context (a task id).

export class ClaimError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ClaimError";
	}
}

// Normalize one claimedPath to a canonical repo-relative form so the overlap check
// (apps/cli/src/batches/overlap.ts, raw string comparison) is not fooled by `./`,
// `//`, or trailing slashes: `src/**` and `./src//` must compare equal. Rejects
// absolute paths and `..` traversal -- a claim must name a path INSIDE the repo.
// Preserves a trailing `/**` or `/` (the subtree markers overlap.ts keys on).
export function normalizeClaimedPath(claim: string): string {
	const raw = claim.trim();
	if (raw === "") throw new ClaimError("a claimedPath is empty");
	if (raw.startsWith("/"))
		throw new ClaimError(`claimedPath must be repo-relative, got ${JSON.stringify(claim)}`);
	const dirGlob = raw.endsWith("/**");
	const dirSlash = !dirGlob && raw.endsWith("/");
	const body = dirGlob ? raw.slice(0, -3) : dirSlash ? raw.slice(0, -1) : raw;
	const segments: string[] = [];
	for (const seg of body.split("/")) {
		if (seg === "" || seg === ".") continue; // collapse `//`, drop `./`
		if (seg === "..")
			throw new ClaimError(`claimedPath may not contain "..": ${JSON.stringify(claim)}`);
		segments.push(seg);
	}
	if (segments.length === 0)
		throw new ClaimError(`claimedPath is empty after normalization: ${JSON.stringify(claim)}`);
	const base = segments.join("/");
	return dirGlob ? `${base}/**` : dirSlash ? `${base}/` : base;
}
