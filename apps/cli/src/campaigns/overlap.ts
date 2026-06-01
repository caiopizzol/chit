// Path-claim overlap: do two tasks expect to touch the same files? Used by the
// scheduler to never run claim-overlapping tasks concurrently (it serializes
// them into separate waves), so parallel tasks cannot race on the same files.
// Salvaged from the campaign-v0 prototype; this is a conservative approximation,
// not a full glob engine: it errs toward declaring overlap.

import type { CampaignTask } from "./types.ts";

interface ClaimShape {
	base: string;
	isDir: boolean;
}

function shape(claim: string): ClaimShape {
	if (claim.endsWith("/**")) return { base: claim.slice(0, -3), isDir: true };
	if (claim.endsWith("/")) return { base: claim.slice(0, -1), isDir: true };
	return { base: claim, isDir: false };
}

// True when two claims could touch the same file. Equal claims overlap; a subtree
// (`dir/**` or `dir/`) overlaps anything at or under its base.
export function pathsOverlap(a: string, b: string): boolean {
	const sa = shape(a);
	const sb = shape(b);
	if (sa.base === sb.base) return true;
	if (sa.isDir && (sb.base === sa.base || sb.base.startsWith(`${sa.base}/`))) return true;
	if (sb.isDir && (sa.base === sb.base || sa.base.startsWith(`${sb.base}/`))) return true;
	return false;
}

// True when the two tasks must not run concurrently. A task that opted into
// allowPathOverlap is treated as overlapping EVERYTHING (an undeclared footprint
// could touch anything), so it runs alone, never beside another task. Otherwise
// they overlap iff any claim of one overlaps any claim of the other.
export function tasksClaimsOverlap(a: CampaignTask, b: CampaignTask): boolean {
	if (a.allowPathOverlap || b.allowPathOverlap) return true;
	return a.claimedPaths.some((pa) => b.claimedPaths.some((pb) => pathsOverlap(pa, pb)));
}
