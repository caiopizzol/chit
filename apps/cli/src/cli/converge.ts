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
import { dirname, join, resolve } from "node:path";
import {
	type AdapterUsage,
	findEnforcementGaps,
	findUnknownAgents,
	formatEnforcementGaps,
	type LoopStopStatus,
	type LoopVerdict,
	type NormalizedManifest,
	type NormalizedRegistry,
	parseManifest,
	resolveParticipantSnapshots,
} from "@chit/core";
import { buildAdapter } from "../adapters/factory.ts";
import { loadRegistry } from "../agents/parse.ts";
import { AuditRecorder } from "../audit/recorder.ts";
import { AuditStore } from "../audit/store.ts";
import { wrapAdaptersWithAudit } from "../audit/wrap.ts";
import { appendIteration, startLoop, stopLoop } from "../loops/log-store.ts";
import { executeManifest } from "../runtime/execute.ts";
import type { AdapterMap, RunResult, TraceEvent } from "../runtime/types.ts";
import { wrapAdaptersWithSessions } from "../sessions/coordinator.ts";
import { defaultSessionDir, FileSessionStore } from "../sessions/store.ts";
import type { SessionStore } from "../sessions/types.ts";

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

// The converge contract: the driver depends on call steps named exactly these.
// It reads outputs.review and records the review step's own trace duration as
// the check duration (not the whole-run wall time, which includes implement).
const IMPLEMENT_STEP_ID = "implement";
const REVIEW_STEP_ID = "review";

// implementSummary in the log is a digest, not the full transcript. Cap it so
// a long Claude summary does not bloat the .jsonl record.
const IMPLEMENT_SUMMARY_CAP = 2000;

// The loop record requires a non-empty checksRun string. Used when the JSON
// block is absent/invalid, or present but without a usable checksRun.
const CHECKS_RUN_FALLBACK = "unreported";

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
	ctx?: { loopId: string; iteration: number; signal?: AbortSignal },
) => Promise<RunResult & { auditRunId?: string }>;

export interface ConvergeLoopOptions {
	cwd: string;
	scope: string;
	task: string;
	maxIterations: number;
	loopId?: string;
	force?: boolean;
	execute: ConvergeExecute;
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
		return {
			verdict: rawVerdict as LoopVerdict,
			findingCount: typeof fc === "number" && Number.isInteger(fc) && fc >= 0 ? fc : 0,
			checksRun: typeof cr === "string" && cr.trim() !== "" ? cr.trim() : CHECKS_RUN_FALLBACK,
		};
	}
	return { verdict: "block", findingCount: 0, checksRun: CHECKS_RUN_FALLBACK };
}

// The review step's own duration from the run trace — the check duration. 0 if
// the trace has no completed review step (e.g. an injected fake without one).
function reviewDurationMs(trace: TraceEvent[]): number {
	for (const e of trace) {
		if (e.type === "step.completed" && e.stepId === REVIEW_STEP_ID) return e.durationMs;
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

// Unstaged + staged + untracked files, deduped. Combining all three matters for
// the loop-log/audit data: a newly created file (a brand-new converge.ts, say)
// is untracked, so `git diff --name-only` alone would silently omit it.
function gitChangedFiles(cwd: string): string[] {
	const all = [
		...gitLines(cwd, ["diff", "--name-only"]),
		...gitLines(cwd, ["diff", "--cached", "--name-only"]),
		...gitLines(cwd, ["ls-files", "--others", "--exclude-standard"]),
	];
	return [...new Set(all)];
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
	// When present, threaded to execute so the iteration's manifest run can be
	// cancelled mid-flight. Absent for the CLI driver (uncancellable, as before).
	signal?: AbortSignal;
}

// The structured next-state a single iteration hands back so the caller can
// decide continue-vs-stop and what prior_review to feed the next round. A
// discriminated union on `ok`:
//   - ok: false  -> the manifest run failed gracefully; `failure` is the reason
//     string (no iteration record was appended). The caller stops the loop.
//   - ok: true   -> the iteration record was appended; the parsed verdict and
//     metrics are returned, plus `reviewText` (the next prior_review) and
//     `stopStatus` (converged for proceed, blocked for block, undefined for
//     revise -> continue). `decision` == verdict (the autonomous driver follows
//     the reviewer). `auditRunId` is present only when the run was audited.
export type ConvergeIterationResult =
	| { ok: false; failure: string }
	| {
			ok: true;
			verdict: LoopVerdict;
			findingCount: number;
			checksRun: string;
			decision: LoopVerdict;
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
	let result: RunResult & { auditRunId?: string };
	try {
		result = await ctx.execute(
			{ task: ctx.task, prior_review: ctx.prior_review },
			{
				loopId: ctx.loopId,
				iteration: ctx.iteration,
				...(ctx.signal && { signal: ctx.signal }),
			},
		);
	} catch (e) {
		// Tag only the run throw. Everything below stays untagged and propagates
		// raw, preserving the original "no stop record on append failure" behavior.
		throw new ConvergeExecuteError(e);
	}

	if (!result.ok) {
		// A step failed gracefully. Hand the reason back so the caller can close
		// the loop as blocked; a failed run appends no iteration record.
		return {
			ok: false,
			failure: `manifest run failed at step "${result.failedStep}": ${result.error}`,
		};
	}

	const reviewText = result.outputs.review ?? "";
	const review = parseReview(reviewText);
	const usage = sumTraceUsage(result.trace);
	appendIteration(ctx.cwd, ctx.loopId, {
		implementSummary: capSummary(result.outputs.implement ?? ""),
		changedFiles: gitChangedFiles(ctx.cwd),
		checksRun: review.checksRun,
		verdict: review.verdict,
		findingCount: review.findingCount,
		// Autonomous driver: it follows the reviewer, so decision == verdict.
		decision: review.verdict,
		// The check (review) step's own duration, not the whole-run wall time.
		checkDurationMs: reviewDurationMs(result.trace),
		// Total token/cost across the run's calls (implement + review).
		...(usage && { usage }),
		// Link to the audit transcript for this iteration's run, when audited.
		...(result.auditRunId && { detailsRef: `audit:${result.auditRunId}` }),
	});

	// proceed -> converged, block -> blocked; revise leaves it undefined so the
	// caller threads reviewText back in and runs another round.
	const stopStatus: LoopStopStatus | undefined =
		review.verdict === "proceed" ? "converged" : review.verdict === "block" ? "blocked" : undefined;

	return {
		ok: true,
		verdict: review.verdict,
		findingCount: review.findingCount,
		checksRun: review.checksRun,
		decision: review.verdict,
		...(result.auditRunId && { auditRunId: result.auditRunId }),
		reviewText,
		...(stopStatus && { stopStatus }),
	};
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

	const reason =
		status === "converged"
			? "reviewer returned proceed"
			: status === "blocked"
				? "reviewer returned block"
				: `reached max iterations (${opts.maxIterations}) without converging`;
	stopLoop(opts.cwd, loopId, { status, reason });

	return { loopId, iterations, status };
}

// The default adapter-backed execute. Mirrors the run-command path: build one
// adapter per agent, wrap them in the per_scope session coordinator (converge
// is a per_scope manifest), and run the whole manifest to completion.
export function buildExecute(
	manifest: NormalizedManifest,
	registry: NormalizedRegistry,
	scope: string,
	cwd: string,
): ConvergeExecute {
	const baseAdapters: AdapterMap = {};
	for (const p of Object.values(manifest.participants)) {
		if (!(p.agent in baseAdapters)) {
			const agent = registry.agents[p.agent];
			if (!agent) continue; // validated by the caller via findUnknownAgents
			baseAdapters[p.agent] = buildAdapter(agent);
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

// Wrap a base adapter map into a converge execute that records each manifest run
// to the audit store (run/step/adapter-call events + prompt/output blobs +
// usage). Exported so the audit wiring is testable with fake adapters and an
// injectable store. Audit is best-effort and never breaks the run; if any audit
// write failed (recorder.lastError set), auditRunId is WITHHELD so the loop
// record never links to a missing/partial transcript. The session wrapper sits
// OUTSIDE the audit wrapper so the recorder sees the session layer's injected
// prior session and the adapter's returned new session.
export function makeAuditedExecute(
	manifest: NormalizedManifest,
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
			participants: resolveParticipantSnapshots(manifest, registry),
		});
		recorder.runStarted();
		const adapters = wrapAdaptersWithSessions(
			wrapAdaptersWithAudit(baseAdapters, recorder),
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
				onTrace: (e) => recorder.fromTrace(e),
				...(ctx?.signal && { signal: ctx.signal }),
			});
			recorder.runCompleted(result.ok ? "ok" : "failed", Date.now() - startedAt);
			recorder.prune(); // opportunistic retention; never prunes this run
			// Link only when the whole audit run was written cleanly.
			return recorder.lastError === undefined ? { ...result, auditRunId: runId } : result;
		} catch (e) {
			recorder.runCompleted("failed", Date.now() - startedAt);
			recorder.prune();
			throw e;
		}
	};
}

// --manifest is generic, but the driver assumes a converge-shaped manifest: it
// depends on call steps named `implement` and `review` and reads outputs.review.
// Validate that contract up front so a non-converge manifest fails clearly
// instead of silently writing a garbage loop log. Returns an error string, or
// null when the manifest satisfies the contract.
export function validateConvergeManifest(manifest: NormalizedManifest): string | null {
	for (const id of [IMPLEMENT_STEP_ID, REVIEW_STEP_ID]) {
		const step = manifest.steps[id];
		if (!step) {
			return `manifest "${manifest.id}" is not converge-shaped: missing call step "${id}" (converge needs call steps named "implement" and "review")`;
		}
		if (step.kind !== "call") {
			return `manifest "${manifest.id}" is not converge-shaped: step "${id}" must be a call step, not ${step.kind}`;
		}
	}
	return null;
}

// examples/converge.json, resolved from this file's location. This
// file is apps/cli/src/cli/converge.ts; two dirname() hops reach apps/cli.
export function defaultManifestPath(): string {
	return join(dirname(dirname(dirname(dirname(import.meta.dir)))), "examples", "converge.json");
}

interface ParsedConverge {
	task: string;
	scope: string;
	cwd: string;
	manifestPath: string;
	maxIterations: number;
	loopId?: string;
	allowUnenforcedPermissions: boolean;
}

const CONVERGE_HELP = `chit converge --task <text> --scope <id> [options]

  --task <text>            Required. The slice to converge on.
  --scope <id>             Required. Session scope; both agents keep their thread.
  --cwd <dir>              Repo to run in. Default: current directory.
  --manifest <path>        Convergence manifest. Default: bundled examples/converge.json.
  --max-iterations <n>     Iteration budget. Default: 3.
  --loop-id <id>           Reuse/seed a loop id. Default: generated.
  --allow-unenforced-permissions
                           Run even when the manifest declares permissions its
                           adapter cannot enforce (emits a warning each run).
                           Default off: such a manifest is refused before running.

Runs the implement/check loop to convergence and records it under
.chit/loops/<loopId>.jsonl. Stops at the reviewer's verdict: proceed ->
converged, block -> blocked, else revise and retry up to the budget. An
unparseable verdict is treated as block (never an implicit proceed).
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
		manifestPath: manifestPath ?? defaultManifestPath(),
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

	let manifest: NormalizedManifest;
	try {
		manifest = parseManifest(JSON.parse(readFileSync(parsed.manifestPath, "utf-8")));
	} catch (e) {
		io.err(
			`chit converge: failed to load manifest ${parsed.manifestPath}: ${(e as Error).message}\n`,
		);
		return 2;
	}

	const shapeError = validateConvergeManifest(manifest);
	if (shapeError) {
		io.err(`chit converge: ${shapeError}\n`);
		return 1;
	}

	let registry: NormalizedRegistry;
	try {
		registry = loadRegistry();
	} catch (e) {
		// e.g. an invalid ~/.config/chit/agents.json (RegistryError). Surface it
		// cleanly rather than as a raw stack, matching the rest of this command.
		io.err(`chit converge: ${(e as Error).message}\n`);
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
		result = await convergeLoop({
			cwd: parsed.cwd,
			scope: parsed.scope,
			task: parsed.task,
			maxIterations: parsed.maxIterations,
			loopId: parsed.loopId,
			execute: buildExecute(manifest, registry, parsed.scope, parsed.cwd),
		});
	} catch (e) {
		// Any failure from the loop exits cleanly with a `chit converge:` message
		// and code 1, never a raw stack — mirroring loop-log's discipline. This
		// covers an AdapterError, a LoopStoreError, a LoopLogError from @chit/core
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
