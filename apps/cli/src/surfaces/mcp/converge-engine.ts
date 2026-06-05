// Converge engine for the MCP surface. The CLI `chit converge` runs the whole
// implement->review loop in one process via convergeLoop; this drives it ONE
// iteration per call so each iteration is a separate, cancellable MCP tool call
// (chit_converge_next), with the loop's control state inspectable between calls
// (chit_converge_status / chit_converge_trace).
//
// Both drivers sit on the SAME single-iteration primitive (runConvergeIteration)
// and write the SAME durable loop log (under the state dir, keyed by repo; see
// apps/cli loops/location.ts). This engine
// owns NO new persistence: the loop log is the source of truth for iterations
// and the stop record; this in-memory session only holds what the log cannot
// (the audited execute boundary, the prior_review to thread forward, and the
// live AbortController for an in-flight iteration).

import type {
	AdapterUsage,
	LoopCheck,
	LoopRecord,
	LoopStopStatus,
	LoopVerdict,
	RequiredCheck,
	Verification,
	VerificationSource,
} from "@chit-run/core";
import {
	type ConvergeExecute,
	ConvergeExecuteError,
	type ConvergeIterationResult,
	type LoopSteps,
	runConvergeIteration,
	stopReasonFor,
} from "../../cli/converge.ts";
import { readLoop, startLoop, stopLoop } from "../../loops/log-store.ts";
import type { TraceEvent } from "../../runtime/types.ts";

export class ConvergeEngineError extends Error {}

// In-memory state for one MCP-driven converge loop. Never the source of truth
// for iterations or the stop record (those live in the loop log); this holds the
// run-time pieces the log does not carry.
export interface ConvergeSession {
	loopId: string;
	scope: string;
	cwd: string;
	// Managed-worktree fields (#85): set when this run is isolated in a chit-managed
	// worktree (cwd IS the worktree path). Recorded for surfacing; absent for in_place runs.
	worktreePath?: string;
	branch?: string;
	baseSha?: string;
	repo?: string; // the MAIN repo the worktree was cut from (for cleanup after the worktree is gone)
	callerCheckout?: string; // the LAUNCHING checkout (chit_apply's default target)
	task: string;
	maxIterations: number;
	execute: ConvergeExecute;
	// The implementer/reviewer step ids resolved from the manifest's loop policy,
	// so each iteration reads the right outputs even for a non-default-named loop.
	implementStep: string;
	reviewStep: string;
	// chit-executed verification commands resolved from the loop policy, when declared.
	requiredChecks?: RequiredCheck[];
	// The per-call timeout override (ms) this run was launched with, if any. Recorded
	// only for status surfacing -- the override is already baked into `execute` (the
	// adapters were built with it); this is the value to show the operator, not a knob
	// the loop re-reads.
	callTimeoutMs?: number;
	// Count of COMPLETED (appended) iterations. The next iteration is this + 1.
	iteration: number;
	// The last review text, threaded into the next iteration as prior_review.
	priorReview: string;
	// Terminal stop status once the loop has stopped; undefined while open.
	terminalStatus?: LoopStopStatus;
	// Set when the loop stopped blocked because a manifest RUN failed (not a
	// reviewer `block` verdict). Surfaced so the tool reports the failure reason.
	failure?: string;
	lastVerdict?: LoopVerdict;
	lastDecision?: LoopVerdict;
	// Latest iteration's verification rollup + source, cached for status views (the
	// loop log is the durable source of truth).
	lastVerification?: Verification;
	lastVerificationSource?: VerificationSource;
	// Audit run ids for completed audited iterations, in order. The loop log also
	// records these as auditRef; mirrored here so status/trace need not re-read
	// the log just for the refs.
	auditRefs: string[];
	// The in-flight iteration's controller, set for the duration of one
	// runNextIteration and cleared on settle. Its presence IS the per-loop running
	// lock: one iteration at a time, because the loop log is single-writer.
	active?: AbortController;
	startedAtMs: number;
	// Wall-clock ms when the loop went terminal, set in lockstep with terminalStatus
	// (set if and only if terminalStatus is set). The durable stop record's
	// endedAt/totalElapsedMs (stopLoop computes them) stay the source of truth; this
	// is the in-memory mirror so status views can report a terminal run's elapsed
	// without re-reading the log.
	endedAtMs?: number;
}

export interface StartConvergeOptions {
	cwd: string;
	scope: string;
	task: string;
	maxIterations: number;
	loopId?: string;
	force?: boolean;
	// A chit-managed worktree this run executes in (cwd is already the worktree path).
	worktree?: {
		worktreePath: string;
		branch: string;
		baseSha: string;
		repo: string;
		callerCheckout: string;
	};
	execute: ConvergeExecute;
	// The manifest's resolved loop steps (from prepareConvergeExecute). Defaults to
	// the converge constants when omitted, so callers that don't yet resolve a
	// policy keep their prior behavior.
	loopSteps?: LoopSteps;
	// The per-call timeout override (ms) the run was launched with, recorded on the
	// session for status surfacing. Undefined when no override was given.
	callTimeoutMs?: number;
	// Wall-clock now, injectable for deterministic tests. Defaults to Date.now.
	now?: () => number;
}

// Open a fresh loop: write the loop-log header and return its in-memory session.
// startLoop refuses to overwrite an existing log unless `force`, so a clashing
// loop id surfaces as a LoopStoreError here.
export function startConvergeSession(opts: StartConvergeOptions): ConvergeSession {
	const { loopId } = startLoop(opts.cwd, {
		scope: opts.scope,
		task: opts.task,
		maxIterations: opts.maxIterations,
		loopId: opts.loopId,
		force: opts.force,
		// Persist the managed-worktree metadata in the loop HEADER so a closed-session run is
		// recoverable from its durable log (#100). repo here is the worktree's MAIN repo (recorded
		// as mainRepo, distinct from the header's own `repo` = the worktree toplevel).
		...(opts.worktree && {
			workspace: {
				worktreePath: opts.worktree.worktreePath,
				branch: opts.worktree.branch,
				baseSha: opts.worktree.baseSha,
				mainRepo: opts.worktree.repo,
				callerCheckout: opts.worktree.callerCheckout,
			},
		}),
	});
	return {
		loopId,
		scope: opts.scope,
		cwd: opts.cwd,
		...(opts.worktree && {
			worktreePath: opts.worktree.worktreePath,
			branch: opts.worktree.branch,
			baseSha: opts.worktree.baseSha,
			repo: opts.worktree.repo,
			callerCheckout: opts.worktree.callerCheckout,
		}),
		task: opts.task,
		maxIterations: opts.maxIterations,
		execute: opts.execute,
		implementStep: opts.loopSteps?.implementStep ?? "implement",
		reviewStep: opts.loopSteps?.reviewStep ?? "review",
		...(opts.loopSteps?.requiredChecks && { requiredChecks: opts.loopSteps.requiredChecks }),
		...(opts.callTimeoutMs !== undefined && { callTimeoutMs: opts.callTimeoutMs }),
		iteration: 0,
		priorReview: "",
		auditRefs: [],
		startedAtMs: (opts.now ?? Date.now)(),
	};
}

// The outcome of one chit_converge_next, as a discriminated union the tool maps
// to its response. "iteration" = a round completed (a set stopStatus means the
// loop also stopped this round). "cancelled" = the in-flight iteration was
// aborted and the loop closed `cancelled` with NO iteration record. "failed" =
// the manifest run failed gracefully and the loop closed `blocked`.
export type NextResult =
	| {
			kind: "iteration";
			iteration: number;
			verdict: LoopVerdict;
			decision: LoopVerdict;
			findingCount: number;
			checksRun: string;
			// The per-check results from the iteration ([] when none ran), surfaced so
			// the next response can report per-check names/statuses; the loop log stays
			// the durable source of truth.
			checks: LoopCheck[];
			changedFiles: string[];
			workspaceWarnings: string[];
			usage?: AdapterUsage;
			auditRunId?: string;
			stopStatus?: LoopStopStatus;
	  }
	| { kind: "cancelled"; iteration: number }
	| { kind: "failed"; iteration: number; failure: string };

// Close the loop with a stop record and mark the session terminal.
function stopTerminal(session: ConvergeSession, status: LoopStopStatus, reason: string): void {
	stopLoop(session.cwd, session.loopId, { status, reason });
	session.terminalStatus = status;
	// Mirror the terminal time in memory in lockstep with terminalStatus. stopLoop
	// runs first, so if it throws (stopBlocked's swallow path) neither is set and the
	// two stay consistent with the still-open log.
	session.endedAtMs = Date.now();
}

// Close blocked on an error path. Best-effort: a failure to write the stop must
// not mask the original run error we are about to rethrow, so swallow a stop
// throw. On that failure we deliberately do NOT mark the session terminal: the
// durable log is still open, and the in-memory status must match it (the loop
// log is the single source of truth). The caller still rethrows the original run
// error; the loop is simply left open and consistent, as the CLI driver leaves
// it when its own stop write fails.
function stopBlocked(session: ConvergeSession, reason: string): void {
	try {
		stopTerminal(session, "blocked", reason);
	} catch {
		// Leave terminalStatus undefined so status reads "open"/"running", matching
		// the still-open log rather than claiming a stop that was never written.
	}
}

// Run exactly ONE implement->review iteration for this session, blocking until
// it settles. `signal`, when provided, is folded into the iteration's abort, so
// a client cancel (Esc) or chit_converge_cancel kills the in-flight adapter call.
// A cancelled iteration writes a clean `cancelled` stop and NO iteration record
// (never a fake-successful round). Throws ConvergeEngineError if the loop is
// already terminal or an iteration is already running (the loop log is
// single-writer, so concurrent appends are rejected up front).
export async function runNextIteration(
	session: ConvergeSession,
	opts?: {
		signal?: AbortSignal;
		// Live per-step trace, forwarded to the iteration so a foreground driver can
		// surface the current phase (implementing/reviewing).
		onTrace?: (e: TraceEvent) => void;
		// Invoked before chit runs the required checks (only when there are any), so a
		// foreground driver can surface a "running required checks" phase.
		onChecksStart?: () => void;
	},
): Promise<NextResult> {
	const signal = opts?.signal;
	if (session.terminalStatus !== undefined) {
		throw new ConvergeEngineError(
			`this run is already ${session.terminalStatus}; start a new run to continue`,
		);
	}
	if (session.active !== undefined) {
		throw new ConvergeEngineError("an iteration is already running for this run");
	}

	// chit owns the controller for this iteration so chit_converge_cancel can stop
	// it. Fold in the client's own signal: if Esc propagates, it aborts the same
	// controller. Honor a signal that is already aborted at call time.
	const controller = new AbortController();
	if (signal !== undefined) {
		if (signal.aborted) controller.abort();
		else signal.addEventListener("abort", () => controller.abort(), { once: true });
	}
	session.active = controller;
	const iteration = session.iteration + 1;

	try {
		let iter: ConvergeIterationResult;
		try {
			iter = await runConvergeIteration({
				cwd: session.cwd,
				loopId: session.loopId,
				iteration,
				task: session.task,
				prior_review: session.priorReview,
				execute: session.execute,
				implementStep: session.implementStep,
				reviewStep: session.reviewStep,
				...(session.requiredChecks && { requiredChecks: session.requiredChecks }),
				signal: controller.signal,
				...(opts?.onTrace && { onTrace: opts.onTrace }),
				...(opts?.onChecksStart && { onChecksStart: opts.onChecksStart }),
			});
		} catch (e) {
			// Cancellation never lands here: an aborted adapter call settles as a
			// graceful ok:false (executeManifest turns the rejection into a failure
			// envelope), handled below. A throw is a genuine run/setup failure
			// (ConvergeExecuteError) or a post-run append failure -- mirror
			// convergeLoop's split exactly.
			if (e instanceof ConvergeExecuteError) {
				stopBlocked(session, `manifest run threw: ${e.message}`);
				throw e.executeError;
			}
			// A post-run throw (e.g. appending the iteration record failed). Leave the
			// loop as-is (no stop record), exactly as convergeLoop does, and propagate.
			throw e;
		}

		if (!iter.ok) {
			if (controller.signal.aborted) {
				// Cancelled mid-run: runConvergeIteration appended NO record (it appends
				// only on a successful run). Close the loop cleanly as cancelled.
				stopTerminal(
					session,
					"cancelled",
					stopReasonFor("cancelled", { detail: "via MCP (client abort or chit_cancel)" }),
				);
				return { kind: "cancelled", iteration };
			}
			// A real manifest failure (not a cancellation): close blocked, exactly as
			// convergeLoop does on a graceful ok:false.
			session.failure = iter.failure;
			stopTerminal(session, "blocked", iter.failure);
			return { kind: "failed", iteration, failure: iter.failure };
		}

		// The iteration record was appended. Advance the session.
		session.iteration = iteration;
		session.lastVerdict = iter.verdict;
		session.lastDecision = iter.decision;
		session.lastVerification = iter.verification;
		session.lastVerificationSource = iter.verificationSource;
		if (iter.auditRunId !== undefined) session.auditRefs.push(iter.auditRunId);

		if (iter.stopStatus !== undefined) {
			// converged / blocked / needs-decision -- the verdict-and-verification gate
			// already chose the status; stopReasonFor gives the matching wording.
			stopTerminal(session, iter.stopStatus, stopReasonFor(iter.stopStatus));
		} else {
			// revise: thread the review forward. If that consumed the budget, the loop
			// stops as max-iterations (mirrors convergeLoop's post-loop default).
			session.priorReview = iter.reviewText;
			if (session.iteration >= session.maxIterations) {
				stopTerminal(
					session,
					"max-iterations",
					stopReasonFor("max-iterations", { maxIterations: session.maxIterations }),
				);
			}
		}

		return {
			kind: "iteration",
			iteration,
			verdict: iter.verdict,
			decision: iter.decision,
			findingCount: iter.findingCount,
			checksRun: iter.checksRun,
			checks: iter.checks,
			changedFiles: iter.changedFiles,
			workspaceWarnings: iter.workspaceWarnings,
			...(iter.usage !== undefined && { usage: iter.usage }),
			...(iter.auditRunId !== undefined && { auditRunId: iter.auditRunId }),
			...(session.terminalStatus !== undefined && { stopStatus: session.terminalStatus }),
		};
	} finally {
		session.active = undefined;
	}
}

export type CancelResult =
	| { state: "cancelling" } // aborted an in-flight iteration; it settles cancelled
	| { state: "closed" } // no iteration running; loop closed cancelled now
	| { state: "already"; status: LoopStopStatus }; // loop was already terminal

// Cancel a converge loop. If an iteration is in flight, abort it: the running
// runNextIteration sees the aborted signal, gets a graceful ok:false, and writes
// the cancelled stop (best-effort, like chit_run_cancel -- if the call had already
// produced its verdict, the abort is a no-op and the loop settles on that
// verdict). If the loop is open but idle (e.g. after a revise round returned),
// close it cancelled now. A terminal loop is reported back unchanged.
export function cancelConverge(session: ConvergeSession): CancelResult {
	if (session.terminalStatus !== undefined) {
		return { state: "already", status: session.terminalStatus };
	}
	if (session.active !== undefined) {
		session.active.abort();
		return { state: "cancelling" };
	}
	stopTerminal(
		session,
		"cancelled",
		stopReasonFor("cancelled", { detail: "via chit_cancel (no iteration running)" }),
	);
	return { state: "closed" };
}

export type ConvergeRunStatus = "open" | "running" | LoopStopStatus;

function runStatus(session: ConvergeSession): ConvergeRunStatus {
	return session.terminalStatus ?? (session.active !== undefined ? "running" : "open");
}

export interface ConvergeStatus {
	loopId: string;
	scope: string;
	cwd: string;
	task: string;
	maxIterations: number;
	iteration: number; // completed iterations
	status: ConvergeRunStatus;
	active: boolean;
	cancellable: boolean;
	lastVerdict?: LoopVerdict;
	lastDecision?: LoopVerdict;
	lastVerification?: Verification;
	lastVerificationSource?: VerificationSource;
	failure?: string;
	auditRefs: string[];
	nextAction: string;
}

// Compact control-plane view: "what should I do next?". No loop-log read -- this
// answers from the in-memory session alone, so it is cheap to poll.
export function describeConverge(session: ConvergeSession): ConvergeStatus {
	const active = session.active !== undefined;
	const terminal = session.terminalStatus !== undefined;
	const nextAction = terminal
		? `loop is ${session.terminalStatus}; start a new loop to continue`
		: active
			? "an iteration is in flight; wait for it, or call chit_converge_cancel to stop it"
			: `call chit_converge_next to run iteration ${session.iteration + 1} of ${session.maxIterations}`;
	return {
		loopId: session.loopId,
		scope: session.scope,
		cwd: session.cwd,
		task: session.task,
		maxIterations: session.maxIterations,
		iteration: session.iteration,
		status: runStatus(session),
		active,
		cancellable: !terminal,
		...(session.lastVerdict !== undefined && { lastVerdict: session.lastVerdict }),
		...(session.lastDecision !== undefined && { lastDecision: session.lastDecision }),
		...(session.lastVerification !== undefined && { lastVerification: session.lastVerification }),
		...(session.lastVerificationSource !== undefined && {
			lastVerificationSource: session.lastVerificationSource,
		}),
		...(session.failure !== undefined && { failure: session.failure }),
		auditRefs: session.auditRefs,
		nextAction,
	};
}

export interface ConvergeTrace {
	loopId: string;
	status: ConvergeRunStatus;
	active: boolean;
	auditRefs: string[];
	records: LoopRecord[]; // the durable loop log: header + iterations + stop
}

// Diagnostic view: "what happened?". Reads straight from the durable loop log so
// it is NOT a second source of truth; adds only the in-memory pieces the log does
// not carry (live active flag + the audit refs).
export function traceConverge(session: ConvergeSession): ConvergeTrace {
	const records = readLoop(session.cwd, session.loopId);
	return {
		loopId: session.loopId,
		status: runStatus(session),
		active: session.active !== undefined,
		auditRefs: session.auditRefs,
		records,
	};
}
