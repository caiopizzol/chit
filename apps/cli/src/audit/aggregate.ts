// Cross-run receipt aggregator: the metrics-only roll-up over the per-run audit
// receipts. Where reader.ts answers "what happened in ONE run", this answers
// "what happened across the last N runs" - how many were considered, how many
// converged vs failed/blocked/timed out, the recipe breakdown, and the reviewer
// (convergence) signal - WITHOUT ever opening a blob body.
//
// It folds existing RunSummary values (from summarizeRun) plus the per-run
// loop.iteration.recorded events into one ReceiptAggregate. It reuses reader.ts
// for the per-run summary and never sets includeBodies / reads blobs/, so a
// prompt, model output, or raw adapter stream can never reach the aggregate.
//
// Privacy: the output is metrics and low-cardinality safe enums only (surface,
// run status, loop verdict/decision, recipe id) plus numeric sums and an ISO
// time range. It deliberately never emits cwd, commandArgs, manifestPath, scope
// (an input filter only - it is a user-chosen label that can identify work),
// step.failed error strings, or the free-form checksRun prose (which can carry
// command lines / absolute paths). Verification source is reduced to a count.

import type { AdapterUsage, AuditEvent, AuditSurface, AuditVerdict } from "@chit-run/core";
import { type RunSummary, safeReadEvents, summarizeRun } from "./reader.ts";
import type { AuditStore } from "./store.ts";

// Verdict/decision are the same three-valued enum; an aggregate carries a count
// per value. proceed = converged this iteration, block = blocked, revise = another
// round requested.
export type VerdictCounts = Record<AuditVerdict, number>;

// The reviewer (convergence) signal, folded from loop.iteration.recorded events.
// verdicts is the REVIEWER's call per iteration; decisions is the orchestrator's
// resolved decision. They usually agree, but a driver can override, so both are
// kept. withVerificationSource counts iterations whose reviewer reported real
// checks (a verification source), so the operator can see how many convergence
// rounds were actually backed by checks vs unreported.
export interface ConvergenceTotals {
	iterations: number;
	verdicts: VerdictCounts;
	decisions: VerdictCounts;
	findingCount: number;
	withVerificationSource: number;
}

export interface ReceiptAggregate {
	// Runs folded into this aggregate (after filters + limit).
	runs: number;
	// Runs whose log was empty or unreadable (corrupt/mid-write): counted, never
	// folded, never a throw. A data-health signal, not a folded run.
	skipped: number;
	bySurface: Record<string, number>;
	// Run status counts: ok | failed | cancelled | timeout | incomplete. "ok" is a
	// completed/converged run; "incomplete" is no run.completed (failed, cancelled,
	// or abandoned mid-flight).
	byStatus: Record<string, number>;
	// Recipe id -> count, over runs that declared a recipe. Absent recipe is simply
	// not counted (the breakdown is "when available", per the task).
	byRecipe: Record<string, number>;
	// Sum of per-run step counts (completed steps).
	steps: number;
	// Count of step.failed events across the folded runs.
	failedSteps: number;
	// Summed adapter usage across runs (tokens + reported cost floor). Absent when
	// no folded run reported any usage.
	usage?: AdapterUsage;
	convergence: ConvergenceTotals;
	// Earliest/latest startedAt observed among folded runs, ISO. Absent when no
	// folded run carried a startedAt.
	timeRange?: { earliest: string; latest: string };
}

export interface AggregateOptions {
	// ISO inclusive lower/upper bounds on a run's startedAt. A run without a
	// startedAt is excluded when either bound is set (it cannot be placed in time).
	since?: string;
	until?: string;
	// Restrict to one audit surface.
	surface?: AuditSurface;
	// Restrict to one scope. INPUT ONLY: scope is a user-chosen, potentially
	// identifying label, so it filters but is never a grouped output dimension.
	scope?: string;
	// Restrict to runs that belong to ONE repo. The audit store is a single
	// per-user state dir shared across every repo, so without this the roll-up
	// would mix unrelated repos. A run belongs when its recorded run.started.cwd
	// resolves (via resolveRepoRoot) to this same repo root. INPUT ONLY: like
	// scope, the repo root is a filter and is never emitted (it is an absolute
	// local path). A run with no recorded cwd is excluded when this is set.
	repoRoot?: string;
	// How a recorded cwd is canonicalized to its repo root (git top-level). Injected
	// so the fold stays pure and testable; the CLI passes location.ts's repoRoot,
	// which makes a run from any subdir of the repo match. Defaults to identity,
	// so a caller that already passes canonical roots needs no resolver.
	resolveRepoRoot?: (cwd: string) => string;
	// Cap on runs folded, applied AFTER sorting candidates by startedAt descending
	// (newest first). listRuns order is arbitrary, so the sort happens before the
	// slice - exactly as listAudit does.
	limit?: number;
}

const USAGE_KEYS: (keyof AdapterUsage)[] = [
	"inputTokens",
	"outputTokens",
	"totalTokens",
	"cachedInputTokens",
	"reasoningTokens",
	"estimatedCostUsd",
];

// checksRun is free-form reviewer prose ("the non-mutating checks you ran, or
// 'none'"); when the reviewer ran nothing the driver records "none" or the
// "unreported" fallback. We never emit the prose (it can carry command lines /
// paths); we only ask whether it names a real verification source.
const NO_VERIFICATION_SOURCE: ReadonlySet<string> = new Set(["none", "unreported", ""]);

function hasVerificationSource(checksRun: string): boolean {
	return !NO_VERIFICATION_SOURCE.has(checksRun.trim().toLowerCase());
}

// What one run contributes to the aggregate, extracted in a single pass so the
// run's events (dominated ~200x by adapter.event rows, never summarized) can be
// dropped before the next run is read. Keeps the roll-up's memory bounded across
// hundreds of runs.
interface RunContribution {
	summary: RunSummary;
	failedSteps: number;
	recipeId?: string;
	iterations: {
		verdict: AuditVerdict;
		decision: AuditVerdict;
		findingCount: number;
		hasSource: boolean;
	}[];
}

function extractContribution(summary: RunSummary, events: AuditEvent[]): RunContribution {
	const contribution: RunContribution = { summary, failedSteps: 0, iterations: [] };
	for (const e of events) {
		if (e.type === "step.failed") {
			contribution.failedSteps++;
		} else if (e.type === "run.started" && e.recipe !== undefined) {
			contribution.recipeId = e.recipe.id;
		} else if (e.type === "loop.iteration.recorded") {
			contribution.iterations.push({
				verdict: e.verdict,
				decision: e.decision,
				findingCount: e.findingCount,
				hasSource: hasVerificationSource(e.checksRun),
			});
		}
	}
	return contribution;
}

// The cwd recorded on a run's run.started event, used ONLY as an internal repo
// filter input (never emitted). Absent when the run has no run.started.
function runCwd(events: AuditEvent[]): string | undefined {
	const started = events.find((e) => e.type === "run.started");
	return started?.type === "run.started" ? started.cwd : undefined;
}

function matchesFilters(summary: RunSummary, opts: AggregateOptions): boolean {
	if (opts.surface !== undefined && summary.surface !== opts.surface) return false;
	if (opts.scope !== undefined && summary.scope !== opts.scope) return false;
	if (opts.since !== undefined || opts.until !== undefined) {
		// A run with no startedAt cannot be placed in a time window: exclude it
		// rather than silently treat it as matching.
		if (summary.startedAt === undefined) return false;
		if (opts.since !== undefined && summary.startedAt < opts.since) return false;
		if (opts.until !== undefined && summary.startedAt > opts.until) return false;
	}
	return true;
}

function emptyVerdictCounts(): VerdictCounts {
	return { proceed: 0, revise: 0, block: 0 };
}

function increment(counts: Record<string, number>, key: string): void {
	counts[key] = (counts[key] ?? 0) + 1;
}

function addUsage(total: AdapterUsage, usage: AdapterUsage): void {
	for (const k of USAGE_KEYS) {
		const v = usage[k];
		if (typeof v === "number") total[k] = (total[k] ?? 0) + v;
	}
}

// Fold every durable audit receipt in the store into one metrics-only aggregate.
//
// Algorithm (mirrors the handoff and listAudit's ordering contract):
//   1. Enumerate runs via store.listRuns() - arbitrary filesystem order.
//   2. Per run: safeReadEvents (never throws) then summarizeRun. An empty or
//      unreadable log folds in as a counted skip, not a throw, and is not a
//      candidate.
//   3. Apply since/until/surface/scope filters to the readable candidates.
//   4. Sort candidates by startedAt DESCENDING before applying limit, so the cap
//      keeps the newest runs regardless of listRuns order.
//   5. Fold the kept summaries + their loop.iteration.recorded events into the
//      accumulators. No blob is ever opened.
export function aggregateReceipts(
	store: AuditStore,
	opts: AggregateOptions = {},
): ReceiptAggregate {
	if (opts.limit !== undefined && (!Number.isInteger(opts.limit) || opts.limit < 0)) {
		throw new Error("aggregateReceipts: limit must be a non-negative integer");
	}

	// Resolve a recorded cwd to its repo root at most once per distinct cwd: the
	// resolver may shell out to git, and hundreds of runs typically share a cwd.
	const resolve = opts.resolveRepoRoot ?? ((cwd: string) => cwd);
	const rootCache = new Map<string, string>();
	const repoRootOf = (cwd: string): string => {
		const cached = rootCache.get(cwd);
		if (cached !== undefined) return cached;
		const root = resolve(cwd);
		rootCache.set(cwd, root);
		return root;
	};

	const candidates: RunContribution[] = [];
	let skipped = 0;
	for (const runId of store.listRuns()) {
		const events = safeReadEvents(store, runId);
		// An empty log is a corrupt/mid-write/empty run: count it as a skip and move
		// on, never letting one bad run abort the whole roll-up.
		if (events.length === 0) {
			skipped++;
			continue;
		}
		const summary = summarizeRun(runId, events);
		if (!matchesFilters(summary, opts)) continue;
		// Repo scoping: keep only runs whose recorded cwd resolves to the target
		// repo root. A run without a recorded cwd cannot be confirmed to belong, so
		// it is excluded (not a skip - it is simply out of scope).
		if (opts.repoRoot !== undefined) {
			const cwd = runCwd(events);
			if (cwd === undefined || repoRootOf(cwd) !== opts.repoRoot) continue;
		}
		candidates.push(extractContribution(summary, events));
	}

	candidates.sort((a, b) => (b.summary.startedAt ?? "").localeCompare(a.summary.startedAt ?? ""));
	const kept = opts.limit !== undefined ? candidates.slice(0, opts.limit) : candidates;

	const aggregate: ReceiptAggregate = {
		runs: 0,
		skipped,
		bySurface: {},
		byStatus: {},
		byRecipe: {},
		steps: 0,
		failedSteps: 0,
		convergence: {
			iterations: 0,
			verdicts: emptyVerdictCounts(),
			decisions: emptyVerdictCounts(),
			findingCount: 0,
			withVerificationSource: 0,
		},
	};
	const usage: AdapterUsage = {};
	let anyUsage = false;
	let earliest: string | undefined;
	let latest: string | undefined;

	for (const c of kept) {
		const s = c.summary;
		aggregate.runs++;
		increment(aggregate.bySurface, s.surface);
		increment(aggregate.byStatus, s.status);
		if (c.recipeId !== undefined) increment(aggregate.byRecipe, c.recipeId);
		aggregate.steps += s.stepCount;
		aggregate.failedSteps += c.failedSteps;
		if (s.usage !== undefined) {
			addUsage(usage, s.usage);
			anyUsage = true;
		}
		for (const it of c.iterations) {
			aggregate.convergence.iterations++;
			aggregate.convergence.verdicts[it.verdict]++;
			aggregate.convergence.decisions[it.decision]++;
			aggregate.convergence.findingCount += it.findingCount;
			if (it.hasSource) aggregate.convergence.withVerificationSource++;
		}
		if (s.startedAt !== undefined) {
			if (earliest === undefined || s.startedAt < earliest) earliest = s.startedAt;
			if (latest === undefined || s.startedAt > latest) latest = s.startedAt;
		}
	}

	if (anyUsage) aggregate.usage = usage;
	if (earliest !== undefined && latest !== undefined) {
		aggregate.timeRange = { earliest, latest };
	}
	return aggregate;
}
