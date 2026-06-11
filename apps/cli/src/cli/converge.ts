// `chit converge` — the autonomous convergence driver. It runs the
// implement/check loop end to end and records it to the convergence log, so
// the chit-develops-chit cycle is one command instead of a manual MCP +
// loop-log dance. Each iteration runs the converge manifest (a write-capable
// Claude implements a slice, a read-only Codex reviews the diff), parses the
// reviewer's verdict, appends an iteration record, and either stops or feeds
// the review back in for another round.
//
// This is the MVP autonomous loop: it follows the reviewer's verdict with no
// human-in-the-loop pause (a later slice). It NEVER assumes proceed — an
// unparseable verdict fails safe to `block`.
//
// The loop logic lives in convergeLoop(), which takes an injected `execute`
// callback so it is unit-testable without spawning real agents. runConverge()
// is the CLI shell: it parses flags, loads the manifest + registry, builds the
// real adapter-backed execute, and prints a summary.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	type AdapterUsage,
	type AuditParticipantSnapshot,
	findEnforcementGaps,
	findUnknownAgents,
	formatEnforcementGaps,
	type LoopCheck,
	type LoopIterationRecordedEvent,
	type LoopStopStatus,
	type LoopVerdict,
	type NormalizedConfig,
	type NormalizedRegistry,
	type NormalizedRole,
	parseManifest,
	type RecipeReceipt,
	type RequiredCheck,
	type ResolvedManifest,
	resolveManifest,
	resolveParticipantSnapshots,
	type Verification,
	type VerificationSource,
} from "@chit-run/core";
import { buildAdapter } from "../adapters/factory.ts";
import { AuditRecorder } from "../audit/recorder.ts";
import { AuditStore } from "../audit/store.ts";
import { wrapAdaptersWithAudit } from "../audit/wrap.ts";
import { loadConfig } from "../config/load.ts";
import { appendIteration, startLoop, stopLoop } from "../loops/log-store.ts";
import {
	type CheckResult,
	checkResultsToLoopChecks,
	runRequiredChecks,
} from "../loops/required-checks.ts";
import { executeManifest } from "../runtime/execute.ts";
import type {
	AdapterEvent,
	AdapterMap,
	PromptAugmenter,
	RunResult,
	TraceEvent,
} from "../runtime/types.ts";
import { wrapAdaptersWithSessions } from "../sessions/coordinator.ts";
import { defaultSessionDir, FileSessionStore } from "../sessions/store.ts";
import type { SessionStore } from "../sessions/types.ts";
import { DEFAULT_CONVERGE_MANIFEST } from "./default-converge-manifest.ts";
import { classifyWorkspace, type WorkspaceClassification } from "./workspace.ts";

export interface ConvergeIO {
	out: (s: string) => void;
	err: (s: string) => void;
}

const defaultIO: ConvergeIO = {
	out: (s) => process.stdout.write(s),
	err: (s) => process.stderr.write(s),
};

// The reviewer emits a machine-readable fenced ```json block (see
// examples/converge.json) with verdict/findingCount/checksRun/risk. The driver
// parses that for the loop record. The prompt puts the block LAST, after prose
// that may itself contain an earlier example ```json block, so we parse the
// final block (not the first). If no valid block is present, the driver fails
// safe to `block` — it NEVER derives a verdict from prose. (The reviewer often
// echoes the "proceed / revise / block" option list; reading that as a verdict
// would defeat the fail-safe.) The driver never assumes proceed.
const JSON_BLOCK_RE = /```json\s*([\s\S]*?)```/gi;
const VERDICTS: ReadonlySet<string> = new Set(["proceed", "revise", "block"]);

// The converge contract: the driver needs to know which call steps are the
// implementer and the reviewer. These are the DEFAULTS, used when a manifest
// declares no loop policy (a converge-shaped manifest authored before the
// policy field, or any manifest run through this driver without one). A manifest
// with `policy: { kind: "loop", implementStep, reviewStep }` overrides them.
const IMPLEMENT_STEP_ID = "implement";
const REVIEW_STEP_ID = "review";

// The implementer/reviewer step ids the driver should key on for this manifest:
// the loop policy's steps when declared, else the defaults. Keeping the default
// fallback means a converge-shaped manifest with no policy still runs exactly as
// before (zero behavior change).
export interface LoopSteps {
	implementStep: string;
	reviewStep: string;
	// chit-executed verification commands from the loop policy, when declared.
	requiredChecks?: RequiredCheck[];
}
export function resolveLoopPolicy(manifest: ResolvedManifest): LoopSteps {
	if (manifest.policy.kind === "loop") {
		return {
			implementStep: manifest.policy.implementStep,
			reviewStep: manifest.policy.reviewStep,
			...(manifest.policy.requiredChecks && { requiredChecks: manifest.policy.requiredChecks }),
		};
	}
	return { implementStep: IMPLEMENT_STEP_ID, reviewStep: REVIEW_STEP_ID };
}

// The safe skeleton of one intra-call adapter event: which step/participant/
// agent emitted it and the raw event's type, NEVER the raw payload. The raw
// line can carry prompts, outputs, and tool arguments, so a live observer
// (a driver tailing event activity) gets identity + type only; the full raw
// body stays where it is access-controlled, in the audit transcript.
export interface AdapterEventSkeleton {
	stepId: string;
	participantId: string;
	agentId: string;
	type: string;
}

// implementSummary in the log is a digest, not the full transcript. Cap it so
// a long Claude summary does not bloat the .jsonl record.
const IMPLEMENT_SUMMARY_CAP = 2000;

// The loop record requires a non-empty checksRun string. Used when the JSON
// block is absent/invalid, or present but without a usable checksRun.
const CHECKS_RUN_FALLBACK = "unreported";

type LoopIterationAuditFields = Omit<LoopIterationRecordedEvent, "type" | "runId" | "ts">;

interface ConvergeAuditLink {
	auditRunId?: string;
	recordLoopIteration?: (event: LoopIterationAuditFields) => void;
}

// The injectable execution boundary: one convergence iteration's manifest run.
// The default (buildExecute) runs the real adapter-backed manifest; tests pass
// a fake returning canned outputs so the loop logic runs without spawning
// agents.
// The execute result is the manifest RunResult plus an optional auditRunId: the
// audit run this iteration was recorded under, used to link the loop iteration
// record to its audit transcript. auditRunId is WITHHELD when the audit write
// failed, so a loop record never links to a missing transcript. `ctx` carries
// the loop position so the audit run.started can name its source loop/iteration.
// Both ctx and auditRunId are optional, so a fake/non-audited execute (tests, or
// a future caller that does not audit) still satisfies the contract. ctx.signal,
// when present, is threaded to the manifest run so an in-flight iteration can be
// cancelled (the MCP converge surface passes one; the CLI driver does not).
export type ConvergeExecute = (
	inputs: { task: string; prior_review: string },
	ctx?: {
		loopId: string;
		iteration: number;
		recipe?: RecipeReceipt;
		signal?: AbortSignal;
		// Live per-step trace, in addition to the audit recorder. The background
		// worker uses it to surface the current phase (implementing/reviewing).
		onTrace?: (event: TraceEvent) => void;
		// Live per-adapter-event skeletons (ids + event type only, never the raw
		// payload), in addition to the audit recorder, so a driver can show
		// fine-grained activity between step boundaries. Best-effort: a throwing
		// observer never breaks the run.
		onAdapterEvent?: (event: AdapterEventSkeleton) => void;
		// Optional per-call prompt augmentation. Plan handoffs use this to place
		// produced handoff bodies in the reviewer prompt after the implementer
		// has run, without changing the converge manifest vocabulary.
		promptAugment?: PromptAugmenter;
	},
) => Promise<RunResult & ConvergeAuditLink>;

export interface ConvergeLoopOptions {
	cwd: string;
	scope: string;
	task: string;
	maxIterations: number;
	loopId?: string;
	force?: boolean;
	execute: ConvergeExecute;
	// The implementer/reviewer step ids (from the manifest's loop policy). Default
	// to the converge constants when absent.
	implementStep?: string;
	reviewStep?: string;
	// chit-executed verification commands (from the loop policy), when declared.
	requiredChecks?: RequiredCheck[];
}

export interface ConvergeResult {
	loopId: string;
	iterations: number;
	status: LoopStopStatus;
	// Set when the loop ended because a manifest run FAILED (result.ok === false),
	// as opposed to a reviewer `block` verdict on a successful run. Both stop the
	// loop as "blocked", but only a failure is a CLI error: runConverge maps a
	// present `failure` to a non-zero exit, while a normal blocked verdict on a
	// successful run stays exit 0.
	failure?: string;
}

// What the driver records from a review: the real verdict, finding count, and
// checks the reviewer ran — structured, not guessed.
interface ParsedReview {
	verdict: LoopVerdict;
	findingCount: number;
	checksRun: string;
	// Structured checks the reviewer reported running, and their rollup. Source is
	// the reviewer (model-reported) in this slice; chit-executed required_checks
	// become the authoritative source later. The loop gates `converged` on
	// verification, NOT on the verdict alone.
	checks: LoopCheck[];
	verification: Verification;
}

const CHECK_STATUSES: ReadonlySet<string> = new Set(["passed", "failed", "blocked"]);

// Parse the reviewer's self-reported `checks` array from the (untrusted) review
// block. Never throws: a malformed entry is dropped from `checks` but RECORDED in
// `malformed`, because dropping-and-ignoring is unsafe once verification gates
// convergence -- a reviewer that emits one valid passed check and one garbled
// failure must not roll up to `passed`. `malformed` is also true when `checks` is
// present but not an array at all. Absent `checks` (undefined) is honest no-checks,
// not malformed.
function parseChecks(raw: unknown): { checks: LoopCheck[]; malformed: boolean } {
	if (raw === undefined) return { checks: [], malformed: false };
	if (!Array.isArray(raw)) return { checks: [], malformed: true };
	const checks: LoopCheck[] = [];
	let malformed = false;
	for (const e of raw) {
		if (typeof e !== "object" || e === null) {
			malformed = true;
			continue;
		}
		const r = e as Record<string, unknown>;
		if (typeof r.command !== "string" || r.command.trim() === "") {
			malformed = true;
			continue;
		}
		if (typeof r.status !== "string" || !CHECK_STATUSES.has(r.status)) {
			malformed = true;
			continue;
		}
		const check: LoopCheck = { command: r.command.trim(), status: r.status as LoopCheck["status"] };
		if (typeof r.reason === "string" && r.reason.trim() !== "") check.reason = r.reason.trim();
		checks.push(check);
	}
	return { checks, malformed };
}

// The verification rollup the loop gates `converged` on. Fail-safe ordering: any
// failed -> failed; any blocked -> blocked; a malformed report -> blocked (it was
// reported but cannot be trusted, so it can NEVER improve to passed); no checks at
// all -> not_run; only then, every reported check passed and none was malformed ->
// passed. A proceed verdict with verification !== "passed" must not converge clean.
function deriveVerification(checks: LoopCheck[], malformed: boolean): Verification {
	if (checks.some((c) => c.status === "failed")) return "failed";
	if (checks.some((c) => c.status === "blocked")) return "blocked";
	if (malformed) return "blocked";
	if (checks.length === 0) return "not_run";
	return "passed";
}

// The LAST fenced ```json block, parsed to an object — or null if absent or
// not valid JSON / not an object. We take the final block because the review
// prompt places the machine-readable block after the human prose.
function extractReviewJson(reviewText: string): Record<string, unknown> | null {
	let last: string | undefined;
	for (const m of reviewText.matchAll(JSON_BLOCK_RE)) {
		if (m[1] !== undefined) last = m[1];
	}
	if (last === undefined) return null;
	try {
		const parsed: unknown = JSON.parse(last);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>;
		}
	} catch {
		// malformed JSON in the last block -> treat as no usable block
	}
	return null;
}

// Read the verdict and metrics from the structured JSON block. If the block is
// absent or invalid, fail safe to `block` with no metrics — the driver never
// derives a verdict from prose, so an echoed option list cannot read as proceed.
function parseReview(reviewText: string): ParsedReview {
	const block = extractReviewJson(reviewText);
	const rawVerdict = typeof block?.verdict === "string" ? block.verdict.toLowerCase() : undefined;
	if (block && rawVerdict && VERDICTS.has(rawVerdict)) {
		const fc = block.findingCount;
		const cr = block.checksRun;
		const { checks, malformed } = parseChecks(block.checks);
		return {
			verdict: rawVerdict as LoopVerdict,
			findingCount: typeof fc === "number" && Number.isInteger(fc) && fc >= 0 ? fc : 0,
			checksRun: typeof cr === "string" && cr.trim() !== "" ? cr.trim() : CHECKS_RUN_FALLBACK,
			checks,
			verification: deriveVerification(checks, malformed),
		};
	}
	// No usable block: fail safe to block, with no checks (verification not_run).
	return {
		verdict: "block",
		findingCount: 0,
		checksRun: CHECKS_RUN_FALLBACK,
		checks: [],
		verification: "not_run",
	};
}

// Map a step.started trace event to the loop phase it represents: the implement
// step -> "implementing", the review step -> "reviewing", anything else (or any
// non-step.started event) -> undefined. The SINGLE source for the trace-event ->
// phase mapping, shared by the background worker's onTrace and the foreground
// chit_next heartbeats, so the two surfaces can never drift.
export function phaseOfStepStart(
	event: TraceEvent,
	implementStep: string,
	reviewStep: string,
): "implementing" | "reviewing" | undefined {
	if (event.type !== "step.started") return undefined;
	if (event.stepId === implementStep) return "implementing";
	if (event.stepId === reviewStep) return "reviewing";
	return undefined;
}

// The review step's own duration from the run trace — the check duration. 0 if
// the trace has no completed review step (e.g. an injected fake without one).
// Keyed on the configured reviewStep, not a literal, so a loop policy with a
// non-default reviewer step name still measures the right step.
function reviewDurationMs(trace: TraceEvent[], reviewStep: string): number {
	for (const e of trace) {
		if (e.type === "step.completed" && e.stepId === reviewStep) return e.durationMs;
	}
	return 0;
}

const USAGE_KEYS: (keyof AdapterUsage)[] = [
	"inputTokens",
	"outputTokens",
	"totalTokens",
	"cachedInputTokens",
	"reasoningTokens",
	"estimatedCostUsd",
];

// Total usage for the iteration: sum every completed call step's usage in the
// run (implement + review). Per field, so a field absent from all steps stays
// absent (not zero). Each step's usage is already a valid AdapterUsage (the
// adapters guarantee it), so the per-field sum stays valid. Returns undefined
// when no step reported usage. Cost sums only the providers that report one, so
// it is a known-cost floor, not a guaranteed total spend.
function sumTraceUsage(trace: TraceEvent[]): AdapterUsage | undefined {
	const usage: AdapterUsage = {};
	let any = false;
	for (const e of trace) {
		if (e.type !== "step.completed" || !e.usage) continue;
		for (const k of USAGE_KEYS) {
			const v = e.usage[k];
			if (typeof v === "number") {
				usage[k] = (usage[k] ?? 0) + v;
				any = true;
			}
		}
	}
	return any ? usage : undefined;
}

function capSummary(text: string): string {
	// The record rejects empty strings; a run that produced no summary still
	// needs a placeholder.
	if (text === "") return "(no summary)";
	if (text.length <= IMPLEMENT_SUMMARY_CAP) return text;
	return `${text.slice(0, IMPLEMENT_SUMMARY_CAP)}… (truncated, ${text.length} chars)`;
}

// Changed files for the iteration record. Best-effort: a non-git cwd (or any
// git failure) yields [] for that command rather than aborting the loop.
function gitLines(cwd: string, args: string[]): string[] {
	try {
		const out = execFileSync("git", args, {
			cwd,
			encoding: "utf-8",
			// Capture stdout only; never leak git's stderr (e.g. "not a git
			// repository") to the driver's own output.
			stdio: ["ignore", "pipe", "ignore"],
		});
		return out
			.split("\n")
			.map((s) => s.trim())
			.filter(Boolean);
	} catch {
		return [];
	}
}

// Snapshot the working tree and classify it into the task's changed files vs
// non-task workspace dirt (see workspace.ts). Tracked unstaged + staged are the
// task edits; untracked (non-ignored) files are split into new source (task
// work) and generated artifacts (surfaced as workspaceWarnings). A new file is
// untracked, so `git diff --name-only` alone would silently omit it.
function gitWorkspace(cwd: string): WorkspaceClassification {
	return classifyWorkspace({
		tracked: [
			...gitLines(cwd, ["diff", "--name-only"]),
			...gitLines(cwd, ["diff", "--cached", "--name-only"]),
		],
		untracked: gitLines(cwd, ["ls-files", "--others", "--exclude-standard"]),
	});
}

// One iteration's loop position and the execute boundary it runs against. The
// loop (start/stop, prior_review threading, stop decision) is the caller's job;
// this is just what a single implement -> check round needs. `scope` is not here
// because it is already baked into `execute` (buildExecute closes over it); the
// only per-iteration audit linkage is loopId + iteration, passed to execute.
export interface ConvergeIterationContext {
	cwd: string;
	loopId: string;
	iteration: number;
	task: string;
	prior_review: string;
	execute: ConvergeExecute;
	// The implementer/reviewer step ids to read from the run's outputs and trace.
	// Default to the converge constants (implement/review) when absent, so callers
	// that don't yet resolve a manifest's loop policy keep their prior behavior.
	implementStep?: string;
	reviewStep?: string;
	// chit-executed verification: when present AND the reviewer returns proceed, chit
	// runs these in cwd and their result is authoritative over the reviewer's report.
	requiredChecks?: RequiredCheck[];
	// When present, threaded to execute so the iteration's manifest run can be
	// cancelled mid-flight. Absent for the CLI driver (uncancellable, as before).
	signal?: AbortSignal;
	// When present, threaded to execute so a driver (the background worker) can
	// observe per-step progress and surface the current phase.
	onTrace?: (event: TraceEvent) => void;
	// When present, threaded to execute so a driver can observe safe per-event
	// skeletons (ids + event type, never the raw payload) between step boundaries.
	onAdapterEvent?: (event: AdapterEventSkeleton) => void;
	// Optional per-call prompt augmentation, forwarded to execute. Background
	// plan jobs use it for review-only handoff context.
	promptAugment?: PromptAugmenter;
	recipe?: RecipeReceipt;
	// When present, invoked immediately BEFORE chit runs the required checks, and
	// ONLY when there are checks to run, so a foreground driver can surface a
	// "running required checks" phase. Guarded: a throwing callback never breaks
	// the iteration (it still completes and appends).
	onChecksStart?: () => void;
}

// The structured next-state a single iteration hands back so the caller can
// decide continue-vs-stop and what prior_review to feed the next round. A
// discriminated union on `ok`:
//   - ok: false  -> the manifest run failed gracefully; `failure` is the reason
//     string (no iteration record was appended). The caller stops the loop.
//     `auditRunId` is still present when the audited execute recorded a clean
//     transcript before the run failed, so a failed iteration can still point at
//     its receipt instead of leaving a transcript on disk orphaned.
//   - ok: true   -> the iteration record was appended; the parsed verdict and
//     metrics are returned, plus `reviewText` (the next prior_review) and
//     `stopStatus` (converged for proceed WITH verification passed, needs-decision
//     for a proceed without it, blocked for block, undefined for revise -> continue).
//     `decision` == verdict (the autonomous driver follows
//     the reviewer). `auditRunId` is present only when the run was audited.
export type ConvergeIterationResult =
	| { ok: false; failure: string; auditRunId?: string }
	| {
			ok: true;
			verdict: LoopVerdict;
			findingCount: number;
			checksRun: string;
			decision: LoopVerdict;
			// The iteration's verification rollup + its source (reviewer self-report vs
			// chit-executed). Returned so the session/job can cache them for status views;
			// the loop log stays the durable source of truth.
			verification: Verification;
			verificationSource: VerificationSource;
			// The per-check results recorded on this iteration's log record (the SAME
			// outcome.checks; [] when no checks ran), returned so the MCP next response
			// can surface per-check names/statuses without re-reading the loop log. The
			// log stays the durable source of truth.
			checks: LoopCheck[];
			// The same changed files, workspace warnings, and usage written to the
			// iteration record, also returned so a caller (the MCP next response) can
			// surface them without re-reading the loop log. changedFiles is task work
			// only; workspaceWarnings is non-task dirt (empty when the tree was clean).
			// usage is absent when no call reported any.
			changedFiles: string[];
			workspaceWarnings: string[];
			usage?: AdapterUsage;
			auditRunId?: string;
			reviewText: string;
			stopStatus?: LoopStopStatus;
	  };

// Tags an error thrown by the injected execute (the manifest run itself), so the
// driver can tell a RUN throw apart from a post-run logging/append throw. This
// preserves the pre-refactor exception boundary: before the iteration body was
// extracted, only the execute call sat inside the driver's try, so a run throw
// closed the loop as blocked and rethrew, while a parse/append throw propagated
// raw with NO stop record. The tag keeps that split now that both live in the
// primitive. `message` mirrors the original reason text so the driver can build
// the same stop reason; `executeError` is the original error to rethrow.
// Exported so other drivers over runConvergeIteration (the MCP converge surface)
// preserve the same run-throw vs append-throw split, not just convergeLoop.
export class ConvergeExecuteError extends Error {
	readonly executeError: unknown;
	constructor(executeError: unknown) {
		super(executeError instanceof Error ? executeError.message : String(executeError));
		this.executeError = executeError;
	}
}

// A single implement -> check iteration: run the converge manifest once via the
// injected execute, and (on a successful run) append the iteration record with
// the same shape and fields the loop has always written. It does NOT own the
// outer loop and does NOT start or stop the loop (the caller does that). A
// graceful ok:false is returned as { ok: false, failure } for the caller to stop
// on. Throw boundary, matching the pre-extraction loop exactly: a throw FROM
// execute is re-thrown tagged as ConvergeExecuteError (the caller closes the loop
// as blocked and rethrows the original); a throw from parsing/appending the
// record propagates UNTAGGED, so the caller leaves the loop as it was (no stop
// record). No agent spawning here: that is entirely behind `execute`.
export async function runConvergeIteration(
	ctx: ConvergeIterationContext,
): Promise<ConvergeIterationResult> {
	let result: RunResult & ConvergeAuditLink;
	try {
		result = await ctx.execute(
			{ task: ctx.task, prior_review: ctx.prior_review },
			{
				loopId: ctx.loopId,
				iteration: ctx.iteration,
				...(ctx.recipe !== undefined && { recipe: ctx.recipe }),
				...(ctx.signal && { signal: ctx.signal }),
				...(ctx.onTrace && { onTrace: ctx.onTrace }),
				...(ctx.onAdapterEvent && { onAdapterEvent: ctx.onAdapterEvent }),
				...(ctx.promptAugment && { promptAugment: ctx.promptAugment }),
			},
		);
	} catch (e) {
		// Tag only the run throw. Everything below stays untagged and propagates
		// raw, preserving the original "no stop record on append failure" behavior.
		throw new ConvergeExecuteError(e);
	}

	if (!result.ok) {
		// A step failed gracefully. Hand the reason back so the caller can close
		// the loop as blocked; a failed run appends no iteration record. Pass the
		// auditRunId through when the audited execute still recorded a clean
		// transcript, so the caller (the background worker) can keep the link in
		// auditRefs rather than leave the transcript orphaned on disk.
		return {
			ok: false,
			failure: `manifest run failed at step "${result.failedStep}": ${result.error}`,
			...(result.auditRunId && { auditRunId: result.auditRunId }),
		};
	}

	const implementStep = ctx.implementStep ?? IMPLEMENT_STEP_ID;
	const reviewStep = ctx.reviewStep ?? REVIEW_STEP_ID;
	const reviewText = result.outputs[reviewStep] ?? "";
	const review = parseReview(reviewText);
	const usage = sumTraceUsage(result.trace);
	const { changedFiles, workspaceWarnings } = gitWorkspace(ctx.cwd);
	const checkDurationMs = reviewDurationMs(result.trace, reviewStep);

	// Decide the iteration. Reviewer-sourced by default; when the reviewer returns
	// proceed AND the loop declares requiredChecks, chit runs them itself and their
	// result is authoritative (and can override the proceed to revise). See
	// decideIteration for the full matrix.
	const outcome = await decideIteration(review, reviewText, ctx);

	const appended = appendIteration(ctx.cwd, ctx.loopId, {
		implementSummary: capSummary(result.outputs[implementStep] ?? ""),
		changedFiles,
		workspaceWarnings,
		checksRun: review.checksRun,
		// verification is ALWAYS recorded (the rollup the loop gates `converged` on, and
		// chit_trace surfaces as the reason a run stopped); the checks list when there
		// are any. verificationSource says whether it is the reviewer's self-report or
		// chit-executed (ground truth).
		...(outcome.checks.length > 0 && { checks: outcome.checks }),
		verification: outcome.verification,
		verificationSource: outcome.verificationSource,
		verdict: review.verdict,
		findingCount: review.findingCount,
		// The decision can DIVERGE from the verdict: a proceed whose chit-run checks
		// failed is recorded as a revise (chit sent it back).
		decision: outcome.decision,
		// The check (review) step's own duration, not the whole-run wall time.
		checkDurationMs,
		// Total token/cost across the run's calls (implement + review).
		...(usage && { usage }),
		// Link to the audit transcript for this iteration's run, when audited.
		...(result.auditRunId && { auditRef: result.auditRunId }),
	});
	try {
		result.recordLoopIteration?.({
			loopId: ctx.loopId,
			n: appended.n,
			verdict: review.verdict,
			decision: outcome.decision,
			findingCount: review.findingCount,
			changedFiles,
			checksRun: review.checksRun,
			checkDurationMs,
		});
	} catch {
		// Audit is observational. A bad custom hook must not turn a recorded iteration into failure.
	}

	return {
		ok: true,
		verdict: review.verdict,
		findingCount: review.findingCount,
		checksRun: review.checksRun,
		decision: outcome.decision,
		verification: outcome.verification,
		verificationSource: outcome.verificationSource,
		checks: outcome.checks,
		changedFiles,
		workspaceWarnings,
		...(usage && { usage }),
		...(result.auditRunId && { auditRunId: result.auditRunId }),
		// The next iteration's prior_review: the reviewer's text, with chit's check
		// failures prepended when chit overrode a proceed to revise.
		reviewText: outcome.priorReview,
		...(outcome.stopStatus && { stopStatus: outcome.stopStatus }),
	};
}

// The outcome of one iteration: what to record + what the loop does next. The
// decision can diverge from the reviewer's verdict (a proceed whose chit-run checks
// failed becomes a revise). priorReview is what the NEXT iteration sees.
interface IterationOutcome {
	checks: LoopCheck[];
	verification: Verification;
	verificationSource: VerificationSource;
	decision: LoopVerdict;
	stopStatus?: LoopStopStatus;
	priorReview: string;
}

// Decide an iteration from the reviewer's verdict and -- only when the reviewer
// returned proceed and the loop declares requiredChecks -- chit's own check results,
// which are AUTHORITATIVE over the reviewer's self-report. block/revise are the
// reviewer's call alone (the loop already cannot converge), so chit does not run
// checks there. On a proceed with declared checks:
//   all passed           -> converged (decision stays proceed)
//   any failed           -> revise (decision diverges; failures fed to prior_review;
//                           failed dominates a co-occurring blocked, as it is actionable)
//   blocked, none failed  -> needs-decision; decision stays proceed (the reviewer
//                           approved -- chit simply could not verify, NOT a reviewer block)
async function decideIteration(
	review: ParsedReview,
	reviewText: string,
	ctx: ConvergeIterationContext,
): Promise<IterationOutcome> {
	const required = ctx.requiredChecks;
	if (review.verdict !== "proceed" || !required || required.length === 0) {
		// Reviewer-sourced (Stage 1): the verdict is the decision and the reviewer's own
		// checks are the verification.
		const stopStatus: LoopStopStatus | undefined =
			review.verdict === "proceed"
				? review.verification === "passed"
					? "converged"
					: "needs-decision"
				: review.verdict === "block"
					? "blocked"
					: undefined;
		return {
			checks: review.checks,
			verification: review.verification,
			verificationSource: "reviewer",
			decision: review.verdict,
			...(stopStatus && { stopStatus }),
			priorReview: reviewText,
		};
	}

	// Reviewer proceed + declared checks: chit runs them; their rollup is the truth.
	// Signal the checks phase first (we are past the no-checks early return, so there
	// is always at least one check to run here). Guarded so a throwing callback can
	// never break the iteration.
	if (ctx.onChecksStart) {
		try {
			ctx.onChecksStart();
		} catch {
			// Progress signalling is best-effort; swallow so the iteration still runs.
		}
	}
	const results = await runRequiredChecks(required, {
		cwd: ctx.cwd,
		...(ctx.signal && { signal: ctx.signal }),
	});
	const checks = checkResultsToLoopChecks(results);
	// deriveVerification orders failed before blocked, so failed dominates a co-occurring
	// blocked exactly as intended. malformed is false: chit's own results are never that.
	const verification = deriveVerification(checks, false);
	const base = { checks, verification, verificationSource: "chit" as const };

	if (verification === "failed") {
		// Actionable: override the reviewer's proceed to revise and feed the failures
		// back so the implementer fixes them.
		return {
			...base,
			decision: "revise",
			priorReview: `${checkFailureFeedback(results)}\n\nReviewer notes:\n${reviewText}`,
		};
	}
	if (verification === "passed") {
		return { ...base, decision: "proceed", stopStatus: "converged", priorReview: reviewText };
	}
	// blocked (or, defensively, not_run): chit could not verify. Keep the reviewer's
	// proceed -- do NOT rewrite their judgment -- but stop for a human to decide.
	return { ...base, decision: "proceed", stopStatus: "needs-decision", priorReview: reviewText };
}

// The compact, structured summary of FAILED chit checks (the actionable ones),
// prepended to the next prior_review so the implementer fixes the failures the
// reviewer's proceed missed. Blocked checks are not listed: they are not something the
// implementer fixes by editing code.
function checkFailureFeedback(results: CheckResult[]): string {
	const lines = results
		.filter((r) => r.status === "failed")
		.map((r) => {
			const head = `- ${r.command}${r.exitCode !== undefined ? `: exit ${r.exitCode}` : ""}`;
			const body = r.output
				? r.output
						.split("\n")
						.map((l) => `  ${l}`)
						.join("\n")
				: "";
			return body ? `${head}\n${body}` : head;
		});
	return `Chit ran required checks after the reviewer returned proceed. These checks failed:\n${lines.join("\n")}`;
}

// The single source of truth for a loop's terminal stop reason, shared by every
// driver (the CLI convergeLoop, the MCP runNextIteration, the background worker)
// so the wording can never drift between surfaces. The bug this prevents: a
// needs-decision stop mislabeled "reviewer returned block" because a driver wrote
// its own binary converged/block reason. Verdict and budget outcomes get fixed
// wording; cancellation carries a site `detail` (where and how it was cancelled).
// Step-failure stops do NOT come here -- their reason is the failure or throw
// message, which says more than a status string would. The switch is exhaustive
// over LoopStopStatus, so a newly added status will not compile until it is given
// wording here.
export function stopReasonFor(
	status: LoopStopStatus,
	ctx?: { maxIterations?: number; detail?: string },
): string {
	switch (status) {
		case "converged":
			return "reviewer returned proceed and verification passed";
		case "blocked":
			return "reviewer returned block";
		case "needs-decision":
			return "reviewer returned proceed but verification did not pass (checks failed, were blocked, or did not run)";
		case "max-iterations":
			return ctx?.maxIterations !== undefined
				? `reached max iterations (${ctx.maxIterations}) without converging`
				: "reached max iterations without converging";
		case "cancelled":
			return ctx?.detail ? `cancelled ${ctx.detail}` : "cancelled";
	}
}

// The pure loop: a thin driver over runConvergeIteration. startLoop, then run
// one iteration per round (deciding stop from its returned next-state), then
// stopLoop. No agent spawning here: that is entirely behind `execute`.
export async function convergeLoop(opts: ConvergeLoopOptions): Promise<ConvergeResult> {
	const { loopId } = startLoop(opts.cwd, {
		scope: opts.scope,
		task: opts.task,
		maxIterations: opts.maxIterations,
		loopId: opts.loopId,
		force: opts.force,
	});

	let priorReview = "";
	let iterations = 0;
	let status: LoopStopStatus | undefined;

	for (let i = 1; i <= opts.maxIterations; i++) {
		let iter: ConvergeIterationResult;
		try {
			iter = await runConvergeIteration({
				cwd: opts.cwd,
				loopId,
				iteration: i,
				task: opts.task,
				prior_review: priorReview,
				execute: opts.execute,
				...(opts.implementStep && { implementStep: opts.implementStep }),
				...(opts.reviewStep && { reviewStep: opts.reviewStep }),
				...(opts.requiredChecks && { requiredChecks: opts.requiredChecks }),
			});
		} catch (e) {
			if (e instanceof ConvergeExecuteError) {
				// The run threw (not a graceful ok:false). Close the loop as blocked so
				// it is not left open, then rethrow the ORIGINAL error for a clean CLI
				// error + non-zero exit.
				stopLoop(opts.cwd, loopId, {
					status: "blocked",
					reason: `manifest run threw: ${e.message}`,
				});
				throw e.executeError;
			}
			// A post-run throw (parsing/appending the iteration record). Propagate it
			// unchanged, adding no stop record, exactly as before the iteration body
			// was extracted into runConvergeIteration.
			throw e;
		}

		if (!iter.ok) {
			// A step failed gracefully. Failure is terminal: close the loop as
			// blocked with a clear reason rather than leaving it open. `failure` is
			// set so the CLI exits non-zero (a failed run is not a success).
			status = "blocked";
			stopLoop(opts.cwd, loopId, { status, reason: iter.failure });
			return { loopId, iterations, status, failure: iter.failure };
		}

		iterations++;

		if (iter.stopStatus !== undefined) {
			status = iter.stopStatus;
			break;
		}
		// revise: feed the review back in and go again.
		priorReview = iter.reviewText;
	}

	if (status === undefined) status = "max-iterations";

	stopLoop(opts.cwd, loopId, {
		status,
		reason: stopReasonFor(status, { maxIterations: opts.maxIterations }),
	});

	return { loopId, iterations, status };
}

// The default adapter-backed execute. Mirrors the run-command path: build one
// adapter per agent, wrap them in the per_scope session coordinator (converge
// is a per_scope manifest), and run the whole manifest to completion.
export function buildExecute(
	manifest: ResolvedManifest,
	registry: NormalizedRegistry,
	scope: string,
	cwd: string,
	// Per-run hard call-timeout override (ms). When set it REPLACES each resolved
	// agent's callTimeoutMs for this run only -- applied to EVERY participant, so the
	// implementer and reviewer share one budget. The agent record is never mutated (a
	// per-run copy), so config-level callTimeoutMs is untouched for other runs.
	// Undefined -> each agent keeps its own config (or the adapter default).
	callTimeoutMs?: number,
): ConvergeExecute {
	const baseAdapters: AdapterMap = {};
	for (const p of Object.values(manifest.participants)) {
		if (!(p.agent in baseAdapters)) {
			const agent = registry.agents[p.agent];
			if (!agent) continue; // validated by the caller via findUnknownAgents
			const effectiveAgent = callTimeoutMs === undefined ? agent : { ...agent, callTimeoutMs };
			baseAdapters[p.agent] = buildAdapter(effectiveAgent);
		}
	}
	return makeAuditedExecute(
		manifest,
		baseAdapters,
		registry,
		scope,
		cwd,
		new FileSessionStore(defaultSessionDir()),
		new AuditStore(),
	);
}

export type PrepareConvergeResult =
	| {
			ok: true;
			execute: ConvergeExecute;
			loopSteps: LoopSteps;
			// The resolved per-participant provenance snapshot (which agent/adapter/session/
			// permissions/config each participant ran with), captured here at the single converge
			// chokepoint so every caller can persist or surface it WITHOUT re-deriving it from the
			// mutable registry. Same redacted shape the audit run.started uses (envKeys, not env
			// values); reuses resolveParticipantSnapshots so the two can never drift.
			participants: Record<string, AuditParticipantSnapshot>;
			warnings: string[];
	  }
	| { ok: false; error: string };

// The run-level `call_timeout_ms` override budgets the loop's implement/review adapter
// calls; a one-shot run has no such loop. Reject it rather than silently ignore it --
// honoring it would be a lie, and silently dropping it would mislead the caller into
// thinking it took effect. Mirrors resolveRunRequiredChecks' one-shot guard (the other
// loop-only run knob). Returns an error string for a one-shot run given the override, or
// null when there is nothing to reject (loop run, or no override).
export function rejectCallTimeoutForOneShot(
	callTimeoutMs: number | undefined,
	policyKind: "loop" | "one-shot",
): string | null {
	if (callTimeoutMs !== undefined && policyKind !== "loop") {
		return "call_timeout_ms applies only to a loop run; this manifest declares a one-shot policy";
	}
	return null;
}

// Load + validate a converge manifest and build its audited execute. Shared by
// the MCP converge surface and the background worker so both refuse the same
// manifests (non-converge shape, unknown agent, unenforceable permission) and
// build the execute identically. Returns the ready execute plus any
// unenforced-permission warnings, or a single error string.
export function prepareConvergeExecute(
	raw: unknown,
	registry: NormalizedRegistry,
	scope: string,
	cwd: string,
	allowUnenforced: boolean,
	roles: Record<string, NormalizedRole> = {},
	// Optional per-run call-timeout override (ms), forwarded to buildExecute so the
	// chokepoint that builds every converge path's adapters also applies the run/task
	// budget. Undefined -> agents keep their configured callTimeoutMs.
	callTimeoutMs?: number,
): PrepareConvergeResult {
	// Parse + RESOLVE here: prepareConvergeExecute is the single chokepoint every
	// converge path (CLI, worker, MCP launchers) flows through, so resolving role
	// references in one place covers them all. An unknown-role / no-agent resolution
	// failure surfaces as the prep error, same channel as a parse error. `roles`
	// defaults to {} so a caller that has not yet threaded the config still works on
	// inline manifests (resolution is a no-op for fully inline participants).
	let manifest: ResolvedManifest;
	try {
		manifest = resolveManifest(parseManifest(raw), { roles });
	} catch (e) {
		return { ok: false, error: (e as Error).message };
	}
	// A converge run drives the manifest's loop policy. Reject a non-loop manifest
	// rather than running it under loop semantics via the implement/review fallback:
	// every background/batch re-read of a loop job flows through here, so this is the
	// single guard that keeps a one-shot manifest from being driven as a loop.
	if (manifest.policy.kind !== "loop") {
		return {
			ok: false,
			error: `manifest "${manifest.id}" declares policy "${manifest.policy.kind}", not loop; a converge run requires a loop manifest`,
		};
	}
	const shapeError = validateConvergeManifest(manifest);
	if (shapeError) return { ok: false, error: shapeError };
	const unknown = findUnknownAgents(manifest, registry);
	if (unknown.length > 0) {
		return {
			ok: false,
			error: `unknown agent(s): ${unknown
				.map((u) => `${u.agentId} (participant "${u.participantId}")`)
				.join(", ")}`,
		};
	}
	const gaps = findEnforcementGaps(manifest, registry);
	if (gaps.length > 0 && !allowUnenforced) {
		return {
			ok: false,
			error: `cannot enforce required permissions:\n${formatEnforcementGaps(
				gaps,
			)}\nPass allow_unenforced_permissions=true to run anyway.`,
		};
	}
	const warnings = gaps.map(
		(g) => `unenforced permission: participant "${g.participantId}" requires ${g.permission}`,
	);
	return {
		ok: true,
		execute: buildExecute(manifest, registry, scope, cwd, callTimeoutMs),
		loopSteps: resolveLoopPolicy(manifest),
		// Resolved once here from the SAME manifest + registry the execute was built from, so a
		// foreground session can carry it and a background job can persist it durably. The per-run
		// call-timeout override is surfaced separately (callTimeoutMs) and never mutates this snapshot,
		// mirroring how buildExecute keeps the agent record's configured callTimeoutMs untouched.
		participants: resolveParticipantSnapshots(manifest, registry),
		warnings,
	};
}

// Wrap an AdapterMap so each intra-call adapter event also notifies `observe`
// with the SAFE skeleton only (step/participant/agent ids + the event type,
// never event.raw). Composes req.onEvent: any existing handler (the audit
// wrapper's recorder, when this sits beneath it) still receives the full
// event, so observing adds a tap without changing what audit records. The
// observer is guarded: a throwing observer never breaks the adapter call.
export function wrapAdaptersWithEventObserver(
	adapters: AdapterMap,
	observe: (event: AdapterEventSkeleton) => void,
): AdapterMap {
	const out: AdapterMap = {};
	for (const [agentId, adapter] of Object.entries(adapters)) {
		out[agentId] = {
			call(req) {
				const existing = req.onEvent;
				const onEvent = (event: AdapterEvent) => {
					try {
						observe({
							stepId: req.stepId,
							participantId: req.participantId,
							agentId: req.agentId,
							type: event.type,
						});
					} catch {
						// Observation is best-effort; the event still reaches `existing`.
					}
					existing?.(event);
				};
				return adapter.call({ ...req, onEvent });
			},
		};
	}
	return out;
}

// Wrap a base adapter map into a converge execute that records each manifest run
// to the audit store (run/step/adapter-call events + prompt/output blobs +
// usage). Exported so the audit wiring is testable with fake adapters and an
// injectable store. Audit is best-effort and never breaks the run; if any audit
// write failed (recorder.lastError set), auditRunId is WITHHELD so the loop
// record never links to a missing/partial transcript. The session wrapper sits
// OUTSIDE the audit wrapper so the recorder sees the session layer's injected
// prior session and the adapter's returned new session.
export function makeAuditedExecute(
	manifest: ResolvedManifest,
	baseAdapters: AdapterMap,
	registry: NormalizedRegistry,
	scope: string,
	cwd: string,
	sessionStore: SessionStore,
	auditStore: AuditStore,
): ConvergeExecute {
	return async (inputs, ctx) => {
		const runId = crypto.randomUUID();
		const recorder = new AuditRecorder(auditStore, runId, {
			manifestId: manifest.id,
			cwd,
			surface: "converge",
			scope,
			...(ctx?.loopId !== undefined && { loopId: ctx.loopId }),
			...(ctx?.iteration !== undefined && { iteration: ctx.iteration }),
			...(ctx?.recipe !== undefined && { recipe: ctx.recipe }),
			participants: resolveParticipantSnapshots(manifest, registry),
		});
		recorder.runStarted();
		// The observer wrapper sits BENEATH the audit wrapper, so the full event
		// (with raw) still flows to the recorder via the composed onEvent while
		// the observer sees only the skeleton.
		const observed = ctx?.onAdapterEvent
			? wrapAdaptersWithEventObserver(baseAdapters, ctx.onAdapterEvent)
			: baseAdapters;
		const adapters = wrapAdaptersWithSessions(
			wrapAdaptersWithAudit(observed, recorder),
			manifest,
			registry,
			scope,
			sessionStore,
		);
		const startedAt = Date.now();
		try {
			const result = await executeManifest(manifest, {
				inputs,
				adapters,
				invocationCwd: cwd,
				onTrace: (e) => {
					recorder.fromTrace(e);
					ctx?.onTrace?.(e);
				},
				...(ctx?.promptAugment && { promptAugment: ctx.promptAugment }),
				...(ctx?.signal && { signal: ctx.signal }),
			});
			recorder.runCompleted(result.ok ? "ok" : "failed", Date.now() - startedAt);
			recorder.prune(); // opportunistic retention; never prunes this run
			// Link only when the whole audit run was written cleanly.
			return recorder.lastError === undefined
				? {
						...result,
						auditRunId: runId,
						recordLoopIteration: (event) => recorder.loopIterationRecorded(event),
					}
				: result;
		} catch (e) {
			recorder.runCompleted("failed", Date.now() - startedAt);
			recorder.prune();
			throw e;
		}
	};
}

// --manifest is generic, but the driver assumes a converge-shaped manifest: it
// reads the implementer and reviewer step outputs. Those step ids come from the
// manifest's loop policy when declared, else the implement/review defaults
// (resolveLoopPolicy). Validate that contract up front so a non-converge manifest
// fails clearly instead of silently writing a garbage loop log. Returns an error
// string, or null when the manifest satisfies the contract.
export function validateConvergeManifest(manifest: ResolvedManifest): string | null {
	// Validate the steps this manifest will actually key on: its loop policy's
	// steps when declared (core already guarantees those are call steps), else the
	// default implement/review (the contract for a converge manifest with no
	// policy). Core's parsePolicy validates loop-policy steps, so this primarily
	// enforces the fallback contract for a no-policy converge-shaped manifest.
	const { implementStep, reviewStep } = resolveLoopPolicy(manifest);
	for (const id of [implementStep, reviewStep]) {
		const step = manifest.steps[id];
		if (!step) {
			return `manifest "${manifest.id}" is not converge-shaped: missing call step "${id}" (a converge manifest needs implement/review call steps, or a loop policy naming them)`;
		}
		if (step.kind !== "call") {
			return `manifest "${manifest.id}" is not converge-shaped: step "${id}" must be a call step, not ${step.kind}`;
		}
	}
	return null;
}

interface ParsedConverge {
	task: string;
	scope: string;
	cwd: string;
	// The --manifest path, or undefined to use the embedded default converge
	// manifest (DEFAULT_CONVERGE_MANIFEST). The default is NOT a file path: the
	// published binary ships no examples/, so the default lives in the bundle.
	manifestPath?: string;
	maxIterations: number;
	loopId?: string;
	allowUnenforcedPermissions: boolean;
}

const CONVERGE_HELP = `chit converge --task <text> --scope <id> [options]

  --task <text>            Required. The slice to converge on.
  --scope <id>             Required. Session scope; both agents keep their thread.
  --cwd <dir>              Repo to run in. Default: current directory.
  --manifest <path>        Convergence manifest. Default: the built-in converge manifest.
  --max-iterations <n>     Iteration budget. Default: 3.
  --loop-id <id>           Reuse/seed a loop id. Default: generated.
  --allow-unenforced-permissions
                           Run even when the manifest declares permissions its
                           adapter cannot enforce (emits a warning each run).
                           Default off: such a manifest is refused before running.

Runs the implement/check loop to convergence and records it under chit's
state dir (keyed by repo, not in the worktree). Stops at the reviewer's verdict and
its verification: proceed + verification passed -> converged; proceed whose checks
failed, were blocked, or did not run -> needs-decision (a human decides); block ->
blocked; else revise and retry up to the budget. An unparseable verdict is treated
as block (never an implicit proceed).
`;

class UsageError extends Error {}

function parseConvergeArgs(argv: string[]): ParsedConverge {
	let task: string | undefined;
	let scope: string | undefined;
	let cwd: string | undefined;
	let manifestPath: string | undefined;
	let maxIterations = 3;
	let loopId: string | undefined;
	let allowUnenforcedPermissions = false;

	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		const need = (key: string): string => {
			const v = argv[++i];
			if (v === undefined) throw new UsageError(`${key} requires a value`);
			return v;
		};
		if (a === "--task") task = need("--task");
		else if (a === "--scope") scope = need("--scope");
		else if (a === "--cwd") cwd = need("--cwd");
		else if (a === "--manifest") manifestPath = need("--manifest");
		else if (a === "--loop-id") loopId = need("--loop-id");
		else if (a === "--allow-unenforced-permissions") allowUnenforcedPermissions = true;
		else if (a === "--max-iterations") {
			const raw = need("--max-iterations");
			const n = Number(raw);
			if (!Number.isInteger(n) || n < 1) {
				throw new UsageError(
					`--max-iterations must be a positive integer (got ${JSON.stringify(raw)})`,
				);
			}
			maxIterations = n;
		} else {
			throw new UsageError(`unknown flag ${JSON.stringify(a)}`);
		}
	}

	if (task === undefined) throw new UsageError("--task is required");
	if (scope === undefined) throw new UsageError("--scope is required");

	return {
		task,
		scope,
		cwd: resolve(cwd ?? process.cwd()),
		manifestPath,
		maxIterations,
		loopId,
		allowUnenforcedPermissions,
	};
}

export async function runConverge(argv: string[], io: ConvergeIO = defaultIO): Promise<number> {
	if (argv[0] === "-h" || argv[0] === "--help") {
		io.out(CONVERGE_HELP);
		return 0;
	}

	let parsed: ParsedConverge;
	try {
		parsed = parseConvergeArgs(argv);
	} catch (e) {
		if (e instanceof UsageError) {
			io.err(`chit converge: ${e.message}\n\n${CONVERGE_HELP}`);
			return 2;
		}
		throw e;
	}

	// Load the config (agents + roles) first: resolution needs the roles, and a
	// malformed config is reported distinctly from a malformed manifest. --cwd is
	// the run's repo, so repo-config discovery starts there, not where chit runs.
	let config: NormalizedConfig;
	try {
		config = loadConfig(undefined, { cwd: parsed.cwd });
	} catch (e) {
		// e.g. an invalid ~/.config/chit/config.json (ConfigError). Surface it
		// cleanly rather than as a raw stack, matching the rest of this command.
		io.err(`chit converge: ${(e as Error).message}\n`);
		return 1;
	}
	const registry = config.registry;

	let manifest: ResolvedManifest;
	try {
		// No --manifest: use the embedded default, which works from the published
		// binary (no examples/ on disk). A given path is read from disk as before.
		const raw =
			parsed.manifestPath !== undefined
				? JSON.parse(readFileSync(parsed.manifestPath, "utf-8"))
				: DEFAULT_CONVERGE_MANIFEST;
		// Resolve role references against the config so governance + buildExecute below
		// see concrete participants (an unknown-role / no-agent failure lands here).
		manifest = resolveManifest(parseManifest(raw), { roles: config.roles });
	} catch (e) {
		io.err(
			`chit converge: failed to load manifest ${parsed.manifestPath ?? "(built-in default)"}: ${(e as Error).message}\n`,
		);
		return 2;
	}

	const shapeError = validateConvergeManifest(manifest);
	if (shapeError) {
		io.err(`chit converge: ${shapeError}\n`);
		return 1;
	}

	const unknown = findUnknownAgents(manifest, registry);
	if (unknown.length > 0) {
		for (const u of unknown) {
			io.err(
				`chit converge: unknown agent "${u.agentId}" in registry (participant "${u.participantId}")\n`,
			);
		}
		return 2;
	}
	// Governance: refuse by default when the manifest declares permissions its
	// adapter cannot enforce, mirroring `chit run`. Only proceed (with a warning)
	// when --allow-unenforced-permissions is explicitly passed. The default
	// converge manifest has no gap (implementer is write; codex-exec enforces the
	// reviewer's read_only), so this path is normally silent — it guards custom
	// --manifest use.
	const gaps = findEnforcementGaps(manifest, registry);
	if (gaps.length > 0 && !parsed.allowUnenforcedPermissions) {
		io.err(`chit converge: cannot enforce required permissions for "${manifest.id}":\n`);
		io.err(`${formatEnforcementGaps(gaps)}\n`);
		io.err("\nPass --allow-unenforced-permissions to run anyway (emits a warning each run).\n");
		return 1;
	}
	for (const g of gaps) {
		io.err(
			`chit converge: WARNING -- unenforced permission: participant "${g.participantId}" requires ${g.permission}\n`,
		);
	}

	let result: ConvergeResult;
	try {
		const loopSteps = resolveLoopPolicy(manifest);
		result = await convergeLoop({
			cwd: parsed.cwd,
			scope: parsed.scope,
			task: parsed.task,
			maxIterations: parsed.maxIterations,
			loopId: parsed.loopId,
			execute: buildExecute(manifest, registry, parsed.scope, parsed.cwd),
			implementStep: loopSteps.implementStep,
			reviewStep: loopSteps.reviewStep,
			...(loopSteps.requiredChecks && { requiredChecks: loopSteps.requiredChecks }),
		});
	} catch (e) {
		// Any failure from the loop exits cleanly with a `chit converge:` message
		// and code 1, never a raw stack — mirroring loop-log's discipline. This
		// covers an AdapterError, a LoopStoreError, a LoopLogError from @chit-run/core
		// record validation, a rethrown manifest-run error, or an unexpected fs
		// error (e.g. ENOTDIR when --cwd is a regular file).
		io.err(`chit converge: ${(e as Error).message}\n`);
		return 1;
	}

	if (result.failure !== undefined) {
		// The loop ran but a manifest run failed; it is already recorded as a
		// blocked stop. Report it as a CLI error so automation sees the failure.
		io.err(`chit converge: ${result.failure}\n`);
		return 1;
	}

	io.out(`chit converge: ${result.loopId}\n`);
	io.out(`  iterations: ${result.iterations}\n`);
	io.out(`  status:     ${result.status}\n`);
	return 0;
}
