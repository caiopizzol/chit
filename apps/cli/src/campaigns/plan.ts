// Campaign planner: turn a set of GitHub issues into classified campaign tasks.
// Deliberately simple and conservative (see notes/campaign-v0.md):
//
//   - Path claims come from a keyword heuristic over the issue TITLE only.
//     Titles are short and intentional; issue bodies mention many areas in
//     passing (a distribution issue that discusses MCP is not an MCP code
//     change), so matching the body over-claims and spuriously blocks
//     campaigns. A task whose title matches no keyword is marked needs_human,
//     not guessed at; the operator classifies it with --claim.
//   - Dependencies come from "depends on #N" / "blocked by #N" text. A
//     dependency on an issue that is NOT part of this campaign cannot be
//     satisfied, so that task is marked needs_human.
//   - Path-claim overlap between tasks is detected but not resolved here; the
//     caller decides (start refuses; the scheduler also guards at run time).

import type { CampaignTask } from "./types.ts";

export interface IssueInput {
	number: number;
	title: string;
	body: string;
}

// Keyword -> repo-relative path claims. First match wins per keyword; a task can
// match several keywords and accumulate their claims (deduped). Literal paths
// and `dir/**` subtree globs only. Tuned to this repo's layout; this is a
// dogfooding heuristic, not a general classifier.
const CLAIM_HEURISTIC: ReadonlyArray<{ keyword: RegExp; paths: readonly string[] }> = [
	{ keyword: /\bMCP\b/i, paths: ["apps/cli/src/surfaces/mcp/**"] },
	{
		keyword: /\bconverge\b/i,
		paths: ["apps/cli/src/cli/converge.ts", "apps/cli/src/cli/converge.test.ts"],
	},
	{ keyword: /\baudit\b/i, paths: ["apps/cli/src/audit/**", "apps/studio/src/server/audit.ts"] },
	{ keyword: /\bdocs?\b/i, paths: ["README.md", "notes/**", "apps/site/content/docs/**"] },
];

// Derive path claims from the issue TITLE. Returns a deduped, sorted list; empty
// when nothing matched (the caller treats empty as "needs_human"). The body is
// deliberately ignored: see the module header.
export function deriveClaims(title: string): string[] {
	const claims = new Set<string>();
	for (const { keyword, paths } of CLAIM_HEURISTIC) {
		if (keyword.test(title)) {
			for (const p of paths) claims.add(p);
		}
	}
	return [...claims].sort();
}

// Extract issue numbers this issue declares a dependency on, from
// "depends on #N" / "blocked by #N" phrasing (comma lists supported:
// "depends on #3, #9"). Deduped, in first-seen order.
export function extractDependencies(body: string): number[] {
	const found: number[] = [];
	const seen = new Set<number>();
	// Match the phrase, then sweep the run of "#N" tokens that follows it.
	const phrase = /\b(?:depends on|blocked by)\b/gi;
	let m: RegExpExecArray | null;
	// biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec loop
	while ((m = phrase.exec(body)) !== null) {
		const rest = body.slice(m.index + m[0].length);
		// Consume a leading list of "#N" tokens separated by commas/"and"/spaces.
		const list = rest.match(/^[\s:]*((?:#\d+(?:\s*(?:,|and)\s*)?)+)/i);
		if (!list?.[1]) continue;
		for (const num of list[1].matchAll(/#(\d+)/g)) {
			const n = Number(num[1]);
			if (!seen.has(n)) {
				seen.add(n);
				found.push(n);
			}
		}
	}
	return found;
}

// Build campaign tasks from the issues. `explicitClaims` maps a task id
// (e.g. "issue-9") to operator-supplied path claims; when present for a task
// they REPLACE the heuristic claims and clear the "no claims" needs_human
// reason. A dependency on an issue outside the campaign cannot be satisfied, so
// that task is marked needs_human regardless of claims.
export function planTasks(
	issues: IssueInput[],
	explicitClaims: Record<string, string[]> = {},
): CampaignTask[] {
	const present = new Set(issues.map((i) => i.number));
	return issues.map((issue) => {
		const id = `issue-${issue.number}`;
		const override = explicitClaims[id];
		const claims =
			override && override.length > 0 ? [...override].sort() : deriveClaims(issue.title);
		const depNumbers = extractDependencies(issue.body);
		const outside = depNumbers.filter((n) => !present.has(n));
		const dependencies = depNumbers.filter((n) => present.has(n)).map((n) => `issue-${n}`);

		const reasons: string[] = [];
		if (claims.length === 0) {
			reasons.push(
				`no path claims matched the title heuristic; classify with --claim ${id}=<paths>`,
			);
		}
		if (outside.length > 0) {
			reasons.push(
				`depends on issue(s) not in this campaign: ${outside.map((n) => `#${n}`).join(", ")}`,
			);
		}

		const task: CampaignTask = {
			id,
			issueNumber: issue.number,
			title: issue.title,
			body: issue.body,
			status: reasons.length > 0 ? "needs_human" : "pending",
			dependencies,
			claimedPaths: claims,
		};
		if (reasons.length > 0) task.error = reasons.join("; ");
		return task;
	});
}

// --- path-claim overlap ---

interface ClaimShape {
	base: string;
	isDir: boolean;
}

function shape(claim: string): ClaimShape {
	if (claim.endsWith("/**")) return { base: claim.slice(0, -3), isDir: true };
	if (claim.endsWith("/")) return { base: claim.slice(0, -1), isDir: true };
	return { base: claim, isDir: false };
}

// True when two claims could touch the same file. Equal claims overlap; a
// subtree (`dir/**`) overlaps anything under it (files or nested subtrees).
export function pathsOverlap(a: string, b: string): boolean {
	const sa = shape(a);
	const sb = shape(b);
	if (sa.base === sb.base) return true;
	if (sa.isDir && (sb.base === sa.base || sb.base.startsWith(`${sa.base}/`))) return true;
	if (sb.isDir && (sa.base === sb.base || sa.base.startsWith(`${sb.base}/`))) return true;
	return false;
}

// True when any claim of one task overlaps any claim of the other.
export function tasksClaimsOverlap(a: CampaignTask, b: CampaignTask): boolean {
	return a.claimedPaths.some((pa) => b.claimedPaths.some((pb) => pathsOverlap(pa, pb)));
}

// All pairs of tasks whose claims overlap. Used by `start` to refuse a campaign
// with conflicting claims up front.
export function findClaimOverlaps(tasks: CampaignTask[]): Array<{ a: string; b: string }> {
	const pairs: Array<{ a: string; b: string }> = [];
	for (let i = 0; i < tasks.length; i++) {
		for (let j = i + 1; j < tasks.length; j++) {
			const ti = tasks[i];
			const tj = tasks[j];
			if (ti && tj && tasksClaimsOverlap(ti, tj)) pairs.push({ a: ti.id, b: tj.id });
		}
	}
	return pairs;
}
