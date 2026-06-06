// chit's MCP server. ONE run surface, keyed by run_id: chit_start opens a run,
// chit_next advances it one unit (a one-shot run's ready wave, or one loop
// iteration), chit_status / chit_trace inspect it, chit_cancel stops it. The
// manifest's policy decides one-shot (a single DAG pass) vs loop (converge); mode
// decides foreground (this session supervises it) vs background (a detached worker
// drives it, durable across reconnect). Each step is a visible tool call with a
// live heartbeat; chit owns the manifest's declared order.
//
// Register (stdio):
//   claude mcp add chit --scope local -- bun <repo>/apps/cli/src/surfaces/mcp/server.ts
//
// Run tools: chit_start / chit_next / chit_status / chit_wait / chit_trace /
// chit_cancel. Batch tools (many runs in parallel worktrees): chit_batch_start /
// list / status / advance / cancel / cleanup. Audit tools (read the local
// transcripts): chit_audit_list / chit_audit_show.
//
// Inspecting execution state goes THROUGH these tools, never chit's on-disk state
// (the loop logs, job records, and batch state under the state dir are private
// implementation detail and may move): chit_status reads a snapshot now; chit_wait
// blocks until a background run finishes or a batch needs advancing (instead of
// polling); chit_trace is one run's history; chit_audit_show opens one receipt by
// its audit_ref. Everything chit owns about a run is reachable from its run_id.

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import {
	composeLoopStatusLine,
	type LoopRecord,
	type ManifestSpec,
	PlanError as PlanParseError,
	parseManifest,
	type RequiredCheck,
	type ResolvedManifest,
	resolveManifest,
} from "@chit-run/core";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { listAudit, showAudit } from "../../audit/reader.ts";
import { AuditStore, AuditStoreError } from "../../audit/store.ts";
import {
	advanceBatch,
	type BatchEngineDeps,
	batchWaitState,
	cancelBatch,
	cleanupBatch,
	describeBatch,
	listBatches,
	startBatch,
} from "../../batches/engine.ts";
import { PlanError } from "../../batches/plan.ts";
import { BatchStore, BatchStoreError } from "../../batches/store.ts";
import {
	applyRunWorkspace,
	cleanupRunWorkspace,
	commitWorktree,
	createPlanIntegrationWorktree,
	createPlanStepWorktree,
	createTaskWorktree,
	describePartialWork,
	inspectPartialWork,
	mainRepoOfWorktree,
	type PartialWorkView,
	prepareRunWorkspace,
	realGit,
	removeTaskWorktree,
	WorktreeError,
} from "../../batches/worktree.ts";
import {
	phaseOfStepStart,
	prepareConvergeExecute,
	rejectCallTimeoutForOneShot,
} from "../../cli/converge.ts";
import { DEFAULT_CONVERGE_MANIFEST } from "../../cli/default-converge-manifest.ts";
import { loadConfig } from "../../config/load.ts";
import { formatDuration, isStale, jobTiming, pidAlive, runWaitState } from "../../jobs/health.ts";
import { acquireLock, LockError, releaseLock } from "../../jobs/lock.ts";
import { JobStore, JobStoreError } from "../../jobs/store.ts";
import type { JobRecord, LoopJobRecord, OneShotJobRecord } from "../../jobs/types.ts";
import { runJobWorker } from "../../jobs/worker.ts";
import { repoKey } from "../../loops/location.ts";
import {
	type FoundLoop,
	findLoopByRunId,
	LoopStoreError,
	readLoop,
	startLoop,
	stopLoop,
} from "../../loops/log-store.ts";
import { pickRequiredChecks, resolveRunRequiredChecks } from "../../loops/required-checks.ts";
import {
	advancePlan,
	cancelPlan,
	describePlan,
	listPlans,
	type PlanEngineDeps,
	PlanEngineError,
} from "../../plans/engine.ts";
import { PlanStore, PlanStoreError } from "../../plans/store.ts";
import { runPlanApply, runPlanCleanup, runPlanStart } from "../../plans/tools.ts";
import { validateOneShotAuth } from "../../runs/run-once.ts";
import { prepareInputs } from "../../runtime/render.ts";
import { type ResolvedRun, RunController } from "./controller.ts";
import { ControllerStore } from "./controller-store.ts";
import {
	type ConvergeSession,
	cancelConverge,
	type LoopPhase,
	type NextResult,
	runNextIteration,
	startConvergeSession,
	traceConverge,
} from "./converge-engine.ts";
import {
	cancelStep,
	finalOutput,
	isComplete,
	type Run,
	readySteps,
	runStep,
	type StepControllers,
	startRun,
} from "./engine.ts";
import { describeServerVersion, RUNNING_VERSION, resolveOwnVersion } from "./server-version.ts";
import {
	buildStatus,
	needsDecisionNextAction,
	publicRunSummary,
	publicTimeline,
} from "./status.ts";

// AbortControllers for in-flight steps, so chit_cancel can stop a running step
// even after the model's turn is interrupted (the server keeps running).
const controllers: StepControllers = new Map();
// The local audit store (~/.local/state/chit/audit), read-only here: the audit
// tools inspect runs that converge/run/MCP-start wrote. Reads validate run ids
// and only resolve blob refs that appear in a run's own events.
const auditStore = new AuditStore();
// Durable background jobs (~/.local/state/chit/jobs). Unlike the in-memory
// foreground runs, jobs survive MCP reconnect: a detached worker process owns the
// run, and these tools read/cancel it through the durable record.
const jobStore = new JobStore();
// The unified run controller: one merged, idle-evicting in-memory store of
// FOREGROUND runs (one-shot DAG runs + converge loops, keyed by run_id), plus
// resolution into the durable JobStore for background runs (run_id == jobId). The
// stepwise/converge tools register and look up through it; see controller.ts.
const runController = new RunController(new ControllerStore(), jobStore);
// The config (agents + roles) is loaded lazily on first use, not at import. The CLI
// binary imports this module to expose `chit mcp`, so importing it must not read
// ~/.config/chit/config.json (that read belongs to a running server, not to every
// `chit` invocation). loadConfig can also throw on a malformed config; deferring it
// keeps that failure on the mcp path, not on import. Call sites read `.registry` and
// `.roles` off the cached config directly.
let configCache: ReturnType<typeof loadConfig> | undefined;
function getConfig(): ReturnType<typeof loadConfig> {
	configCache ??= loadConfig();
	return configCache;
}

// Exported so a test can connect a client over an in-memory transport and assert the
// registered tool surface (e.g. the plan tools are present). Importing the module still
// starts nothing; only startMcpServer / a test's explicit connect attaches a transport.
export const server = new McpServer(
	{ name: "chit", version: "0.0.0" },
	{ capabilities: { logging: {} } },
);

function jsonResult(obj: unknown) {
	return { content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }] };
}
function errorResult(message: string) {
	return { content: [{ type: "text" as const, text: `error: ${message}` }], isError: true };
}

// A raw node filesystem error (readFileSync / appendFileSync / readdirSync /
// openSync / mkdirSync ...) is an ErrnoException: its `code` is an errno (ENOENT,
// EACCES, EIO, EROFS, ENOSPC, ...) and BOTH its `.path` property and its message
// embed the absolute path it touched. The storage classes below wrap MOST of these,
// but any one that escapes a store un-typed must not leak the path through the
// fallback. The `.path` check keeps this to filesystem errors: a network error
// (ECONNREFUSED, ...) also has an errno `code` but no `.path`, and its message is
// caller-relevant with no local path, so it passes through.
function isNodeFsError(e: unknown): boolean {
	if (!(e instanceof Error)) return false;
	const err = e as { code?: unknown; path?: unknown };
	return typeof err.code === "string" && /^E[A-Z]+$/.test(err.code) && typeof err.path === "string";
}

// Map an error to a user-safe MCP message. Storage-layer errors (the loop log, the
// audit store, the job store, a lock, or any raw filesystem error) put absolute
// paths and internal ids (the loop-log key, the audit run id) in their messages; the
// unified surface must never surface those, so they collapse to a run-scoped reason.
// Every other error (a validation failure, a manifest/adapter run error) is about the
// caller's own run and passes through.
export function safeMcpError(e: unknown): string {
	if (e instanceof LoopStoreError) return "the run's loop log could not be read or written";
	if (e instanceof AuditStoreError) return "the audit transcript could not be read";
	if (e instanceof JobStoreError) return "the run record could not be read or written";
	// A LockError carries the absolute lock-file path (and the rm hint), so it must
	// never reach the user raw; collapse it to a run-scoped, retryable reason.
	if (e instanceof LockError) return "the run is locked by another operation; retry shortly";
	// A raw filesystem error from any store that did not wrap it (its message embeds
	// the absolute state path). Genericize rather than leak the path.
	if (isNodeFsError(e)) return "a local filesystem operation failed";
	return (e as Error).message;
}

function readySummary(run: Run) {
	return readySteps(run).map((id) => {
		const r = run.records[id];
		if (!r) return { step: id };
		return r.kind === "call"
			? {
					step: id,
					kind: "call",
					participant: r.participantId,
					agent: r.agentId,
					session: r.session,
				}
			: { step: id, kind: "format" };
	});
}

// --- audit tools ----------------------------------------------------------
//
// Read the local audit transcripts (what `chit converge`, `chit run --audit`, and
// MCP audited runs wrote) from inside a chat. Same reader as `chit audit
// list/show`. Read-only: list summarizes every run; show returns one run's
// timeline, with prompt/output/event bodies included ONLY when explicitly asked,
// and bodies resolved only from refs the run's own events carry (no arbitrary
// file reads). An incomplete run (no run.completed) is labelled with why: an open
// call killed mid-flight, a failed step, or an abandoned run.

server.registerTool(
	"chit_audit_list",
	{
		description:
			"List audited runs (newest first): each row is a receipt addressed by audit_ref, plus manifest, surface, scope, iteration, status (or `incomplete`), step count, usage/cost, and an open-call marker for a run killed mid-call. Open one with chit_audit_show using its audit_ref. (audit_ref is a receipt handle, distinct from a control run_id.)",
		inputSchema: {
			limit: z
				.number()
				.int()
				.min(1)
				.optional()
				.describe("Return at most this many runs (newest first). Default: all."),
		},
	},
	async ({ limit }) => {
		try {
			return jsonResult({ runs: listAudit(auditStore, limit).map(publicRunSummary) });
		} catch (e) {
			// A filesystem failure in the audit store must not surface its absolute
			// path; reduce it to a run-scoped reason like every other storage error.
			return errorResult(safeMcpError(e));
		}
	},
);

server.registerTool(
	"chit_audit_show",
	{
		description:
			"Show one audited run as a receipt, addressed by its audit_ref (a receipt handle, distinct from a control run_id): a summary (manifest/surface/scope/status/usage), the recorded participant config, and a step-level timeline (run/step lifecycle and adapter calls with duration and usage). Get an audit_ref from chit_trace's auditRefs (a loop has one per iteration) or chit_audit_list. The raw per-call adapter event stream is hidden by default; set verbose to include those rows. Prompt/output/event bodies are included ONLY when include_bodies is true (they can be large or hold secrets), and only for blob refs the run's own events carry. verbose and include_bodies are independent.",
		inputSchema: {
			audit_ref: z
				.string()
				.describe(
					"A receipt handle from chit_trace's auditRefs or chit_audit_list (a one-shot run's audit_ref equals its run_id). NOT a control run_id.",
				),
			verbose: z
				.boolean()
				.default(false)
				.describe("Include the raw adapter.event rows (the CLI event stream). Off by default."),
			include_bodies: z
				.boolean()
				.default(false)
				.describe(
					"Resolve blob bodies (rendered prompts/outputs/events) for shown rows. Off by default.",
				),
		},
	},
	async ({ audit_ref, verbose, include_bodies }) => {
		try {
			const shown = showAudit(auditStore, audit_ref, { includeBodies: include_bodies, verbose });
			// Present the receipt by audit_ref only: the summary via publicRunSummary
			// and the timeline with each event's runId/loopId stripped (publicTimeline),
			// so no row carries a control run_id or loop handle.
			return jsonResult({
				...shown,
				summary: publicRunSummary(shown.summary),
				timeline: publicTimeline(shown.timeline),
			});
		} catch (e) {
			return errorResult(safeMcpError(e));
		}
	},
);

// --- status tool ----------------------------------------------------------
//
// One read-only overview for the overseeing agent: the runs and converge loops
// live in THIS server right now (with each loop's status and next action), plus
// a compact slice of recently audited runs from the durable store. chit's
// MCP-native answer to a workflows progress view. Side-effect-free: it does NOT
// sweep or touch the in-memory stores, so polling it never keeps a run alive
// (see status.ts). Active state is per-session; recent state is durable.

server.registerTool(
	"chit_status",
	{
		description:
			"Run status. With a run_id: that run's status, whether it is foreground (supervised by this session) or a durable background run. With no run_id: the operator overview of what is active in this server now plus a compact list of recently finished runs (newest first). Read-only. Active foreground state is per-session (a new session starts empty, idle runs are evicted); background runs and recent history are durable across reconnect. Drill into history with chit_trace; open a receipt with chit_audit_show.",
		inputSchema: {
			run_id: z
				.string()
				.optional()
				.describe("A run id (from chit_start). Omit for the operator overview."),
			recent_limit: z
				.number()
				.int()
				.min(0)
				.default(5)
				.describe(
					"Overview only: how many recently finished runs to include (newest first). Default 5; 0 for none.",
				),
		},
	},
	async ({ run_id, recent_limit }) => {
		if (run_id === undefined) {
			// Re-read the on-disk version now and compare against the startup capture, so
			// the overview warns when the installed binary has been upgraded past this
			// running server (a reconnect is needed to pick it up).
			const server = describeServerVersion(RUNNING_VERSION, resolveOwnVersion());
			return jsonResult(
				buildStatus(runController, auditStore, jobStore, recent_limit, Date.now(), server),
			);
		}
		// One `now` for the resolve AND the view, so the in-flight activity's elapsed /
		// phaseElapsed / heartbeat-age are computed against the same instant the snapshot
		// was read (this run may be mid-iteration in a concurrent chit_next).
		const now = Date.now();
		const resolved = runController.resolve(run_id, now);
		if (!resolved) return errorResult(`unknown run_id ${run_id}`);
		return jsonResult(unifiedRunView(resolved, now));
	},
);

// Block until a chit-owned execution reaches a meaningful state, instead of the
// caller polling chit_status (or worse, polling chit's private state files). This
// is the notification primitive an operator reaches for ("tell me when it's done"):
// it is READ-ONLY -- it never advances a batch or mutates a run; it only watches the
// durable state chit already owns and returns the same view chit_status would, plus
// a waitResult. It is intended for durable BACKGROUND runs and batches; a foreground
// run has nothing to wait on (chit_next already blocks until its unit settles), so
// chit_wait refuses one and points back at chit_next.
const WAIT_POLL_MS = 2000;

// Sleep that resolves early (false) if the request is aborted (Esc), else true.
function waitTick(ms: number, signal: AbortSignal): Promise<boolean> {
	return new Promise((resolveTick) => {
		if (signal.aborted) return resolveTick(false);
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolveTick(true);
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			resolveTick(false);
		};
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

server.registerTool(
	"chit_wait",
	{
		description:
			"Block until a background run or batch reaches a meaningful state, then return the same view as chit_status / chit_batch_status plus a waitResult. Use this instead of polling chit_status in a loop (and never poll chit's state files -- they are private). For a background run (run_id): waits until the run is terminal (completed / failed / cancelled, or its worker died). For a batch (batch_id): waits until chit_batch_advance would do real work (a task can launch or a finished job can reconcile) or the batch is fully terminal -- it does NOT advance the batch itself. The batch loop is: chit_wait -> chit_batch_advance -> chit_batch_status, repeated until the batch is terminal -- ready_for_review (every task clean), needs_human (a task needs a decision or is blocked), failed, or cancelled (a needs_advance result means call chit_batch_advance now, then wait again). Read-only. Emits a heartbeat while waiting; press Esc to stop waiting (the run/batch keeps running). A foreground run is rejected: advance it with chit_next. waitResult is terminal | needs_advance | timeout. Inputs: run_id OR batch_id, optional timeout_ms (default 900000), cwd (batch only).",
		inputSchema: {
			run_id: z
				.string()
				.optional()
				.describe("A background run id (from chit_start mode background)."),
			batch_id: z
				.string()
				.optional()
				.describe("A batch id (from chit_batch_start or chit_batch_list)."),
			timeout_ms: z
				.number()
				.int()
				.min(1000)
				.default(900000)
				.describe(
					"Give up waiting after this long and return waitResult timeout. Default 900000 (15m).",
				),
			cwd: z
				.string()
				.optional()
				.describe("Batch only: any path in the target repo (defaults to server cwd)."),
		},
	},
	async ({ run_id, batch_id, timeout_ms, cwd }, extra) => {
		if ((run_id === undefined) === (batch_id === undefined)) {
			return errorResult("provide exactly one of run_id or batch_id");
		}
		const deadline = Date.now() + timeout_ms;
		let beats = 0;
		const progressToken = extra._meta?.progressToken;
		const heartbeat = (message: string) => {
			beats++;
			if (progressToken !== undefined) {
				void extra
					.sendNotification({
						method: "notifications/progress",
						params: { progressToken, progress: beats, message },
					})
					.catch(() => {});
			}
			void server
				.sendLoggingMessage({ level: "info", data: message, logger: "chit" })
				.catch(() => {});
		};

		// --- background run: wait until terminal ---
		if (run_id !== undefined) {
			const resolved = runController.resolve(run_id, Date.now());
			if (!resolved) return errorResult(`unknown run_id ${run_id}`);
			if (resolved.mode === "foreground") {
				return errorResult(
					`run "${run_id}" is foreground (supervised by this chat); advance it with chit_next, do not wait on it`,
				);
			}
			while (true) {
				const current = runController.resolve(run_id, Date.now());
				// The durable record cannot vanish mid-wait (it is never deleted), but guard
				// anyway: treat a disappeared run as terminal rather than looping forever.
				if (current?.mode !== "background") {
					return jsonResult({ run_id, waitResult: "terminal" as const });
				}
				if (runWaitState(current.job, Date.now()) === "terminal") {
					return jsonResult({ ...unifiedRunView(current), waitResult: "terminal" as const });
				}
				if (Date.now() >= deadline) {
					return jsonResult({ ...unifiedRunView(current), waitResult: "timeout" as const });
				}
				heartbeat(`run ${run_id} still ${current.job.state}; waiting`);
				if (!(await waitTick(WAIT_POLL_MS, extra.signal))) {
					return jsonResult({ ...unifiedRunView(current), waitResult: "timeout" as const });
				}
			}
		}

		// --- batch: wait until it needs an advance, or is terminal ---
		const store = new BatchStore(resolve(cwd ?? process.cwd()));
		// Validate up front so an unknown batch_id errors immediately, not after a tick.
		try {
			if (!store.get(batch_id as string)) return errorResult(`unknown batch_id ${batch_id}`);
		} catch (e) {
			return batchError(e);
		}
		while (true) {
			let batch: ReturnType<BatchStore["get"]>;
			try {
				batch = store.get(batch_id as string);
			} catch (e) {
				return batchError(e);
			}
			if (!batch) return jsonResult({ batch_id, waitResult: "terminal" as const });
			const state = batchWaitState(batch, batchDeps);
			if (state !== "working") {
				return jsonResult({
					...describeBatch(batch, batchDeps),
					waitResult: state === "terminal" ? ("terminal" as const) : ("needs_advance" as const),
				});
			}
			if (Date.now() >= deadline) {
				return jsonResult({ ...describeBatch(batch, batchDeps), waitResult: "timeout" as const });
			}
			heartbeat(`batch ${batch_id} working; waiting`);
			if (!(await waitTick(WAIT_POLL_MS, extra.signal))) {
				return jsonResult({ ...describeBatch(batch, batchDeps), waitResult: "timeout" as const });
			}
		}
	},
);

// --- background run helpers -------------------------------------------------
//
// chit_start with mode background launches a run in a DETACHED worker process and
// returns immediately; chit_status inspects it; chit_cancel stops it from any later
// turn. Unlike a foreground run (advanced one unit per chit_next call, in-memory),
// a background run survives MCP reconnect: its state lives in the durable JobStore,
// plus the loop log (loop policy) and the audit store. These helpers create and
// launch those jobs and present them under run_id.

// Spawn the worker as `bun <entry> job-run <jobId>`, reusing this process's exact
// runtime + entry (process.argv[0..1]) so it works the same from source or the
// packaged binary. detached + stdio ignore + unref: the worker outlives this
// server (survives reconnect) and is its own process-group leader (pgid === pid),
// so chit_cancel can signal the whole group.
function spawnJobWorker(jobId: string, cwd: string): void {
	const child = spawn(String(process.argv[0]), [String(process.argv[1]), "job-run", jobId], {
		cwd,
		detached: true,
		stdio: "ignore",
	});
	// spawn() can succeed synchronously but fail asynchronously (e.g. a bad cwd ->
	// ENOENT after this returns). An unhandled 'error' would CRASH the server, and
	// the job would sit queued forever. Catch it, mark the still-queued job failed so
	// chit_status surfaces the failure instead of a phantom queued run.
	child.once("error", () => {
		try {
			jobStore.update(jobId, (c) =>
				c.state === "queued"
					? {
							...c,
							state: "failed",
							failure: "worker failed to start",
							endedAt: new Date().toISOString(),
						}
					: c,
			);
		} catch {
			// best effort; the job record may have been swept or already terminal
		}
	});
	child.unref();
}

// One chit-executed verification command (spawned as argv, no shell). The shared
// per-check SHAPE for every surface -- chit_start, batch-level, and task-level -- so
// they cannot drift. The field NAME follows each surface's convention (required_checks
// at a snake_case top level; requiredChecks on the camelCase batch task object); the
// shape is this.
const requiredCheckInputSchema = z.object({
	command: z.string().min(1),
	args: z.array(z.string()).default([]),
	name: z.string().min(1).optional(),
	timeoutMs: z.number().int().positive().optional(),
});

// Launch one detached background converge job: validate the manifest, reserve the
// loop, create the durable job record, spawn the worker. Shared by chit_start
// (mode background, loop policy) and the batch engine (one per runnable task), so both refuse the
// same manifests and produce identical job/loop state. Returns the ids + any
// unenforced-permission warnings, or a single error string.
function launchConvergeJob(p: {
	task: string;
	scope: string;
	cwd: string; // absolute
	manifestPath?: string; // absolute or relative to cwd; undefined -> bundled default
	maxIterations: number;
	loopId?: string;
	// The public run id, pre-generated by the caller so the managed worktree (chit-run/<runId>)
	// and the surfaced run_id match. Undefined -> generated here (batch tasks).
	runId?: string;
	// A chit-managed worktree this run executes in (cwd is already the worktree path).
	// Recorded for surfacing + cleanup (chit_apply / chit_cleanup read it); absent only for an
	// in_place run. Set for an isolated single run AND for every batch task (the batch forwards
	// each task's worktree, so a batch task applies exactly like a single background run).
	worktree?: {
		worktreePath: string;
		branch: string;
		baseSha: string;
		repo: string;
		callerCheckout: string;
	};
	force?: boolean;
	// The EFFECTIVE required checks for this run, persisted on the job so the worker
	// runs the intended checks without re-deriving them. Undefined -> the worker falls
	// back to the manifest policy's requiredChecks.
	requiredChecks?: RequiredCheck[];
	// The EFFECTIVE per-call timeout override (ms) for this run. Persisted on the job
	// so the detached worker applies it (the validation prep below DISCARDS its execute,
	// so the value only matters via the job record). Undefined -> agent config / default.
	callTimeoutMs?: number;
	allowUnenforced: boolean;
}): { ok: true; jobId: string; loopId: string; warnings: string[] } | { ok: false; error: string } {
	let raw: unknown;
	let manifestAbs: string | undefined;
	if (p.manifestPath) {
		manifestAbs = isAbsolute(p.manifestPath) ? p.manifestPath : resolve(p.cwd, p.manifestPath);
		try {
			raw = JSON.parse(readFileSync(manifestAbs, "utf-8"));
		} catch (e) {
			return {
				ok: false,
				error: `could not read manifest at ${manifestAbs}: ${(e as Error).message}`,
			};
		}
	} else {
		raw = DEFAULT_CONVERGE_MANIFEST;
	}
	let config: ReturnType<typeof getConfig>;
	try {
		config = getConfig();
	} catch (e) {
		return { ok: false, error: `could not load config: ${(e as Error).message}` };
	}
	const prep = prepareConvergeExecute(
		raw,
		config.registry,
		p.scope,
		p.cwd,
		p.allowUnenforced,
		config.roles,
	);
	if (!prep.ok) return { ok: false, error: prep.error };

	// The FINAL snapshot boundary for required checks: the caller's override (run-level
	// for chit_start, task??batch for a batch) REPLACES the manifest's; absent, the
	// manifest's stand. Persisted on the job so the worker runs exactly these (a later
	// manifest edit cannot change a queued run); the worker's manifest fallback is then
	// only for legacy job records that predate this field.
	const effectiveChecks = pickRequiredChecks(p.requiredChecks, prep.loopSteps.requiredChecks);

	const loopId = p.loopId ?? crypto.randomUUID();
	try {
		startLoop(p.cwd, {
			scope: p.scope,
			task: p.task,
			maxIterations: p.maxIterations,
			loopId,
			force: p.force,
		});
	} catch (e) {
		if (e instanceof LoopStoreError) {
			// Run-scoped message only: a LoopStoreError carries the loop-log path (which
			// embeds the internal loop id), so do NOT pass e.message through to the user.
			return {
				ok: false,
				error:
					"could not reserve this run's loop (it may already be in progress); continue the existing run with chit_next, or start a fresh run",
			};
		}
		return { ok: false, error: safeMcpError(e) };
	}

	const runId = p.runId ?? crypto.randomUUID();
	const job: LoopJobRecord = {
		runId,
		policy: "loop",
		loopId,
		repoKey: repoKey(p.cwd),
		cwd: p.cwd,
		...(p.worktree && {
			worktreePath: p.worktree.worktreePath,
			branch: p.worktree.branch,
			baseSha: p.worktree.baseSha,
			repo: p.worktree.repo,
			callerCheckout: p.worktree.callerCheckout,
		}),
		scope: p.scope,
		task: p.task,
		...(manifestAbs !== undefined && { manifestPath: manifestAbs }),
		maxIterations: p.maxIterations,
		// Always persist the resolved checks -- even "none", recorded as [] -- so the
		// worker runs exactly this snapshot and never re-resolves the manifest for a new
		// job. [] is treated as reviewer-sourced downstream; the worker's manifest fallback
		// is then reachable only by legacy records that predate this field.
		requiredChecks: effectiveChecks ?? [],
		...(p.callTimeoutMs !== undefined && { callTimeoutMs: p.callTimeoutMs }),
		allowUnenforced: p.allowUnenforced,
		state: "queued",
		createdAt: new Date().toISOString(),
		iterationsCompleted: 0,
		auditRefs: [],
	};
	try {
		jobStore.create(job);
	} catch (e) {
		// Best-effort cleanup: the job record never persisted, so close the loop we
		// reserved. If even that write fails, still return the original error rather
		// than throwing a raw store error past this Result-typed boundary.
		try {
			stopLoop(p.cwd, loopId, { status: "blocked", reason: "could not create job record" });
		} catch {}
		return { ok: false, error: safeMcpError(e) };
	}
	try {
		spawnJobWorker(runId, p.cwd);
	} catch {
		// Best-effort cleanup after a spawn failure; never let a cleanup-write error
		// escape (the caller trusts this function to return a Result, not throw).
		try {
			jobStore.update(runId, (c) => ({
				...c,
				state: "failed",
				failure: "worker failed to spawn",
				endedAt: new Date().toISOString(),
			}));
			stopLoop(p.cwd, loopId, { status: "blocked", reason: "worker spawn failed" });
		} catch {}
		return { ok: false, error: "could not spawn the background worker" };
	}
	// run_id == the durable record's runId. The return keeps the legacy `jobId`
	// field name for the still-present old tools (Union-A); 4b switches to run_id.
	return { ok: true, jobId: runId, loopId, warnings: prep.warnings };
}

// Launch one detached background ONE-SHOT job: a manifest run once to completion
// (no loop). Validates exactly as startRun does for a foreground one-shot (unknown
// agents, enforcement gaps, per_scope needs a scope, inputs match the schema), so a
// background run is refused for the same reasons a foreground one is. Validation is
// at enqueue: the worker re-reads the manifest and runs it via runManifestOnce but
// does not re-validate, so a bad manifest is rejected here, synchronously, before a
// detached worker is spawned. A one-shot run reserves no loop, so (unlike a loop
// job) there is no loop log to close on failure.
function launchOneShotJob(p: {
	manifestPath: string; // absolute or relative to cwd (a one-shot run always names a manifest)
	scope?: string;
	cwd: string; // absolute
	inputs: Record<string, unknown>;
	audit: boolean;
	allowUnenforced: boolean;
}): { ok: true; jobId: string; warnings: string[] } | { ok: false; error: string } {
	const manifestAbs = isAbsolute(p.manifestPath) ? p.manifestPath : resolve(p.cwd, p.manifestPath);
	// Load config FIRST, in its own try, so a malformed config.json reports as a
	// config error rather than being misattributed to the manifest below. The loop
	// launcher (prepareConvergeExecute) and the CLI run path isolate config the same
	// way. getConfig is memoized, so this resolves the roles the manifest needs and
	// the registry the governance gate needs from one load.
	let config: ReturnType<typeof getConfig>;
	try {
		config = getConfig();
	} catch (e) {
		return { ok: false, error: `could not load config: ${(e as Error).message}` };
	}
	const registry = config.registry;

	let manifest: ResolvedManifest;
	try {
		// Resolve role refs before governance (validateOneShotAuth reads the resolved
		// participants). An unknown-role / no-agent failure is reported the same way as
		// a parse failure.
		manifest = resolveManifest(parseManifest(JSON.parse(readFileSync(manifestAbs, "utf-8"))), {
			roles: config.roles,
		});
	} catch (e) {
		return {
			ok: false,
			error: `could not load manifest at ${manifestAbs}: ${(e as Error).message}`,
		};
	}
	// Governance gate (unknown agents, enforcement, per_scope scope), shared with the
	// worker's re-validation. The same decision is persisted (allowUnenforced) so the
	// worker re-checks in its own process.
	const auth = validateOneShotAuth(manifest, registry, {
		...(p.scope !== undefined && { scope: p.scope }),
		allowUnenforced: p.allowUnenforced,
	});
	if (!auth.ok) return { ok: false, error: auth.error };
	// Fail fast on bad inputs (unknown/missing/wrong-type), so a detached worker is
	// not spawned only to fail; the worker re-prepares from the stored inputs.
	try {
		prepareInputs(manifest.inputs, p.inputs, p.cwd);
	} catch (e) {
		return { ok: false, error: (e as Error).message };
	}

	const runId = crypto.randomUUID();
	const job: OneShotJobRecord = {
		runId,
		policy: "one-shot",
		repoKey: repoKey(p.cwd),
		cwd: p.cwd,
		manifestPath: manifestAbs,
		manifestId: manifest.id,
		...(p.scope !== undefined && { scope: p.scope }),
		inputs: p.inputs,
		audit: p.audit,
		allowUnenforced: p.allowUnenforced,
		state: "queued",
		createdAt: new Date().toISOString(),
		auditRefs: [],
	};
	try {
		jobStore.create(job);
	} catch (e) {
		return { ok: false, error: safeMcpError(e) };
	}
	try {
		spawnJobWorker(runId, p.cwd);
	} catch {
		// Best-effort cleanup; never let a cleanup-write error escape this Result.
		try {
			jobStore.update(runId, (c) => ({
				...c,
				state: "failed",
				failure: "worker failed to spawn",
				endedAt: new Date().toISOString(),
			}));
		} catch {}
		return { ok: false, error: "could not spawn the background worker" };
	}
	return { ok: true, jobId: runId, warnings: auth.warnings };
}

// Compact, durable per-job view: lifecycle state (with derived `stale` when a
// running worker is gone/silent), the live phase, and timing. A loop run also
// surfaces its latest iteration's changed files / usage from the loop log; a
// one-shot run has no loop log (its history is the audit run). Dispatches on
// policy so loop-only fields appear only for loop runs.
function describeJob(job: JobRecord) {
	const now = Date.now();
	const stale = isStale(job, now);
	const display = stale ? "stale" : job.state;
	const timing = jobTiming(job, now);
	const latestRef = job.auditRefs.at(-1);
	// Running prose names the phase and how long it (and the job) have run, so a
	// long job is legible without diffing timestamps.
	const runningDetail = [
		timing.elapsedMs !== undefined ? `running for ${formatDuration(timing.elapsedMs)}` : undefined,
		job.phase
			? timing.phaseElapsedMs !== undefined
				? `${job.phase} for ${formatDuration(timing.phaseElapsedMs)}`
				: job.phase
			: undefined,
	].filter(Boolean);
	// Fields every job carries, regardless of policy.
	const base = {
		runId: job.runId,
		policy: job.policy,
		state: job.state,
		display,
		stale,
		alive: pidAlive(job.pid),
		...(job.phase !== undefined && { phase: job.phase }),
		...(job.failure !== undefined && { failure: job.failure }),
		...(job.cancelRequestedAt !== undefined && { cancelRequestedAt: job.cancelRequestedAt }),
		auditRefs: job.auditRefs,
		createdAt: job.createdAt,
		...(job.startedAt !== undefined && { startedAt: job.startedAt }),
		...(job.endedAt !== undefined && { endedAt: job.endedAt }),
		...(job.lastHeartbeatAt !== undefined && { lastHeartbeatAt: job.lastHeartbeatAt }),
		...(job.phaseStartedAt !== undefined && { phaseStartedAt: job.phaseStartedAt }),
		...(timing.elapsedMs !== undefined && { elapsedMs: timing.elapsedMs }),
		...(timing.lastHeartbeatAgeMs !== undefined && {
			lastHeartbeatAgeMs: timing.lastHeartbeatAgeMs,
		}),
		...(timing.phaseElapsedMs !== undefined && { phaseElapsedMs: timing.phaseElapsedMs }),
	};

	if (job.policy === "loop") {
		let latest:
			| { iteration: number; changedFiles: string[]; workspaceWarnings: string[]; usage?: unknown }
			| undefined;
		try {
			const iters = readLoop(job.cwd, job.loopId).filter((r) => r.type === "iteration");
			const last = iters.at(-1);
			if (last && last.type === "iteration") {
				latest = {
					iteration: last.n,
					changedFiles: last.changedFiles,
					workspaceWarnings: last.workspaceWarnings ?? [],
					...(last.usage !== undefined && { usage: last.usage }),
				};
			}
		} catch {
			// loop log not readable yet (worker still starting) or removed; omit detail
		}
		const nextAction =
			display === "running"
				? `${runningDetail.length > 0 ? `${runningDetail.join(", ")}; ` : ""}chit_cancel to stop, or wait and poll again`
				: display === "queued"
					? "queued; the worker is starting"
					: display === "stale"
						? `worker appears dead; inspect with chit_status${latestRef ? ` (chit_audit_show { audit_ref: "${latestRef}" } for the transcript)` : ""}, then start a fresh run`
						: `${display}${job.stopStatus ? ` (${job.stopStatus})` : ""}; ${latestRef ? `open a transcript with chit_audit_show { audit_ref: "${latestRef}" }` : "no audit transcript was recorded"}`;
		return {
			...base,
			loopId: job.loopId,
			scope: job.scope,
			task: job.task,
			...(job.iteration !== undefined && { iteration: job.iteration }),
			iterationsCompleted: job.iterationsCompleted,
			...(job.lastVerdict !== undefined && { lastVerdict: job.lastVerdict }),
			...(job.lastVerification !== undefined && { lastVerification: job.lastVerification }),
			...(job.lastVerificationSource !== undefined && {
				lastVerificationSource: job.lastVerificationSource,
			}),
			...(job.stopStatus !== undefined && { stopStatus: job.stopStatus }),
			...(job.callTimeoutMs !== undefined && { callTimeoutMs: job.callTimeoutMs }),
			...(latest !== undefined && { latest }),
			nextAction,
		};
	}

	// One-shot: no loop log; the history is the single audit run.
	const nextAction =
		display === "running"
			? `${runningDetail.length > 0 ? `${runningDetail.join(", ")}; ` : ""}chit_cancel to stop, or wait and poll again`
			: display === "queued"
				? "queued; the worker is starting"
				: display === "stale"
					? `worker appears dead; inspect with chit_status${latestRef ? ` (chit_audit_show { audit_ref: "${latestRef}" } for the transcript)` : ""}`
					: `${display}; ${latestRef ? `open a transcript with chit_audit_show { audit_ref: "${latestRef}" }` : "no audit transcript was recorded"}`;
	return {
		...base,
		manifestId: job.manifestId,
		...(job.scope !== undefined && { scope: job.scope }),
		nextAction,
	};
}

// Request cancellation of one job: persist the intent FIRST (survives a worker
// restart / stale detection), then signal the worker's process group, but never a
// stale job's possibly-reused pid. Shared by chit_cancel and the batch
// engine's cancelJob so both cancel identically.
type CancelResult =
	| { status: "missing" }
	| { status: "terminal"; state: JobRecord["state"] }
	| { status: "requested"; state: JobRecord["state"]; signaled: boolean };
function requestJobCancel(jobId: string): CancelResult {
	const job = jobStore.get(jobId);
	if (!job) return { status: "missing" };
	if (job.state !== "queued" && job.state !== "running") {
		return { status: "terminal", state: job.state };
	}
	const updated = jobStore.update(jobId, (c) => ({
		...c,
		cancelRequestedAt: new Date().toISOString(),
		...(c.state === "running" && { phase: "cancelling" as const }),
	}));
	let signaled = false;
	if (!isStale(updated, Date.now()) && updated.pgid !== undefined && pidAlive(updated.pid)) {
		try {
			process.kill(-updated.pgid, "SIGTERM");
			signaled = true;
		} catch {
			// ESRCH: the worker already exited. The persisted intent still stands.
		}
	}
	return { status: "requested", state: updated.state, signaled };
}

// --- unified run surface (run_id) -----------------------------------------
//
// One public id and one vocabulary over every run: chit_start opens a run,
// chit_next advances it, chit_status / chit_trace inspect it, chit_cancel stops
// it. A run is foreground (supervised by this session: a one-shot DAG run or a
// converge loop) or background (a durable job). These views present ONLY run_id
// and the unified verbs; the internal loop/job ids never appear as a handle.

// The per-run status view for chit_status({run_id}). Dispatches on where the run
// lives, re-presenting the existing per-kind describe* state under run_id.
// Managed-worktree fields for a run view (#85): where an isolated write run's diff
// lives + the base it was cut from, and an explicit flag that the caller's checkout
// was NOT edited. Empty for an in_place run (it ran in the caller checkout, which WAS
// edited) and for one-shot/read-only runs. Surfaced identically by every read surface.
function workspaceView(r: { worktreePath?: string; branch?: string; baseSha?: string }): {
	worktreePath?: string;
	branch?: string;
	baseSha?: string;
	callerCheckoutEdited?: boolean;
} {
	if (!r.worktreePath) return {};
	return {
		worktreePath: r.worktreePath,
		...(r.branch !== undefined && { branch: r.branch }),
		...(r.baseSha !== undefined && { baseSha: r.baseSha }),
		callerCheckoutEdited: false,
	};
}

// A run's diff is in its managed worktree, not the caller checkout: a TERMINAL-state
// hint that points an operator/agent there and tells them how to retire it. chit does not
// auto-clean a successful run (the worktree IS the review artifact). Prefer chit_cleanup
// (it resolves this run_id) over raw git; the manual commands are the fallback for an
// unresolvable run (a foreground run from a closed session). Only called on terminal
// nextActions, never on an active run. Empty for in_place runs (no worktree).
function worktreeInspectHint(r: { worktreePath?: string; branch?: string }, runId: string): string {
	if (!r.worktreePath) return "";
	const manual = r.branch
		? `\`git worktree remove ${r.worktreePath}\` then \`git branch -D ${r.branch}\``
		: `\`git worktree remove ${r.worktreePath}\``;
	return ` The run's changes are in its managed worktree (${r.worktreePath}); your checkout was not edited. Retire it with chit_cleanup { run_id: "${runId}" } (dry run), then chit_cleanup { run_id: "${runId}", confirm: true } to remove -- or, if this run is no longer resolvable (a foreground run from a closed session), manually: ${manual}.`;
}

export function unifiedRunView(resolved: ResolvedRun, now: number = Date.now()) {
	if (resolved.mode === "background") return backgroundRunView(resolved.job);
	return resolved.run.kind === "one-shot"
		? oneShotRunView(resolved.run.run)
		: loopRunView(resolved.run.session, now);
}

export function oneShotRunView(run: Run) {
	const complete = isComplete(run);
	return {
		run_id: run.runId,
		mode: "foreground" as const,
		execution: "one-shot" as const,
		manifest: run.manifest.id,
		complete,
		ready: complete ? [] : readySummary(run),
		output: complete ? finalOutput(run) : undefined,
		audit:
			run.recorder && run.recorder.lastError === undefined ? { audit_ref: run.runId } : undefined,
		nextAction: complete
			? `complete; chit_trace "${run.runId}" for the transcript`
			: `chit_next "${run.runId}" to run the next ready step(s); chit_cancel "${run.runId}" to stop`,
	};
}

// The in-flight activity snapshot for the single-run view: a compact object derived
// from the session's live activity mark + `now`, so an agent reading chit_status WHILE
// an iteration runs can answer "is it stuck?" without the live MCP progress
// notifications (UI-only best effort, never guaranteed to reach the calling model).
// Empty for a settled or never-run loop (no activity) -- so a stopped run reports its
// terminal receipt, never a stale phase. Field names mirror the background JobTiming
// (elapsedMs / phaseElapsedMs / phase) so the two surfaces read alike -- EXCEPT the
// freshness field, deliberately lastActivityAgeMs and NOT lastHeartbeatAgeMs: a
// foreground run has no periodic worker heartbeat (background beats every ~10s), the
// mark advances only on iteration start / phase transitions / cancel, so minutes-old
// is HEALTHY mid-phase here while it means stale on the background surface.
// statusLine reuses the heartbeat vocabulary ("iteration N · <phase> · <dur>").
function loopActivityView(
	session: ConvergeSession,
	now: number,
): {
	activity?: {
		iteration: number;
		phase?: LoopPhase;
		elapsedMs: number;
		phaseElapsedMs?: number;
		lastActivityAgeMs: number;
		statusLine: string;
	};
} {
	const a = session.activity;
	if (a === undefined) return {};
	// elapsedMs is the whole RUN's wall time so far (started->now), matching the
	// background JobTiming.elapsedMs; phaseElapsedMs is the finer "stuck in this phase"
	// signal, present once a phase is known.
	const elapsedMs = now - session.startedAtMs;
	const phaseElapsedMs = a.phaseStartedAtMs !== undefined ? now - a.phaseStartedAtMs : undefined;
	const lastActivityAgeMs = now - a.lastActivityAtMs;
	// "starting" until the first phase is known, matching the chit_next heartbeat's first
	// line; the line's duration is the current phase's when known, else the whole run's.
	const phaseWord = a.phase ?? "starting";
	const statusLine = `iteration ${a.iteration} · ${phaseWord} · ${formatDuration(
		phaseElapsedMs ?? elapsedMs,
	)}`;
	return {
		activity: {
			iteration: a.iteration,
			...(a.phase !== undefined && { phase: a.phase }),
			elapsedMs,
			...(phaseElapsedMs !== undefined && { phaseElapsedMs }),
			lastActivityAgeMs,
			statusLine,
		},
	};
}

export function loopRunView(session: ConvergeSession, now: number = Date.now()) {
	const status = session.terminalStatus ?? (session.active ? "running" : "open");
	const stopped = session.terminalStatus !== undefined;
	// The compact summary of the last completed iteration -- the same line chit_next
	// returns, recomposed from the session mirror so chit_status shows it after a long
	// chit_next. Absent until a round completes (an open never-run loop invents nothing).
	const statusLine = loopStatusLineFromSession(session);
	const nextAction = stopped
		? session.terminalStatus === "needs-decision"
			? needsDecisionNextAction(
					session.loopId,
					session.lastVerification,
					session.lastVerificationSource,
				) + worktreeInspectHint(session, session.loopId)
			: `loop ${session.terminalStatus}; chit_trace "${session.loopId}" for the history.${worktreeInspectHint(session, session.loopId)}`
		: session.active
			? `iteration in flight; chit_cancel "${session.loopId}" to stop it`
			: `chit_next "${session.loopId}" to run the next iteration; chit_cancel "${session.loopId}" to stop`;
	return {
		run_id: session.loopId,
		mode: "foreground" as const,
		execution: "loop" as const,
		status,
		...(statusLine !== undefined && { statusLine }),
		// The in-flight iteration's live activity (present only while an iteration runs):
		// what it is doing now + how long, so a concurrent chit_status can judge progress
		// without the UI-only heartbeats. Its own nested statusLine is the in-flight line;
		// the top-level statusLine above stays the LAST COMPLETED round's summary.
		...loopActivityView(session, now),
		...workspaceView(session),
		iterationsCompleted: session.iteration,
		cancellable: !stopped,
		...(session.lastVerdict !== undefined && { lastVerdict: session.lastVerdict }),
		...(session.lastVerification !== undefined && { lastVerification: session.lastVerification }),
		...(session.lastVerificationSource !== undefined && {
			lastVerificationSource: session.lastVerificationSource,
		}),
		...(session.lastDecision !== undefined && { lastDecision: session.lastDecision }),
		...(session.failure !== undefined && { failure: session.failure }),
		...(session.callTimeoutMs !== undefined && { callTimeoutMs: session.callTimeoutMs }),
		// Terminal receipt: elapsed (endedAtMs - startedAtMs, the same derivation
		// summarizeLoopForStatus uses) and WHY it stopped, both straight from the in-memory
		// mirror set in lockstep with terminalStatus -- present only once the loop has
		// stopped, so this single-run view reports a terminal run's timing + stop reason
		// without a loop-log read.
		...(session.endedAtMs !== undefined && { elapsedMs: session.endedAtMs - session.startedAtMs }),
		...(session.stopReason !== undefined && { stopReason: session.stopReason }),
		auditRefs: session.auditRefs,
		nextAction,
	};
}

// One compact, human-readable line summarizing the iteration that just ran, added to
// every chit_next loop response. The live heartbeats (notifications/progress,
// sendLoggingMessage) are UI-only best effort and may never reach the calling model,
// so an agent auditing the call later must be able to read what happened from the
// RETURNED data alone -- this is that line. Derived only from data the handler already
// holds; no new instrumentation.
export function loopStatusLine(result: NextResult, session: ConvergeSession): string {
	return composeLoopStatusLine({
		iteration: result.iteration,
		outcome: result.kind === "iteration" ? result.verdict : result.kind,
		checks: result.kind === "iteration" ? result.checks : undefined,
		source: session.lastVerificationSource,
		// This call's round is the one that just (maybe) stopped the loop, so the
		// current terminalStatus IS the round's own stop.
		stop: session.terminalStatus,
	});
}

// The chit_status counterpart to loopStatusLine: the SAME compact line, recomposed from the
// session mirror (the last completed iteration's cached bits) rather than the transient
// NextResult, so an agent that calls chit_status after a long chit_next reads the same summary.
// Absent until a round has completed (lastVerdict is the outcome word, set in lockstep with the
// other last* fields) -- an open loop with no completed iteration must not invent a line.
function loopStatusLineFromSession(session: ConvergeSession): string | undefined {
	if (session.lastVerdict === undefined) return undefined;
	return composeLoopStatusLine({
		iteration: session.iteration,
		outcome: session.lastVerdict,
		checks: session.lastChecks,
		source: session.lastVerificationSource,
		// The completed round's OWN stop (lastStopStatus), never the loop's current
		// terminalStatus: a later cancelled/failed attempt that completed no round sets
		// terminalStatus without advancing the mirror, and its stop must not be
		// attributed to this earlier round's line.
		stop: session.lastStopStatus,
	});
}

// A failed/blocked run can leave real edits UNCOMMITTED in its worktree that no completed-iteration
// record captured (e.g. the implementer timed out before iteration 1) -- so changedFiles reads
// empty and the work looks lost. For a terminal-but-not-clean loop run with a worktree, surface
// that partial work (files + diffstat) and reframe a timeout failure honestly. Returns {} when
// there is nothing to add (a clean run, no worktree, or a worktree with no uncommitted work), so
// the happy path is unchanged.
function partialWorkView(job: JobRecord): { partialWork?: PartialWorkView } {
	if (job.policy !== "loop" || !job.worktreePath) return {};
	// Surface partial work only when the run is NOT cleanly progressing:
	//   - failed: the worker recorded a terminal failure.
	//   - blocked: a blocked stop (e.g. the implement step timed out -> the loop stops blocked).
	//   - stale: the worker DIED mid-step without recording a terminal state (state stuck "running",
	//     but isStale) -- it can have left real work too. A HEALTHY running run is excluded, so a hot
	//     status poll never does git I/O and the live worktree (still changing) is not inspected.
	// A converged / needs-decision run already reports its diff via changedFiles.
	const stale = job.state === "running" && isStale(job, Date.now());
	if (!(job.state === "failed" || job.stopStatus === "blocked" || stale)) return {};
	const pw = describePartialWork(
		inspectPartialWork(realGit, job.worktreePath),
		job.worktreePath,
		job.failure,
	);
	return pw ? { partialWork: pw } : {};
}

// A durable background run, re-presented from describeJob under run_id with the
// unified verbs. Drops the jobId/loopId handles and the job-tool nextAction prose.
export function backgroundRunView(job: JobRecord) {
	const dj = describeJob(job);
	// Strip the internal handles (runId re-presented as run_id; loopId never a
	// public handle) and the old-verb prose; everything else is fine to surface.
	const { runId: _runId, nextAction: _next, ...rest0 } = dj;
	const { loopId: _loop, ...rest } = rest0 as typeof rest0 & { loopId?: string };
	void _runId;
	void _next;
	void _loop;
	const live = dj.display === "running" || dj.display === "queued";
	const stopSuffix = job.policy === "loop" && job.stopStatus ? ` (${job.stopStatus})` : "";
	return {
		run_id: job.runId,
		mode: "background" as const,
		execution: "job" as const,
		...rest,
		...workspaceView(job),
		...partialWorkView(job),
		nextAction: live
			? `running in the background; chit_status "${job.runId}" to poll, chit_cancel "${job.runId}" to stop`
			: dj.display === "stale"
				? `worker appears dead; chit_trace "${job.runId}" for what it recorded, then start a fresh run.${worktreeInspectHint(job, job.runId)}`
				: job.policy === "loop" && job.stopStatus === "needs-decision"
					? needsDecisionNextAction(job.runId, job.lastVerification, job.lastVerificationSource) +
						worktreeInspectHint(job, job.runId)
					: `${dj.display}${stopSuffix}; chit_trace "${job.runId}" for the history.${worktreeInspectHint(job, job.runId)}`,
	};
}

// --- #85 dispatch helpers (exported for unit tests) ----------------------------
// The chit_start handler is a closure not drivable in isolation, so the testable
// contract for the managed-worktree decisions lives in these pure/injectable helpers
// that the handler calls.

// Resolve a manifest_path to an absolute path against the CALLER cwd, so the manifest
// is read from where the user pointed -- identically for foreground and background,
// never re-resolved against a managed worktree (F2).
export function resolveManifestPathAbsolute(manifestPath: string, callerCwd: string): string {
	return isAbsolute(manifestPath) ? manifestPath : resolve(callerCwd, manifestPath);
}

// A loop MAY write iff some participant is not provably read-only. A provably-all-
// read-only loop writes nothing (no worktree needed); a role-ref whose permission
// resolves later reads as may-write here, erring toward isolation -- the safe
// direction (F1).
export function loopMayWriteFiles(
	participants: Record<string, { permissions?: { filesystem?: string } }>,
): boolean {
	return Object.values(participants).some((p) => p.permissions?.filesystem !== "read_only");
}

// Decide + open a write-loop's workspace with the ordering the review requires: config
// loads FIRST (a config error fails before any worktree exists, F3a), THEN a worktree
// opens only when the loop may write and in_place is off (F1). Deps are injected so the
// ordering and the isolate/in-place decision are unit-testable without the handler.
export function planManagedWorkspace<W>(
	deps: { ensureConfig: () => void; openWorkspace: (inPlace: boolean) => W },
	args: {
		participants: Record<string, { permissions?: { filesystem?: string } }>;
		inPlace: boolean;
	},
): W {
	deps.ensureConfig(); // F3a: before any worktree is created
	const mayWrite = loopMayWriteFiles(args.participants);
	return deps.openWorkspace(args.inPlace || !mayWrite);
}

// Resolve a run's managed-worktree metadata + worker liveness from an ALREADY-resolved
// ResolvedRun -- the one block chit_cleanup and chit_apply share. It takes the resolved
// value (not the run_id) on purpose: the two handlers print DIFFERENT not-found messages,
// so each keeps its own `if (!resolved)` guard and calls this only after it succeeds. It
// returns EVERY field either caller might want -- cleanup uses branch, apply uses baseSha,
// both use worktreePath/repo/workerLive -- and each picks what it needs. Liveness deps
// (isStale, pidAlive, now) are injected so the per-kind rules are unit-testable without the
// handler. A one-shot / foreground non-loop run has no managed worktree: all fields
// undefined, workerLive false.
export function resolveRunWorkspace(
	resolved: ResolvedRun,
	deps: {
		isStale: (job: JobRecord, now: number) => boolean;
		pidAlive: (pid: number | undefined) => boolean;
		now: number;
	},
): {
	worktreePath?: string;
	branch?: string;
	baseSha?: string;
	repo?: string;
	callerCheckout?: string;
	workerLive: boolean;
} {
	if (resolved.mode === "background") {
		const job = resolved.job;
		// A worker is live unless we can prove it is gone. Per state:
		//   queued  -> the worker is spawning into the worktree (it has no pid yet); live
		//              UNLESS stale-queued (the spawn never produced a pid within the window).
		//   running -> live iff the process is actually alive. Do NOT trust isStale here: a
		//              wedged worker with an old heartbeat but a live pid is "stale" yet still
		//              in the worktree -- removing it would corrupt the run.
		//   completed/failed/cancelled -> terminal, safe.
		let workerLive = false;
		if (job.state === "queued") workerLive = !deps.isStale(job, deps.now);
		else if (job.state === "running") workerLive = deps.pidAlive(job.pid);
		return {
			worktreePath: job.worktreePath,
			branch: job.branch,
			baseSha: job.baseSha,
			repo: job.repo,
			callerCheckout: job.callerCheckout,
			workerLive,
		};
	}
	if (resolved.run.kind === "loop") {
		const session = resolved.run.session;
		return {
			worktreePath: session.worktreePath,
			branch: session.branch,
			baseSha: session.baseSha,
			repo: session.repo,
			callerCheckout: session.callerCheckout,
			workerLive: session.terminalStatus === undefined || session.active !== undefined,
		};
	}
	// one-shot / foreground non-loop: no managed worktree to protect, nothing live to guard.
	return { workerLive: false };
}

// Open a run: the single public entry point. The manifest's policy decides the
// kind (one-shot DAG vs converge loop); `mode` decides where it runs. `task` (no
// manifest) converges on a slice with the built-in loop manifest.
server.registerTool(
	"chit_start",
	{
		description:
			"Open a run and return its run_id. Pass `task` to converge on a slice with the built-in loop (a write-capable implementer plus a read-only reviewer), or `manifest_path` to run a specific manifest whose policy decides one-shot (a single DAG pass) vs loop (converge). mode foreground (default) supervises the run in this session: advance with chit_next, inspect with chit_status / chit_trace, stop with chit_cancel. mode background hands it to a detached worker that drives it to completion and survives a reconnect: chit_wait blocks until it finishes (don't poll), chit_status for a snapshot, chit_cancel to stop. For SEVERAL tasks in parallel, use chit_batch_start (it isolates each in its own git worktree).",
		inputSchema: {
			task: z
				.string()
				.optional()
				.describe(
					"A slice to converge on, using the built-in loop manifest. A loop run requires it; omit when manifest_path names a one-shot manifest.",
				),
			manifest_path: z
				.string()
				.optional()
				.describe(
					"Path to a manifest .json (absolute or relative to cwd). Its policy decides one-shot vs loop. Omit to converge on `task` with the built-in loop.",
				),
			mode: z
				.enum(["foreground", "background"])
				.default("foreground")
				.describe(
					"foreground: this session supervises the run (advance with chit_next). background: a detached worker drives it to completion (chit_wait blocks until it finishes; chit_status for a snapshot).",
				),
			scope: z
				.string()
				.optional()
				.describe(
					"Session scope id. Required for a loop run (both agents keep their thread across iterations) and for any per_scope manifest.",
				),
			cwd: z.string().optional().describe("Repo / working dir (defaults to the server cwd)."),
			inputs: z
				.record(z.string(), z.string())
				.default({})
				.describe("Manifest inputs as string key/value pairs (one-shot runs)."),
			audit: z
				.boolean()
				.default(false)
				.describe(
					"Persist a full audit transcript (prompts/outputs/usage as blobs). Off by default: blobs can contain secrets.",
				),
			max_iterations: z
				.number()
				.int()
				.min(1)
				.default(3)
				.describe("Loop iteration budget (loop runs only). Default 3."),
			allow_unenforced_permissions: z
				.boolean()
				.default(false)
				.describe(
					"Run even when a declared permission cannot be enforced (emits warnings). Default off: such a manifest is refused.",
				),
			required_checks: z
				.array(requiredCheckInputSchema)
				.optional()
				.describe(
					"Verification commands chit runs ITSELF after a `proceed` review (loop runs only): each {command, args?, name?, timeoutMs?}, spawned as argv with no shell. Ground truth that overrides the reviewer's self-report -- the loop converges only when they pass, fails one -> revise, blocked -> needs-decision. Replaces (never merges) the manifest's requiredChecks for this run, so a default-loop `task` run gets real verification without a custom manifest. Rejected for a one-shot run.",
				),
			in_place: z
				.boolean()
				.default(false)
				.describe(
					"DANGER, advanced opt-out. By default a loop run is ISOLATED in a chit-managed worktree (chit-run/<run_id>/<scope>) cut clean off HEAD, so its diff is attributable and a dirty caller checkout never pollutes the review or the reviewer. Set true ONLY when you intentionally want the edits applied to the CURRENT checkout -- a dirty caller tree is then mixed into the run's diff. Ignored for one-shot runs.",
				),
			call_timeout_ms: z
				.number()
				.int()
				.positive()
				.optional()
				.describe(
					"Hard per-call timeout in ms for BOTH the implementer and the reviewer (loop runs only). Raise it when a slice's implement step legitimately needs longer than the 15-min default and is being killed mid-work; lower it to fail fast. Overrides the agents' configured callTimeoutMs for this run only. Rejected for a one-shot run.",
				),
		},
	},
	async ({
		task,
		manifest_path,
		mode,
		scope,
		cwd,
		inputs,
		audit,
		max_iterations,
		allow_unenforced_permissions,
		required_checks,
		in_place,
		call_timeout_ms,
	}) => {
		if (!task && !manifest_path) {
			return errorResult("provide `task` (to converge with the built-in loop) or `manifest_path`");
		}
		const runCwd = resolve(cwd ?? process.cwd());
		// Read the manifest once to learn its policy; task-form uses the built-in loop
		// manifest. Resolve a relative manifest_path against the CALLER cwd (runCwd) -- the
		// manifest defines the run and is read from where the user pointed, NOT from a
		// managed worktree (which is cut off HEAD and may lack an untracked manifest). Both
		// foreground (reuses raw) and background (gets this absolute path) read the same file.
		let raw: unknown;
		let manifestAbs: string | undefined;
		if (manifest_path) {
			manifestAbs = resolveManifestPathAbsolute(manifest_path, runCwd);
			try {
				raw = JSON.parse(readFileSync(manifestAbs, "utf-8"));
			} catch (e) {
				return errorResult(`could not read manifest at ${manifestAbs}: ${(e as Error).message}`);
			}
		} else {
			raw = DEFAULT_CONVERGE_MANIFEST;
		}
		// Parsed only to read its policy for dispatch. A ManifestSpec is enough (and
		// honest: this is pre-resolution); the foreground paths re-resolve from `raw`
		// and the background launchers re-read from the manifest path.
		let manifest: ManifestSpec;
		try {
			manifest = parseManifest(raw);
		} catch (e) {
			return errorResult(`invalid manifest: ${(e as Error).message}`);
		}

		// Resolve the run's effective verification: the run-level `required_checks`
		// REPLACES the manifest policy's requiredChecks (never merges), and applies only
		// to a loop run -- a one-shot run given checks is rejected, not silently ignored.
		const checksRes = resolveRunRequiredChecks(
			manifest.policy.kind,
			required_checks,
			manifest.policy.kind === "loop" ? manifest.policy.requiredChecks : undefined,
		);
		if (!checksRes.ok) return errorResult(checksRes.error);
		const requiredChecks = checksRes.checks;

		// call_timeout_ms governs the loop's adapter calls; a one-shot run has no
		// implement/review loop to budget. Reject rather than silently ignore it (mirrors
		// required_checks) -- the guard is a shared pure helper so its wording stays single-sourced.
		const callTimeoutErr = rejectCallTimeoutForOneShot(call_timeout_ms, manifest.policy.kind);
		if (callTimeoutErr) return errorResult(callTimeoutErr);

		if (manifest.policy.kind === "loop") {
			if (!task) return errorResult("a loop run needs a `task` to converge on");
			if (scope === undefined) {
				return errorResult(
					"a loop run needs a `scope` (both agents keep their thread across iterations)",
				);
			}
			// Managed worktree (#85): isolate a write-capable loop in a chit-managed worktree
			// cut clean off HEAD so its diff is attributable regardless of caller-tree dirt.
			// planManagedWorkspace enforces the review-required order: config loads first (a
			// config error fails before any worktree, F3a), then a worktree opens only when the
			// loop may write and in_place is off (F1: a provably read-only loop runs in place).
			// The run_id is pre-generated so the worktree (chit-run/<run_id>) and the surfaced
			// run_id match -- it is the jobId (bg) / loopId (fg) below; both run in ws.cwd.
			const runId = crypto.randomUUID();
			let ws: ReturnType<typeof prepareRunWorkspace>;
			try {
				ws = planManagedWorkspace(
					{
						ensureConfig: () => {
							getConfig();
						},
						openWorkspace: (inPlace) =>
							prepareRunWorkspace(realGit, runCwd, { runId, scope, inPlace }),
					},
					{ participants: manifest.participants, inPlace: in_place },
				);
			} catch (e) {
				return errorResult(safeMcpError(e));
			}
			const worktree =
				ws.worktreePath && ws.branch && ws.baseSha && ws.repo && ws.callerCheckout
					? {
							worktreePath: ws.worktreePath,
							branch: ws.branch,
							baseSha: ws.baseSha,
							repo: ws.repo,
							callerCheckout: ws.callerCheckout,
						}
					: undefined;
			if (mode === "background") {
				const r = launchConvergeJob({
					task,
					scope,
					runId,
					cwd: ws.cwd,
					...(worktree && { worktree }),
					// Absolute, resolved against the caller cwd (F2): bg must read the SAME manifest
					// file as fg, not re-resolve a relative path against the worktree.
					...(manifestAbs !== undefined && { manifestPath: manifestAbs }),
					maxIterations: max_iterations,
					...(requiredChecks && { requiredChecks }),
					...(call_timeout_ms !== undefined && { callTimeoutMs: call_timeout_ms }),
					allowUnenforced: allow_unenforced_permissions,
				});
				if (!r.ok) {
					ws.cleanup?.(); // launch failed: retire the worktree we just created (nothing ran in it)
					return errorResult(r.error);
				}
				const resolved = runController.resolve(r.jobId, Date.now());
				if (!resolved) return errorResult(`run ${r.jobId} vanished after launch`);
				return jsonResult({
					...unifiedRunView(resolved),
					...(r.warnings.length > 0 && { warnings: r.warnings }),
				});
			}
			runController.sweepLoops(Date.now());
			const prep = prepareConvergeExecute(
				raw,
				getConfig().registry,
				scope,
				ws.cwd, // agents implement/review IN the managed worktree (== runCwd when in_place)
				allow_unenforced_permissions,
				getConfig().roles,
				call_timeout_ms, // per-run override -> applied to every participant's adapter
			);
			if (!prep.ok) {
				ws.cleanup?.(); // setup failed before the loop opened: retire the empty worktree
				return errorResult(prep.error);
			}
			let session: ReturnType<typeof startConvergeSession>;
			try {
				session = startConvergeSession({
					cwd: ws.cwd,
					loopId: runId,
					...(worktree && { worktree }),
					scope,
					task,
					maxIterations: max_iterations,
					force: false,
					execute: prep.execute,
					// Run-level required_checks replace the manifest's for this run.
					loopSteps: { ...prep.loopSteps, ...(requiredChecks && { requiredChecks }) },
					...(call_timeout_ms !== undefined && { callTimeoutMs: call_timeout_ms }),
				});
			} catch (e) {
				ws.cleanup?.(); // the loop never opened: retire the empty worktree
				return errorResult(safeMcpError(e));
			}
			runController.registerLoop(session, Date.now());
			return jsonResult({
				...loopRunView(session),
				...(prep.warnings.length > 0 && { warnings: prep.warnings }),
			});
		}

		// One-shot: a single DAG pass over a manifest. It takes inputs, not a task,
		// and is never the task-form (the built-in default manifest is a loop).
		if (task) {
			return errorResult("a one-shot manifest does not take a `task`; pass `inputs` instead");
		}
		if (!manifest_path) return errorResult("a one-shot run needs a `manifest_path`");
		if (mode === "background") {
			const r = launchOneShotJob({
				manifestPath: manifest_path,
				...(scope !== undefined && { scope }),
				cwd: runCwd,
				inputs,
				audit,
				allowUnenforced: allow_unenforced_permissions,
			});
			if (!r.ok) return errorResult(r.error);
			const resolved = runController.resolve(r.jobId, Date.now());
			if (!resolved) return errorResult(`run ${r.jobId} vanished after launch`);
			return jsonResult({
				...unifiedRunView(resolved),
				...(r.warnings.length > 0 && { warnings: r.warnings }),
			});
		}
		runController.sweepOneShot(Date.now());
		let run: Run;
		try {
			run = startRun(crypto.randomUUID(), {
				rawManifest: raw,
				inputs,
				registry: getConfig().registry,
				roles: getConfig().roles,
				...(scope !== undefined && { scope }),
				invocationCwd: runCwd,
				allowUnenforcedPermissions: allow_unenforced_permissions,
				audit,
			});
		} catch (e) {
			return errorResult(safeMcpError(e));
		}
		runController.registerOneShot(run, Date.now());
		return jsonResult(oneShotRunView(run));
	},
);

// Advance a run by ONE unit and return control. One-shot: run the ready wave (or a
// single step); loop: one iteration. Never drains by surprise.
server.registerTool(
	"chit_next",
	{
		description:
			"Advance a run by ONE unit and return control (never drains). A one-shot run runs the currently-ready WAVE -- every step whose dependencies are met -- or a single `step_id` if given; when nothing is ready the run is complete. A loop run runs one implement->review iteration. Pressing Esc (or chit_cancel) cancels the in-flight unit and settles it cleanly. Inputs: run_id, optional step_id (one-shot only). To drive a run to completion, call chit_next until it reports complete, or start it with mode background.",
		inputSchema: {
			run_id: z.string().describe("A run id (from chit_start)"),
			step_id: z
				.string()
				.optional()
				.describe(
					"One-shot runs only: advance just this ready step instead of the whole ready wave.",
				),
		},
	},
	async ({ run_id, step_id }, extra) => {
		const now = Date.now();
		let progress = 0;
		const progressToken = extra._meta?.progressToken;
		const heartbeat = (message: string) => {
			progress++;
			if (progressToken !== undefined) {
				void extra
					.sendNotification({
						method: "notifications/progress",
						params: { progressToken, progress, message },
					})
					.catch(() => {});
			}
			void server
				.sendLoggingMessage({ level: "info", data: message, logger: "chit" })
				.catch(() => {});
		};

		// One-shot: run the currently-ready wave (or a single step). The steps in a
		// ready wave have no dependency on each other, so they run concurrently (as
		// executeManifest does per level); each gets its own controller (keyed
		// run_id:step in `controllers`) with the client's Esc folded in, so chit_cancel
		// and Esc can reach an in-flight step.
		const run = runController.getOneShot(run_id, now);
		if (run) {
			if (isComplete(run)) {
				return jsonResult({ ...oneShotRunView(run), note: "run already complete" });
			}
			const ready = readySteps(run);
			if (step_id !== undefined && !ready.includes(step_id)) {
				return errorResult(`step "${step_id}" is not ready (ready: ${ready.join(", ") || "none"})`);
			}
			const wave = step_id !== undefined ? [step_id] : ready;
			if (wave.length === 0) return jsonResult(oneShotRunView(run));
			try {
				const ran = await Promise.all(
					wave.map(async (sid) => {
						const controller = new AbortController();
						extra.signal.addEventListener("abort", () => controller.abort(), { once: true });
						heartbeat(`${sid} · starting`);
						try {
							const rec = await runStep(run, sid, heartbeat, controller, controllers);
							heartbeat(`${sid} · done in ${rec.durationMs}ms`);
							return { step: sid, durationMs: rec.durationMs, output: rec.output };
						} catch (e) {
							const r = run.records[sid];
							if (r?.status === "cancelled") {
								return { step: sid, cancelled: true as const, durationMs: r.durationMs };
							}
							return { step: sid, error: (e as Error).message };
						}
					}),
				);
				return jsonResult({ ran, ...oneShotRunView(run) });
			} finally {
				// Refresh the idle timer after the wave settles (a multi-minute step's
				// touch-on-lookup is stale), so a concurrent start sweep does not evict it.
				runController.touchOneShot(run_id, now);
			}
		}

		// Loop: run exactly one implement->review iteration. Hold the per-loop lock
		// for the iteration so a background worker on the same loop cannot advance it
		// concurrently (one advancer per loop).
		const session = runController.getLoop(run_id, now);
		if (session) {
			let loopLock: ReturnType<typeof acquireLock>;
			try {
				loopLock = acquireLock(jobStore.loopLockPath(run_id), { retryMs: 50, maxAttempts: 4 });
			} catch (e) {
				if (e instanceof LockError) {
					return errorResult(
						`run "${run_id}" is being advanced by a background job; stop it with chit_cancel or wait, then retry`,
					);
				}
				// A non-lock failure acquiring the lock is a storage/fs error: sanitize
				// it rather than throwing a raw store error past the handler.
				return errorResult(safeMcpError(e));
			}
			const n = session.iteration + 1;
			heartbeat(`${run_id} · iteration ${n} · starting`);
			try {
				const result = await runNextIteration(session, {
					signal: extra.signal,
					onTrace: (e) => {
						const phase = phaseOfStepStart(e, session.implementStep, session.reviewStep);
						if (phase) heartbeat(`${run_id} · iteration ${n} · ${phase}`);
					},
					onChecksStart: () => heartbeat(`${run_id} · iteration ${n} · running required checks`),
				});
				if (result.kind === "cancelled") {
					heartbeat(`${run_id} · iteration ${result.iteration} · cancelled`);
					return jsonResult({
						cancelled: true,
						iteration: result.iteration,
						...loopRunView(session),
						// A compact summary of the round THIS call ran, so an agent auditing the
						// call reads its outcome from the RETURNED data even if no live heartbeat
						// reached it. Placed after the spread so it wins over loopRunView's
						// statusLine (which summarizes the last COMPLETED round, not this one),
						// keeping chit_next's returned statusLine unchanged. See loopStatusLine.
						statusLine: loopStatusLine(result, session),
					});
				}
				if (result.kind === "failed") {
					heartbeat(`${run_id} · iteration ${result.iteration} · failed`);
					return jsonResult({
						failed: true,
						iteration: result.iteration,
						failure: result.failure,
						...loopRunView(session),
						// After the spread: this call's round wins over loopRunView's last-completed line.
						statusLine: loopStatusLine(result, session),
					});
				}
				heartbeat(
					`${run_id} · iteration ${result.iteration} · ${result.verdict}${
						result.stopStatus ? ` · ${result.stopStatus}` : ""
					}`,
				);
				return jsonResult({
					iteration: result.iteration,
					verdict: result.verdict,
					decision: result.decision,
					findingCount: result.findingCount,
					checksRun: result.checksRun,
					checks: result.checks,
					changedFiles: result.changedFiles,
					workspaceWarnings: result.workspaceWarnings,
					...(result.usage && { usage: result.usage }),
					...(result.auditRunId && { auditRef: result.auditRunId }),
					...(result.stopStatus && { stopStatus: result.stopStatus }),
					...loopRunView(session),
					// After the spread for the same reason as the other arms; for a completed
					// round this equals loopRunView's statusLine, so it is unchanged either way.
					statusLine: loopStatusLine(result, session),
				});
			} catch (e) {
				return errorResult(safeMcpError(e));
			} finally {
				releaseLock(loopLock);
				runController.touchLoop(run_id, now);
			}
		}

		return errorResult(`unknown run_id ${run_id}`);
	},
);

// Present loop-log records for a trace under run_id only: the header record carries
// the internal loop-log key (loopId) and state-dir hash (repoKey), neither a public
// handle; iteration and stop records carry no ids. run_id is the top-level handle.
export function publicLoopRecords(records: LoopRecord[]): unknown[] {
	return records.map((r) => {
		if (r.type === "loop") {
			const { loopId: _loopId, repoKey: _repoKey, ...rest } = r;
			void _loopId;
			void _repoKey;
			return rest;
		}
		return r;
	});
}

// A closed-session foreground run recovered from its durable loop log (#100): the run is gone
// from server memory, but the log survives. `workspace` is the run's managed-worktree metadata,
// recovered from the header when present (loops written by 0.23+) or DERIVED for older logs (the
// header's `repo` is the worktree path for a managed run; branch + main repo come from git while
// the worktree dir still exists). `stopped` gates cleanup (only a terminal run is cleanable).
export interface ArchivedForegroundLoop {
	found: FoundLoop;
	stopped: boolean;
	// callerCheckout = the checkout the run was LAUNCHED from, recorded only in 0.23+ headers.
	// chit_apply defaults its target to it; chit_cleanup ignores it (it anchors on mainRepo).
	workspace?: {
		worktreePath: string;
		branch: string;
		baseSha?: string;
		mainRepo: string;
		callerCheckout?: string;
	};
}

export function resolveArchivedForegroundLoop(runId: string): ArchivedForegroundLoop | undefined {
	const found = findLoopByRunId(runId);
	if (!found) return undefined;
	const h = found.header;
	const stopped = found.stop !== undefined;
	// Future logs (0.23+) carry the workspace metadata directly.
	if (h.worktreePath && h.branch && h.mainRepo) {
		return {
			found,
			stopped,
			workspace: {
				worktreePath: h.worktreePath,
				branch: h.branch,
				...(h.baseSha && { baseSha: h.baseSha }),
				mainRepo: h.mainRepo,
				// Surfaced so chit_apply can default its target to the launching checkout. Older
				// (git-derived) logs below have no callerCheckout; apply then needs an explicit target_cwd.
				...(h.callerCheckout && { callerCheckout: h.callerCheckout }),
			},
		};
	}
	// Older logs: the header's `repo` is the worktree toplevel for a managed run. Derive branch +
	// main repo from git, but only while the worktree dir still exists. If it is gone (or this was
	// an in_place run with no separate worktree), there is no recoverable worktree -> no workspace.
	const worktreePath = h.repo;
	if (!existsSync(worktreePath)) return { found, stopped };
	const br = realGit(["rev-parse", "--abbrev-ref", "HEAD"], worktreePath);
	// The branch must be THIS run's managed branch: runWorktree(runId, scope) cuts
	// `chit-run/<runId>/<scope>`, and the log's loopId IS the runId, so the branch must start with
	// `chit-run/<runId>/`. Checking the bare `chit-run/` prefix is NOT enough -- a user's own
	// chit-run/ branch (or another run's) checked out at this path could be misidentified and its
	// branch deleted. Binding to <runId> makes a false positive impossible.
	const branch = br.code === 0 ? br.stdout.trim() : "";
	if (!branch.startsWith(`chit-run/${h.loopId}/`)) return { found, stopped };
	let mainRepo: string;
	try {
		mainRepo = mainRepoOfWorktree(realGit, worktreePath);
	} catch {
		return { found, stopped };
	}
	return { found, stopped, workspace: { worktreePath, branch, mainRepo } };
}

// How a closed-session (archived) foreground run applies. Extracted as a pure decision so the
// terminal/workspace/baseSha/target rules are unit-testable -- the chit_apply handler is a
// server-internal closure that tests cannot invoke. Mirrors chit_cleanup's archived branch, but
// apply needs the base sha (to reconstruct the diff) and the target checkout (where to land it):
//   - not stopped        -> refuse: an interrupted run's diff is not final, so applying it is unsafe.
//   - no workspace       -> no-op: it ran in_place, or its worktree is gone; nothing to apply.
//   - no baseSha         -> refuse: a pre-0.23 log can't reconstruct the run's diff for apply.
//   - no target          -> refuse: no recorded callerCheckout and no target_cwd; ask for target_cwd.
// resolvedTargetCwd is the already-resolved absolute target_cwd (or undefined) so this stays fs-free.
export type ArchivedApplyPlan =
	| { kind: "apply"; worktreePath: string; baseSha: string; target: string }
	| { kind: "noop"; note: string }
	| { kind: "refuse"; error: string };

export function planArchivedApply(
	archived: ArchivedForegroundLoop,
	runId: string,
	resolvedTargetCwd: string | undefined,
): ArchivedApplyPlan {
	if (!archived.stopped) {
		return {
			kind: "refuse",
			error: `run ${JSON.stringify(runId)} is an archived run that never recorded a terminal stop; not safe to apply (it may have been interrupted). Inspect it with chit_trace.`,
		};
	}
	if (!archived.workspace) {
		return {
			kind: "noop",
			note: "this archived run has no recoverable managed worktree (it ran in_place, or its worktree dir is already gone); nothing to apply.",
		};
	}
	const { worktreePath, baseSha, callerCheckout } = archived.workspace;
	if (!baseSha) {
		return {
			kind: "refuse",
			error: `run ${JSON.stringify(runId)} predates base-sha tracking in its loop log (pre-0.23); its diff cannot be reconstructed for apply. Apply the worktree diff at ${JSON.stringify(worktreePath)} manually.`,
		};
	}
	const target = resolvedTargetCwd ?? callerCheckout;
	if (!target) {
		return {
			kind: "refuse",
			error: `run ${JSON.stringify(runId)} did not record the checkout it was launched from; pass target_cwd to say where to apply.`,
		};
	}
	return { kind: "apply", worktreePath, baseSha, target };
}

// The history of any run: a one-shot's step transcript, or a loop/background
// run's durable loop log. Read-only.
server.registerTool(
	"chit_trace",
	{
		description:
			"The history of a run: a one-shot run's step transcript, or a loop/background run's iteration log (each iteration's summary, changed files, verdict, verification and the reviewer's checks, usage, and audit ref). Read-only. Inputs: run_id.",
		inputSchema: {
			run_id: z.string().describe("A run id (from chit_start)"),
		},
	},
	async ({ run_id }) => {
		const resolved = runController.resolve(run_id, Date.now());
		if (!resolved) {
			// Not in memory / not a durable job: a foreground run from a CLOSED session may still
			// have its durable loop log (#100). Recover its history read-only.
			let archived: ArchivedForegroundLoop | undefined;
			try {
				archived = resolveArchivedForegroundLoop(run_id);
			} catch (e) {
				return errorResult(safeMcpError(e));
			}
			if (!archived) return errorResult(`unknown run_id ${run_id}`);
			return jsonResult({
				run_id,
				mode: "archived_foreground" as const,
				execution: "loop" as const,
				active: false,
				...(archived.workspace && workspaceView(archived.workspace)),
				records: publicLoopRecords(archived.found.records),
			});
		}
		if (resolved.mode === "background") {
			const job = resolved.job;
			if (job.policy === "loop") {
				let records: unknown[] = [];
				try {
					records = publicLoopRecords(readLoop(job.cwd, job.loopId));
				} catch {
					// loop log not readable yet (worker still starting) or removed
				}
				return jsonResult({
					run_id,
					execution: "job",
					policy: "loop",
					...workspaceView(job),
					records,
				});
			}
			// A one-shot background run has no loop log; its history is the audit run.
			return jsonResult({
				run_id,
				execution: "job",
				policy: "one-shot",
				auditRefs: job.auditRefs,
				note: job.auditRefs.length
					? `chit_audit_show { audit_ref: "${job.auditRefs.at(-1)}" } for the transcript`
					: "no audit transcript recorded",
			});
		}
		if (resolved.run.kind === "loop") {
			const session = resolved.run.session;
			try {
				// Re-present the converge trace under run_id, dropping the internal loopId
				// the engine view carries and sanitizing the loop-log records.
				const t = traceConverge(session);
				return jsonResult({
					run_id,
					execution: "loop",
					status: t.status,
					active: t.active,
					...workspaceView(session),
					auditRefs: t.auditRefs,
					records: publicLoopRecords(t.records),
				});
			} catch (e) {
				return errorResult(safeMcpError(e));
			}
		}
		const run = resolved.run.run;
		const trace = run.manifest.executionOrder.flat().map((id) => {
			const r = run.records[id];
			return {
				step: id,
				kind: r?.kind,
				participant: r?.participantId,
				agent: r?.agentId,
				status: r?.status,
				durationMs: r?.durationMs,
				output: r?.output,
				error: r?.error,
			};
		});
		return jsonResult({ run_id, execution: "one-shot", complete: isComplete(run), trace });
	},
);

// Cancel any run by run_id: a foreground one-shot's running step(s), a foreground
// loop's in-flight iteration, or a background run's worker (intent-first).
server.registerTool(
	"chit_cancel",
	{
		description:
			"Cancel a run by run_id, whether foreground or background. A foreground run's running step(s) or in-flight iteration abort and settle cancelled; a background run records the cancel intent (surviving a worker restart) then signals its worker, which stops at the next safe point. A run that already finished is reported back unchanged. Inputs: run_id.",
		inputSchema: {
			run_id: z.string().describe("A run id (from chit_start)"),
		},
	},
	async ({ run_id }) => {
		const now = Date.now();
		const resolved = runController.resolve(run_id, now);
		if (!resolved) return errorResult(`unknown run_id ${run_id}`);
		if (resolved.mode === "background") {
			let r: ReturnType<typeof requestJobCancel>;
			try {
				r = requestJobCancel(run_id);
			} catch (e) {
				return errorResult(safeMcpError(e));
			}
			if (r.status === "terminal") {
				return jsonResult({ run_id, cancelled: false, note: `run already ${r.state}` });
			}
			return jsonResult({
				run_id,
				cancelRequested: true,
				signaled: r.status === "requested" && r.signaled,
				note: "cancellation requested; the worker stops at the next safe point and records a clean cancelled stop",
			});
		}
		if (resolved.run.kind === "loop") {
			// Cancelling an idle loop writes a stop record (stopLoop), which can throw a
			// LoopStoreError carrying the loop-log path; sanitize rather than leak it.
			let cancel: ReturnType<typeof cancelConverge>;
			try {
				// One `now` for the cancelling mark AND the returned view: cancelConverge stamps
				// the in-flight snapshot at `now` and loopRunView subtracts from the same `now`,
				// so the surfaced activity ages can never be negative (the abort itself settles
				// in the OTHER chit_next request; the snapshot is still set here).
				cancel = cancelConverge(resolved.run.session, now);
			} catch (e) {
				return errorResult(safeMcpError(e));
			}
			return jsonResult({ run_id, cancel, run: loopRunView(resolved.run.session, now) });
		}
		// one-shot: abort every currently-running step (a wave may have several).
		const run = resolved.run.run;
		const running = Object.values(run.records)
			.filter((r) => r.status === "running")
			.map((r) => r.stepId);
		for (const stepId of running) cancelStep(run, stepId, controllers);
		return jsonResult({
			run_id,
			cancelled: running.length > 0,
			cancelledSteps: running,
			run: oneShotRunView(run),
		});
	},
);

// Retire a finished run's managed worktree by run_id. The single-run analog of
// chit_batch_cleanup: dry-run-default, terminal-only, receipts always kept, keyed by
// run_id ONLY (no path input -- agents never pass arbitrary filesystem paths).
server.registerTool(
	"chit_cleanup",
	{
		description:
			"Retire a FINISHED run's chit-managed worktree + branch, by run_id. DRY RUN by default (reports what it would remove, removes nothing); pass confirm=true to actually remove. Refuses while the run is still active (an in-flight foreground iteration or a live background worker) -- chit_cancel it and let it settle first. NEVER deletes receipts: the loop log + audit survive, so chit_trace / chit_audit_show still work afterward. A run that executed in_place (or a one-shot, which is never isolated) has no managed worktree -- a no-op. Keyed by run_id only (no path input). Recovers a FOREGROUND run from a CLOSED session via its durable loop log (it must have reached a terminal stop); only if the log was pruned is manual `git worktree remove` / `git branch -D` needed.",
		inputSchema: {
			run_id: z.string().describe("A run id (from chit_start)"),
			confirm: z
				.boolean()
				.default(false)
				.describe(
					"Remove the worktree + branch. Default false = dry run: report what would be removed, remove nothing.",
				),
		},
	},
	async ({ run_id, confirm }) => {
		const resolved = runController.resolve(run_id, Date.now());
		if (!resolved) {
			// Not in memory / not a durable job: a foreground run from a CLOSED session may still be
			// cleanable from its durable loop log (#100). Recover it, require a terminal stop, and run
			// the same cleanup. No path input -- the worktree/branch/repo come only from the log/git.
			let archived: ArchivedForegroundLoop | undefined;
			try {
				archived = resolveArchivedForegroundLoop(run_id);
			} catch (e) {
				return errorResult(safeMcpError(e));
			}
			if (!archived) {
				return errorResult(
					`run_id ${JSON.stringify(run_id)} is not resolvable by this server and has no recoverable loop log. If it was a foreground run from a closed session whose log was pruned, remove its worktree manually.`,
				);
			}
			if (!archived.stopped) {
				return errorResult(
					`run ${JSON.stringify(run_id)} is an archived run that never recorded a terminal stop; not safe to clean (it may have been interrupted). Inspect it with chit_trace.`,
				);
			}
			if (!archived.workspace) {
				return jsonResult({
					run_id,
					confirmed: confirm,
					receiptsKept: true,
					note: "this archived run has no recoverable managed worktree (it ran in_place, or its worktree dir is already gone); nothing to clean.",
				});
			}
			const { worktreePath, branch, mainRepo } = archived.workspace;
			const result = cleanupRunWorkspace(realGit, {
				repo: mainRepo,
				worktreePath,
				branch,
				confirm,
			});
			return jsonResult({ run_id, recovered: "archived_foreground" as const, ...result });
		}
		// The run's managed worktree (if any) + whether its worker is still live, per kind --
		// resolved by the shared helper. cleanup uses worktreePath/branch/repo/workerLive.
		const {
			worktreePath,
			branch,
			repo: storedRepo,
			workerLive,
		} = resolveRunWorkspace(resolved, {
			isStale,
			pidAlive,
			now: Date.now(),
		});
		// No managed worktree (a one-shot or an in_place run) -> nothing to clean, regardless of
		// state. Report a no-op, never an error (a one-shot has no worktree to protect).
		if (!worktreePath || !branch) {
			return jsonResult({
				run_id,
				confirmed: confirm,
				receiptsKept: true,
				note: "this run has no chit-managed worktree (a one-shot or in_place run); nothing to clean.",
			});
		}
		// There IS a worktree: refuse while the run is still live (an in-flight iteration or a
		// live background worker) -- cancel + settle first.
		if (workerLive) {
			return errorResult(
				`run ${JSON.stringify(run_id)} is still active; chit_cancel it and wait for it to settle before cleaning up.`,
			);
		}
		// The MAIN repo cleanup runs git from (never the worktree being removed). New runs RECORD
		// it, so cleanup works even after the worktree dir is gone -- removeTaskWorktree then prunes
		// and still removes the branch, so a partial state (worktree gone, branch left) is fully
		// cleaned and a re-run is idempotent. A pre-0.20.0 record may lack repo: fall back to
		// deriving it from the worktree, which only works while the worktree still exists.
		let repo = storedRepo;
		if (!repo) {
			if (!existsSync(worktreePath)) {
				return errorResult(
					`run ${JSON.stringify(run_id)} predates worktree-repo tracking and its worktree is already gone; remove its branch manually with \`git branch -D ${branch}\` from your repo.`,
				);
			}
			try {
				repo = mainRepoOfWorktree(realGit, worktreePath);
			} catch (e) {
				return errorResult(safeMcpError(e));
			}
		}
		const result = cleanupRunWorkspace(realGit, { repo, worktreePath, branch, confirm });
		return jsonResult({ run_id, ...result });
	},
);

// Apply a finished run's diff back to a working checkout, by run_id. The single-run bridge
// from "the agents did the work in a managed worktree" to "it's in my checkout", honoring
// "never overwrite user changes silently": the tracked patch is gated by git apply --check
// --3way and refused on conflict; untracked files are applied ONLY when named and never
// overwrite a differing target. Dry-run-default, terminal-only, NO cleanup coupling.
server.registerTool(
	"chit_apply",
	{
		description:
			"Apply a FINISHED run's changes from its chit-managed worktree back into a working checkout, by run_id. DRY RUN by default: reports the tracked files, whether they apply cleanly, and the untracked candidates -- applies NOTHING. Pass confirm=true to apply. Tracked changes apply via git's own 3-way check and are REFUSED (nothing applied) if they conflict with the target's current state -- never an overwrite of your edits. Untracked files (new files the run created) are applied ONLY when named in include_untracked, and a name that would overwrite a different existing target file is refused too. Refuses while the run is still active. Does NOT clean up the worktree (run chit_cleanup separately when done) and never deletes receipts. Applied tracked changes land STAGED (git apply --3way), copied untracked files land unstaged. Target defaults to the checkout you LAUNCHED the run from; pass target_cwd to apply elsewhere. Recovers a FOREGROUND run from a CLOSED session via its durable loop log (it must have reached a terminal stop and recorded its worktree base; a 0.23+ log also records the launching checkout, otherwise pass target_cwd). A one-shot / in_place run has no managed worktree to apply.",
		inputSchema: {
			run_id: z.string().describe("A run id (from chit_start)"),
			confirm: z
				.boolean()
				.default(false)
				.describe(
					"Apply the changes. Default false = dry run: report what would apply (and whether it applies cleanly), apply nothing.",
				),
			include_untracked: z
				.array(z.string())
				.default([])
				.describe(
					"Untracked files (from the dry run's `untracked` list) to also copy into the target. Default none. A listed file that would overwrite a DIFFERENT existing target file is refused (the whole apply is refused, atomic).",
				),
			target_cwd: z
				.string()
				.optional()
				.describe(
					"Where to apply (defaults to the checkout you launched the run from -- the usual case). Pass a path only to apply into a different checkout.",
				),
		},
	},
	async ({ run_id, confirm, include_untracked, target_cwd }) => {
		const resolved = runController.resolve(run_id, Date.now());
		if (!resolved) {
			// Not in memory / not a durable job: a foreground run from a CLOSED session may still be
			// applicable from its durable loop log (#100), exactly like chit_trace / chit_cleanup. Recover
			// it, then run the SAME apply machinery -- planArchivedApply enforces terminal + base-sha +
			// target, defaulting the target to the recorded launching checkout.
			let archived: ArchivedForegroundLoop | undefined;
			try {
				archived = resolveArchivedForegroundLoop(run_id);
			} catch (e) {
				return errorResult(safeMcpError(e));
			}
			if (!archived) {
				return errorResult(
					`run_id ${JSON.stringify(run_id)} is not resolvable by this server and has no recoverable loop log. If it was a foreground run from a closed session whose log was pruned, apply its worktree diff manually.`,
				);
			}
			const plan = planArchivedApply(
				archived,
				run_id,
				target_cwd ? resolve(target_cwd) : undefined,
			);
			if (plan.kind === "refuse") return errorResult(plan.error);
			if (plan.kind === "noop") {
				return jsonResult({ run_id, confirmed: confirm, applied: false, note: plan.note });
			}
			const result = applyRunWorkspace(realGit, {
				worktreePath: plan.worktreePath,
				baseSha: plan.baseSha,
				target: plan.target,
				confirm,
				includeUntracked: include_untracked,
			});
			// Same staged/unstaged disclosure as the live path (the two kinds land differently).
			const applied = result.applied === true;
			return jsonResult({
				run_id,
				recovered: "archived_foreground" as const,
				...result,
				...(applied && {
					trackedState: result.trackedFiles.length > 0 ? "staged" : "none",
					untrackedState: (result.appliedUntracked?.length ?? 0) > 0 ? "unstaged" : "none",
					reviewWith: `cd ${plan.target} && git status${result.trackedFiles.length > 0 ? " && git diff --cached" : ""}${(result.appliedUntracked?.length ?? 0) > 0 ? " && git diff" : ""}`,
				}),
			});
		}
		// The run's managed worktree + base + caller checkout + liveness, per kind -- resolved by the
		// shared helper. apply works from the worktree + baseSha; it defaults its target to the
		// LAUNCHING checkout (where the user is working), NOT the durable main repo (which cleanup
		// uses). storedRepo is the fallback for pre-0.22 records that lack callerCheckout.
		const {
			worktreePath,
			baseSha,
			repo: storedRepo,
			callerCheckout,
			workerLive,
		} = resolveRunWorkspace(resolved, {
			isStale,
			pidAlive,
			now: Date.now(),
		});
		// No managed worktree (a one-shot or an in_place run): nothing to apply -- those edits are
		// already in the caller's checkout. Clear no-op, not a crash.
		if (!worktreePath || !baseSha) {
			return jsonResult({
				run_id,
				confirmed: confirm,
				applied: false,
				note: "this run has no chit-managed worktree (a one-shot or in_place run); its changes, if any, are already in your checkout -- nothing to apply.",
			});
		}
		// Refuse while the run is still live: its diff is still changing.
		if (workerLive) {
			return errorResult(
				`run ${JSON.stringify(run_id)} is still active; let it finish (or chit_cancel it) before applying -- its diff is not final yet.`,
			);
		}
		// Default to the LAUNCHING checkout (where the user ran chit); fall back to the main repo
		// for pre-0.22 records with no recorded callerCheckout. target_cwd overrides either.
		const target = target_cwd ? resolve(target_cwd) : (callerCheckout ?? storedRepo);
		if (!target) {
			return errorResult(
				`run ${JSON.stringify(run_id)} predates repo tracking; pass target_cwd to say where to apply.`,
			);
		}
		const result = applyRunWorkspace(realGit, {
			worktreePath,
			baseSha,
			target,
			confirm,
			includeUntracked: include_untracked,
		});
		// Disclose WHERE the changes landed -- git stages the two kinds differently:
		//   tracked patch  -> STAGED (git apply --3way implies --index), seen with git diff --cached
		//   untracked files -> UNSTAGED (a plain cpSync into the work tree), seen with git diff
		// so a mixed apply is partly staged + partly unstaged; tell the operator both, exactly.
		const applied = result.applied === true;
		return jsonResult({
			run_id,
			...result,
			...(applied && {
				trackedState: result.trackedFiles.length > 0 ? "staged" : "none",
				untrackedState: (result.appliedUntracked?.length ?? 0) > 0 ? "unstaged" : "none",
				reviewWith: `cd ${target} && git status${result.trackedFiles.length > 0 ? " && git diff --cached" : ""}${(result.appliedUntracked?.length ?? 0) > 0 ? " && git diff" : ""}`,
			}),
		});
	},
);

// --- batch tools --------------------------------------------------------
//
// A batch is a THIN COORDINATOR over background converge jobs: it plans a task
// graph, creates one worktree per task, and launches a background converge run per
// runnable task. It owns no execution. start launches the first wave; advance
// reconciles finished jobs and launches the next wave; status is READ-ONLY
// (inspection is safe -- never spawns or mutates); cancel stops active jobs. No
// daemon, no auto-merge: the deliverable is reviewable worktree artifacts.

// Engine deps wired to the real job/worktree/loop machinery. allowUnenforced is
// false: both built-in adapters enforce their declared permission (codex via the
// OS sandbox, claude via plan mode), so a built-in-adapter batch never hits an
// enforcement gap; a manifest with an unenforceable permission fails that task
// loudly via launchConvergeJob.
const batchDeps: BatchEngineDeps = {
	git: realGit,
	createWorktree: (repo, cid, tid, sha) => createTaskWorktree(realGit, repo, cid, tid, sha),
	removeWorktree: (repo, worktreePath, branch) =>
		removeTaskWorktree(realGit, repo, worktreePath, branch),
	launchJob: (p) => {
		const r = launchConvergeJob({
			task: p.task,
			scope: p.scope,
			cwd: p.cwd,
			// Forward the task's managed worktree so the job record carries worktreePath/branch/
			// baseSha/repo/callerCheckout -- the same fields a single background run stores, which
			// chit_apply / chit_cleanup read to resolve and apply a batch task's diff.
			worktree: p.worktree,
			...(p.manifestPath !== undefined && { manifestPath: p.manifestPath }),
			maxIterations: p.maxIterations,
			...(p.requiredChecks && { requiredChecks: p.requiredChecks }),
			...(p.callTimeoutMs !== undefined && { callTimeoutMs: p.callTimeoutMs }),
			loopId: p.loopId,
			allowUnenforced: false,
		});
		if (!r.ok) throw new Error(r.error);
		return { jobId: r.jobId, loopId: r.loopId };
	},
	getJob: (id) => jobStore.get(id),
	cancelJob: (id) => {
		requestJobCancel(id);
	},
	isStale: (job) => isStale(job, Date.now()),
	loopDetail: (worktreePath, loopId) => {
		// The worktree's uncommitted state -- so a task that failed mid-step surfaces work no
		// completed iteration captured (read-only; empty for a missing/clean worktree).
		const partialWork = inspectPartialWork(realGit, worktreePath);
		try {
			const iters = readLoop(worktreePath, loopId).filter((r) => r.type === "iteration");
			const last = iters.at(-1);
			if (last && last.type === "iteration") {
				return {
					changedFiles: last.changedFiles,
					workspaceWarnings: last.workspaceWarnings ?? [],
					partialWork,
				};
			}
		} catch {
			// loop log not readable (worker still starting, or removed); no detail
		}
		return { changedFiles: [], workspaceWarnings: [], partialWork };
	},
	now: () => Date.now(),
};

const batchTaskSchema = z.object({
	id: z.string().describe("Unique task id within the batch (a safe slug)"),
	title: z.string().describe("Short task title"),
	body: z.string().describe("The task brief handed to the converge implementer"),
	dependencies: z
		.array(z.string())
		.optional()
		.describe(
			"Task ids that must reach review_ready before this task launches. A launch GATE only: the dependent task still starts from the batch base in its own worktree and does NOT receive its dependencies' changes (no merge). Use it to order work, not to feed one task's output into another.",
		),
	claimedPaths: z
		.array(z.string())
		.optional()
		.describe(
			"Paths this task will touch (globs: dir/**, dir/, or a file). Required unless allowPathOverlap; tasks with overlapping claims never run concurrently.",
		),
	allowPathOverlap: z
		.boolean()
		.optional()
		.describe("Opt-in to running with no/overlapping claims; the task then runs alone."),
	manifestPath: z
		.string()
		.optional()
		.describe(
			"Per-task converge manifest override (absolute or relative to cwd). Omit to use the bundled default (write-capable Claude implementer + read-only Codex reviewer). To swap the pairing (e.g. a Codex implementer + Claude reviewer), point this at your own converge manifest; its participants can be inline, or reference reusable roles defined in ~/.config/chit/config.json.",
		),
	requiredChecks: z
		.array(requiredCheckInputSchema)
		.optional()
		.describe(
			"Per-task chit-executed verification: replaces the batch's required_checks and the manifest's for this task (closest-wins, no merge). Each {command, args?, name?, timeoutMs?}.",
		),
	callTimeoutMs: z
		.number()
		.int()
		.positive()
		.optional()
		.describe(
			"Per-task hard per-call timeout (ms) for the implementer and reviewer; overrides the batch-level call_timeout_ms for this task (closest wins).",
		),
});

function batchError(e: unknown) {
	if (e instanceof PlanError || e instanceof WorktreeError || e instanceof BatchStoreError) {
		return errorResult(e.message);
	}
	return errorResult(safeMcpError(e));
}

server.registerTool(
	"chit_batch_start",
	{
		description:
			"Start a batch: run several converge tasks in parallel, each in its own git worktree, as background jobs. This is the right tool for parallel work; for a single unattended task use chit_start with mode background instead. Plans the task graph, launches the initial runnable wave (no-dependency tasks, up to max_parallel), and returns immediately. Then drive it with chit_wait (it blocks until a job finishes or a task becomes runnable, instead of polling) followed by chit_batch_advance to launch the next wave, repeating until the batch is terminal. No auto-merge: the output is reviewable worktree branches. Each task's worktree branches from the batch base (base_branch); a task's `dependencies` only GATE when it launches (after the deps reach review_ready) and do NOT merge the deps' changes into it, so a task never sees another task's diff. Manifest resolution per task: task.manifestPath > batch manifest_path > the bundled default converge manifest (a write-capable Claude implementer + read-only Codex reviewer). To swap the pairing, point manifestPath at your own converge manifest (participants inline, or referencing reusable roles defined in ~/.config/chit/config.json).",
		inputSchema: {
			tasks: z
				.array(batchTaskSchema)
				.min(1)
				.describe("The task graph (an explicit, reviewed list)"),
			cwd: z
				.string()
				.optional()
				.describe("Any path in the target repo (defaults to the server cwd)"),
			max_parallel: z.number().int().min(1).default(2).describe("Max concurrent tasks. Default 2."),
			base_branch: z.string().optional().describe("Ref task worktrees branch from. Default: HEAD."),
			manifest_path: z
				.string()
				.optional()
				.describe("Batch-level default converge manifest (absolute or relative to cwd)."),
			max_iterations: z
				.number()
				.int()
				.min(1)
				.default(3)
				.describe("Per-task iteration budget. Default 3."),
			required_checks: z
				.array(requiredCheckInputSchema)
				.optional()
				.describe(
					"Batch-level chit-executed verification, applied to every task without its own requiredChecks. A task's requiredChecks override these; the manifest policy's are the fallback. Each {command, args?, name?, timeoutMs?}.",
				),
			call_timeout_ms: z
				.number()
				.int()
				.positive()
				.optional()
				.describe(
					"Batch-level hard per-call timeout (ms) for the implementer and reviewer, applied to every task without its own callTimeoutMs. A task's callTimeoutMs overrides this; agent config / the 15-min default is the fallback.",
				),
		},
	},
	async ({
		tasks,
		cwd,
		max_parallel,
		base_branch,
		manifest_path,
		max_iterations,
		required_checks,
		call_timeout_ms,
	}) => {
		const runCwd = resolve(cwd ?? process.cwd());
		// Resolve manifest paths to absolute against the batch cwd up front, so the
		// per-task worktree never re-resolves a relative path against the wrong base.
		const batchManifest =
			manifest_path !== undefined
				? isAbsolute(manifest_path)
					? manifest_path
					: resolve(runCwd, manifest_path)
				: undefined;
		const planned = tasks.map((t) => ({
			...t,
			...(t.manifestPath !== undefined && {
				manifestPath: isAbsolute(t.manifestPath) ? t.manifestPath : resolve(runCwd, t.manifestPath),
			}),
		}));
		const store = new BatchStore(runCwd);
		try {
			const batch = startBatch(store, batchDeps, {
				id: crypto.randomUUID(),
				cwd: runCwd,
				tasks: planned,
				maxParallel: max_parallel,
				...(base_branch !== undefined && { baseBranch: base_branch }),
				...(batchManifest !== undefined && { manifestPath: batchManifest }),
				maxIterations: max_iterations,
				...(required_checks !== undefined && { requiredChecks: required_checks }),
				...(call_timeout_ms !== undefined && { callTimeoutMs: call_timeout_ms }),
			});
			return jsonResult(describeBatch(batch, batchDeps));
		} catch (e) {
			return batchError(e);
		}
	},
);

server.registerTool(
	"chit_batch_list",
	{
		description:
			"List the batches in this repo, newest first: batch_id, status, task count, how many tasks are review_ready / needs_attention / failed, and whether it has been cleaned up. Use it to recover a batch_id you lost, then chit_batch_status <batch_id> for the full view. Read-only.",
		inputSchema: {
			limit: z
				.number()
				.int()
				.min(1)
				.optional()
				.describe("Return at most this many batches (newest first). Default: all."),
			cwd: z
				.string()
				.optional()
				.describe("Any path in the target repo (defaults to the server cwd)"),
		},
	},
	async ({ limit, cwd }) => {
		try {
			const store = new BatchStore(resolve(cwd ?? process.cwd()));
			return jsonResult({ batches: listBatches(store, limit) });
		} catch (e) {
			return batchError(e);
		}
	},
);

server.registerTool(
	"chit_batch_status",
	{
		description:
			"Read-only batch overview: each task's status, live job state/phase, branch/worktree, changed files, audit refs, plus how many tasks are runnable now and the next action. Inspection is safe: this NEVER launches jobs, creates worktrees, or mutates state (use chit_batch_advance to make progress).",
		inputSchema: {
			batch_id: z.string().describe("The batch id, from chit_batch_start or chit_batch_list"),
			cwd: z
				.string()
				.optional()
				.describe("Any path in the target repo (defaults to the server cwd)"),
		},
	},
	async ({ batch_id, cwd }) => {
		try {
			const store = new BatchStore(resolve(cwd ?? process.cwd()));
			const batch = store.get(batch_id);
			if (!batch) return errorResult(`unknown batch_id ${batch_id}`);
			return jsonResult(describeBatch(batch, batchDeps));
		} catch (e) {
			return batchError(e);
		}
	},
);

server.registerTool(
	"chit_batch_advance",
	{
		description:
			"Advance a batch: reconcile finished jobs into task state (converged -> review_ready; blocked/needs-decision/max-iterations -> needs_attention, i.e. the run completed but did not converge clean and a human decides; a vanished/stale job or a failed run -> failed; dependents proceed only past a review_ready task), then launch the next runnable wave. The only progression trigger besides start. Call it when chit_batch_status reports runnable tasks or a finished job.",
		inputSchema: {
			batch_id: z.string().describe("The batch id, from chit_batch_start or chit_batch_list"),
			cwd: z
				.string()
				.optional()
				.describe("Any path in the target repo (defaults to the server cwd)"),
		},
	},
	async ({ batch_id, cwd }) => {
		const store = new BatchStore(resolve(cwd ?? process.cwd()));
		try {
			const batch = advanceBatch(store, batchDeps, batch_id);
			return jsonResult(describeBatch(batch, batchDeps));
		} catch (e) {
			return batchError(e);
		}
	},
);

server.registerTool(
	"chit_batch_cancel",
	{
		description:
			"Cancel a batch: request cancellation of every active task job (intent-first, the same safety as chit_cancel) and mark pending tasks cancelled. Running jobs settle cleanly in the background. Worktrees are left in place for inspection.",
		inputSchema: {
			batch_id: z.string().describe("The batch id, from chit_batch_start or chit_batch_list"),
			cwd: z
				.string()
				.optional()
				.describe("Any path in the target repo (defaults to the server cwd)"),
		},
	},
	async ({ batch_id, cwd }) => {
		const store = new BatchStore(resolve(cwd ?? process.cwd()));
		try {
			const batch = cancelBatch(store, batchDeps, batch_id);
			return jsonResult(describeBatch(batch, batchDeps));
		} catch (e) {
			return batchError(e);
		}
	},
);

server.registerTool(
	"chit_batch_cleanup",
	{
		description:
			"Retire a batch's worktrees and branches once you are done reviewing them. SAFE BY DEFAULT: with confirm omitted/false it is a DRY RUN that lists which worktrees/branches would be removed and which changed-file diffs that would discard, and removes nothing. With confirm=true it removes them (git worktree remove --force + branch -D). Refuses while any task is still running. NEVER deletes the batch/job/loop/audit receipts -- those stay as durable history.",
		inputSchema: {
			batch_id: z.string().describe("The batch id, from chit_batch_start or chit_batch_list"),
			confirm: z
				.boolean()
				.default(false)
				.describe(
					"false (default) = dry run, report only. true = actually remove worktrees + branches.",
				),
			cwd: z
				.string()
				.optional()
				.describe("Any path in the target repo (defaults to the server cwd)"),
		},
	},
	async ({ batch_id, confirm, cwd }) => {
		const store = new BatchStore(resolve(cwd ?? process.cwd()));
		try {
			return jsonResult(cleanupBatch(store, batchDeps, batch_id, { confirm }));
		} catch (e) {
			return batchError(e);
		}
	},
);

// --- plan tools (sequential plan-runner) ----------------------------------
//
// chit_plan_start / list / status / advance / cancel / cleanup drive an operator-authored,
// reviewed chain of steps where each step's worktree is cut from a base that already
// contains the prior step's APPLIED diff (see docs/sequential-plan-runner-design.md).
// They COMPOSE the existing run/worktree/job machinery via the engine, never replacing
// the batch or single-run tools. chit_plan_advance both reconciles+launches and (with an
// apply payload) runs the gated apply-then-commit that flows a review_ready step into the
// integration branch and advances the tip; chit_plan_cleanup retires the managed worktrees
// once the plan is terminal. No daemon: progress happens only at these explicit calls.

// Engine deps wired to the real worktree/job/loop machinery, modelled one-for-one on
// batchDeps. allowUnenforced is false for the same reason: the built-in adapters enforce
// their declared permission, and a manifest with an unenforceable one fails that step
// loudly via launchConvergeJob.
const planDeps: PlanEngineDeps = {
	git: realGit,
	createIntegrationWorktree: (repo, planId, baseSha) =>
		createPlanIntegrationWorktree(realGit, repo, planId, baseSha),
	createStepWorktree: (repo, planId, stepId, baseSha) =>
		createPlanStepWorktree(realGit, repo, planId, stepId, baseSha),
	launchJob: (p) => {
		const r = launchConvergeJob({
			task: p.task,
			scope: p.scope,
			cwd: p.cwd,
			// Forward the step's managed worktree so the job record carries worktreePath/branch/
			// baseSha/repo/callerCheckout -- the same fields chit_apply reads to resolve a step run.
			worktree: p.worktree,
			...(p.manifestPath !== undefined && { manifestPath: p.manifestPath }),
			maxIterations: p.maxIterations,
			...(p.requiredChecks && { requiredChecks: p.requiredChecks }),
			...(p.callTimeoutMs !== undefined && { callTimeoutMs: p.callTimeoutMs }),
			loopId: p.loopId,
			allowUnenforced: false,
		});
		if (!r.ok) throw new Error(r.error);
		return { jobId: r.jobId, loopId: r.loopId };
	},
	getJob: (id) => jobStore.get(id),
	cancelJob: (id) => {
		requestJobCancel(id);
	},
	isStale: (job) => isStale(job, Date.now()),
	loopDetail: (worktreePath, loopId) => {
		const partialWork = inspectPartialWork(realGit, worktreePath);
		try {
			const iters = readLoop(worktreePath, loopId).filter((r) => r.type === "iteration");
			const last = iters.at(-1);
			if (last && last.type === "iteration") {
				return {
					changedFiles: last.changedFiles,
					workspaceWarnings: last.workspaceWarnings ?? [],
					partialWork,
				};
			}
		} catch {
			// loop log not readable (worker still starting, or removed); no detail
		}
		return { changedFiles: [], workspaceWarnings: [], partialWork };
	},
	// The gated apply + commit + cleanup primitives, wired to real git. applyWorkspace reuses the
	// exact chit_apply machinery (conflict + untracked-overwrite safety); commit turns the applied
	// integration diff into one step commit; removeWorktree retires a managed worktree on cleanup.
	applyWorkspace: (p) =>
		applyRunWorkspace(realGit, {
			worktreePath: p.worktreePath,
			baseSha: p.baseSha,
			target: p.target,
			confirm: p.confirm,
			...(p.includeUntracked !== undefined && { includeUntracked: p.includeUntracked }),
		}),
	commit: (worktreePath, message) => commitWorktree(realGit, worktreePath, message),
	removeWorktree: (repo, worktreePath, branch) =>
		removeTaskWorktree(realGit, repo, worktreePath, branch),
	now: () => Date.now(),
};

// A plan record lives under the DURABLE main repo namespace (not the launching
// checkout), so a plan started from a linked worktree is recoverable after that
// worktree is removed. Resolve the main repo before constructing the store, exactly as
// the engine does internally for the plan record's repo/repoKey.
function planStoreFor(cwd?: string): { store: PlanStore; cwd: string } {
	const runCwd = resolve(cwd ?? process.cwd());
	const repo = mainRepoOfWorktree(realGit, runCwd);
	return { store: new PlanStore(repo), cwd: runCwd };
}

function planError(e: unknown) {
	if (
		e instanceof PlanParseError ||
		e instanceof PlanEngineError ||
		e instanceof PlanStoreError ||
		e instanceof WorktreeError
	) {
		return errorResult(e.message);
	}
	return errorResult(safeMcpError(e));
}

server.registerTool(
	"chit_plan_start",
	{
		description:
			"Start a sequential plan: an operator-authored, reviewed chain of steps where each step is implemented by a converge run in its own git worktree, and a step that depends on another launches only after that dependency is APPLIED to the plan's integration branch. This is the right tool when later work needs to SEE earlier work's code (the inverse of chit_batch_start, where tasks never see each other's diffs). Provide the plan inline (`plan`, an object or JSON string) or by file (`plan_path`, relative to cwd). Launches the first runnable step and returns the plan_id plus the plan view. Then drive it with chit_plan_status (read-only), chit_plan_advance (reconcile + launch, or apply a review_ready step into the integration branch with an apply payload), and chit_plan_cleanup once the plan is done. A step settles review_ready and pauses for the operator's gated apply; dependents wait until it is applied and committed.",
		inputSchema: {
			plan: z
				.union([z.string(), z.record(z.string(), z.unknown())])
				.optional()
				.describe(
					"The plan, inline: a JSON object (schema 1, title, steps[]) or a JSON string of one. Provide this OR plan_path, not both.",
				),
			plan_path: z
				.string()
				.optional()
				.describe(
					"Path to a plan JSON file (absolute or relative to cwd). Provide this OR plan, not both.",
				),
			cwd: z
				.string()
				.optional()
				.describe("Any path in the target repo (defaults to the server cwd)."),
			base_branch: z
				.string()
				.optional()
				.describe(
					"Ref the integration branch is cut from. Default: the plan's baseBranch, else HEAD.",
				),
			max_iterations: z
				.number()
				.int()
				.min(1)
				.optional()
				.describe("Per-step iteration budget when a step declares none. Default 3."),
		},
	},
	async ({ plan, plan_path, cwd, base_branch, max_iterations }) => {
		try {
			const { store, cwd: runCwd } = planStoreFor(cwd);
			// runPlanStart owns the parse/id/start/describe glue (unit-tested with fake deps); the
			// handler only adds the real store + deps and the main-repo resolution. The returned view
			// leads with plan_id, satisfying "return plan_id plus the plan view".
			const view = runPlanStart(
				{
					...(plan !== undefined && { plan }),
					...(plan_path !== undefined && { planPath: plan_path }),
					...(base_branch !== undefined && { baseBranch: base_branch }),
					...(max_iterations !== undefined && { maxIterations: max_iterations }),
				},
				runCwd,
				store,
				planDeps,
				() => crypto.randomUUID(),
			);
			return jsonResult(view);
		} catch (e) {
			return planError(e);
		}
	},
);

server.registerTool(
	"chit_plan_list",
	{
		description:
			"List the plans in this repo, newest first: plan_id, title, status, step count, and how many steps are applied / review_ready / needs_human / failed. Use it to recover a plan_id you lost, then chit_plan_status <plan_id> for the full view. Read-only.",
		inputSchema: {
			limit: z
				.number()
				.int()
				.min(1)
				.optional()
				.describe("Return at most this many plans (newest first). Default: all."),
			cwd: z
				.string()
				.optional()
				.describe("Any path in the target repo (defaults to the server cwd)."),
		},
	},
	async ({ limit, cwd }) => {
		try {
			const { store } = planStoreFor(cwd);
			return jsonResult({ plans: listPlans(store, limit) });
		} catch (e) {
			return planError(e);
		}
	},
);

server.registerTool(
	"chit_plan_status",
	{
		description:
			"Read-only plan overview: each step's status, live job state/phase for a running step, branch/worktree, base sha, changed files, audit refs, plus the next action. Inspection is safe: this NEVER launches steps, creates worktrees, or mutates state (use chit_plan_advance to make progress).",
		inputSchema: {
			plan_id: z.string().describe("The plan id, from chit_plan_start or chit_plan_list."),
			cwd: z
				.string()
				.optional()
				.describe("Any path in the target repo (defaults to the server cwd)."),
		},
	},
	async ({ plan_id, cwd }) => {
		try {
			const { store } = planStoreFor(cwd);
			const plan = store.get(plan_id);
			if (!plan) return errorResult(`unknown plan_id ${plan_id}`);
			return jsonResult(describePlan(plan, planDeps));
		} catch (e) {
			return planError(e);
		}
	},
);

server.registerTool(
	"chit_plan_advance",
	{
		description:
			"Advance a plan, OR apply a review_ready step. Without an `apply` payload: reconcile the running step's finished job into its state (converged -> review_ready; completed-but-not-converged -> needs_human; a vanished/stale job or a failed run -> failed), then launch the next runnable step. With an `apply` payload: run the gated apply for that review_ready step -- flow its worktree diff into the plan integration branch, commit it as a step commit, advance the tip, and mark the step applied (only then can a dependent launch, cut from the new tip). Apply is DRY-RUN by default (reports what would land, mutates nothing); pass apply.confirm=true to apply + commit. A conflict refuses the whole apply (nothing committed, the step stays review_ready); untracked files are applied only when named in apply.include_untracked. Apply does NOT also launch the next step -- call advance again (no payload) to launch it. This is the only progression trigger besides start.",
		inputSchema: {
			plan_id: z.string().describe("The plan id, from chit_plan_start or chit_plan_list."),
			cwd: z
				.string()
				.optional()
				.describe("Any path in the target repo (defaults to the server cwd)."),
			max_iterations: z
				.number()
				.int()
				.min(1)
				.optional()
				.describe("Per-step iteration budget for a step launched by this advance. Default 3."),
			apply: z
				.object({
					step_id: z
						.string()
						.describe("The review_ready step to apply into the integration branch."),
					confirm: z
						.boolean()
						.optional()
						.describe(
							"Apply + commit. Default false = dry run: report what would land, mutate nothing.",
						),
					include_untracked: z
						.array(z.string())
						.optional()
						.describe(
							"Untracked files (from the dry run's untracked list) to also include in the applied commit. A file that would overwrite a different existing integration file is refused (the whole apply is refused).",
						),
				})
				.optional()
				.describe(
					"Apply a review_ready step into the plan integration branch. Omit to instead reconcile + launch the next step.",
				),
		},
	},
	async ({ plan_id, cwd, max_iterations, apply }) => {
		try {
			const { store } = planStoreFor(cwd);
			// An apply payload runs the gated apply (and ONLY that -- a subsequent plain advance launches
			// the next step). Otherwise reconcile the finished step and launch the next runnable one.
			if (apply !== undefined) {
				const response = runPlanApply(
					{
						planId: plan_id,
						stepId: apply.step_id,
						...(apply.confirm !== undefined && { confirm: apply.confirm }),
						...(apply.include_untracked !== undefined && {
							includeUntracked: apply.include_untracked,
						}),
					},
					store,
					planDeps,
				);
				return jsonResult(response);
			}
			const plan = advancePlan(store, planDeps, plan_id, max_iterations);
			return jsonResult(describePlan(plan, planDeps));
		} catch (e) {
			return planError(e);
		}
	},
);

server.registerTool(
	"chit_plan_cancel",
	{
		description:
			"Cancel a plan: request cancellation of the active step's job (intent-first, the same safety as chit_cancel) and mark pending steps cancelled. The running job settles cleanly in the background. Worktrees are left in place for inspection (cleanup is a separate, explicit step).",
		inputSchema: {
			plan_id: z.string().describe("The plan id, from chit_plan_start or chit_plan_list."),
			cwd: z
				.string()
				.optional()
				.describe("Any path in the target repo (defaults to the server cwd)."),
		},
	},
	async ({ plan_id, cwd }) => {
		try {
			const { store } = planStoreFor(cwd);
			const plan = cancelPlan(store, planDeps, plan_id);
			return jsonResult(describePlan(plan, planDeps));
		} catch (e) {
			return planError(e);
		}
	},
);

server.registerTool(
	"chit_plan_cleanup",
	{
		description:
			"Retire a plan's chit-managed worktrees + branches (the integration worktree and every step worktree), by plan_id. DRY RUN by default (reports what it would remove, removes nothing); pass confirm=true to remove. v1 rule: cleanup requires a TERMINAL plan -- completed (every step applied) or cancelled -- and REFUSES while any step is review_ready (its converged diff is not yet in the integration commit, so removing its worktree would silently discard reviewable work). A running / needs_human / failed plan is refused too (you may still apply, fix, rerun, or inspect). NEVER deletes durable records: the plan record, job records, loop logs, and audit receipts all survive (only cleanedAt is stamped). Removing the integration worktree also deletes the integration branch and its applied commits -- merge or apply that branch first; the dry run warns with the commit count. Idempotent.",
		inputSchema: {
			plan_id: z.string().describe("The plan id, from chit_plan_start or chit_plan_list."),
			confirm: z
				.boolean()
				.default(false)
				.describe(
					"Remove the worktrees + branches. Default false = dry run: report what would be removed, remove nothing.",
				),
			cwd: z
				.string()
				.optional()
				.describe("Any path in the target repo (defaults to the server cwd)."),
		},
	},
	async ({ plan_id, confirm, cwd }) => {
		try {
			const { store } = planStoreFor(cwd);
			if (!store.get(plan_id)) return errorResult(`unknown plan_id ${plan_id}`);
			return jsonResult(runPlanCleanup({ planId: plan_id, confirm }, store, planDeps));
		} catch (e) {
			return planError(e);
		}
	},
);

// Start serving on stdio. Exported so the CLI binary can launch the MCP server
// as `chit mcp` (the packaged path); the connect is no longer a top-level side
// effect, so importing this module from the CLI dispatcher registers nothing and
// connects nothing. The stdio transport keeps the process alive until stdin
// closes, so the caller can `await` this and then return its exit code.
export async function startMcpServer(): Promise<void> {
	await server.connect(new StdioServerTransport());
}

// Direct source-dev entrypoint: `bun apps/cli/src/surfaces/mcp/server.ts` still
// starts the server. When this module is imported (e.g. bundled into the CLI),
// import.meta.main is false, so it does not auto-start.
//
// A background run spawns the worker as `<runtime> <this-entry> job-run <id>`,
// reusing whatever entry launched the server. If that entry is THIS module
// (source-dev), it must also dispatch job-run rather than start a second MCP
// server; the CLI entry (run.ts) already does. So both entrypoints route job-run.
if (import.meta.main) {
	if (process.argv[2] === "job-run" && process.argv[3]) {
		await runJobWorker(process.argv[3], { jobStore });
	} else {
		await startMcpServer();
	}
}
