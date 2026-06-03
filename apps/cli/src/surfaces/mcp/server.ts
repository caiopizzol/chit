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
import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import {
	type LoopRecord,
	type NormalizedManifest,
	parseManifest,
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
	createTaskWorktree,
	realGit,
	removeTaskWorktree,
	WorktreeError,
} from "../../batches/worktree.ts";
import { prepareConvergeExecute } from "../../cli/converge.ts";
import { DEFAULT_CONVERGE_MANIFEST } from "../../cli/default-converge-manifest.ts";
import { loadConfig } from "../../config/load.ts";
import { formatDuration, isStale, jobTiming, pidAlive, runWaitState } from "../../jobs/health.ts";
import { acquireLock, LockError, releaseLock } from "../../jobs/lock.ts";
import { JobStore, JobStoreError } from "../../jobs/store.ts";
import type { JobRecord, LoopJobRecord, OneShotJobRecord } from "../../jobs/types.ts";
import { runJobWorker } from "../../jobs/worker.ts";
import { repoKey } from "../../loops/location.ts";
import { LoopStoreError, readLoop, startLoop, stopLoop } from "../../loops/log-store.ts";
import { validateOneShotAuth } from "../../runs/run-once.ts";
import { prepareInputs } from "../../runtime/render.ts";
import { type ResolvedRun, RunController } from "./controller.ts";
import { ControllerStore } from "./controller-store.ts";
import {
	type ConvergeSession,
	cancelConverge,
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
import { buildStatus, publicRunSummary, publicTimeline } from "./status.ts";

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
// keeps that failure on the mcp path, not on import. getRegistry stays as a shim over
// the cached config so the existing call sites are unchanged; getConfig exposes the
// roles for the resolve boundaries.
let configCache: ReturnType<typeof loadConfig> | undefined;
function getConfig(): ReturnType<typeof loadConfig> {
	configCache ??= loadConfig();
	return configCache;
}
function getRegistry(): ReturnType<typeof loadConfig>["registry"] {
	return getConfig().registry;
}

const server = new McpServer({ name: "chit", version: "0.0.0" }, { capabilities: { logging: {} } });

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
			return jsonResult(buildStatus(runController, auditStore, jobStore, recent_limit, Date.now()));
		}
		const resolved = runController.resolve(run_id, Date.now());
		if (!resolved) return errorResult(`unknown run_id ${run_id}`);
		return jsonResult(unifiedRunView(resolved));
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
			"Block until a background run or batch reaches a meaningful state, then return the same view as chit_status / chit_batch_status plus a waitResult. Use this instead of polling chit_status in a loop (and never poll chit's state files -- they are private). For a background run (run_id): waits until the run is terminal (completed / failed / cancelled, or its worker died). For a batch (batch_id): waits until chit_batch_advance would do real work (a task can launch or a finished job can reconcile) or the batch is fully terminal -- it does NOT advance the batch itself; call chit_batch_advance after. Read-only. Emits a heartbeat while waiting; press Esc to stop waiting (the run/batch keeps running). A foreground run is rejected: advance it with chit_next. waitResult is terminal | needs_advance | timeout. Inputs: run_id OR batch_id, optional timeout_ms (default 900000), cwd (batch only).",
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
	force?: boolean;
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

	const runId = crypto.randomUUID();
	const job: LoopJobRecord = {
		runId,
		policy: "loop",
		loopId,
		repoKey: repoKey(p.cwd),
		cwd: p.cwd,
		scope: p.scope,
		task: p.task,
		...(manifestAbs !== undefined && { manifestPath: manifestAbs }),
		maxIterations: p.maxIterations,
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
	let manifest: NormalizedManifest;
	try {
		// Resolve role refs before governance (validateOneShotAuth reads the resolved
		// participants). An unknown-role / no-agent failure is reported the same way as
		// a parse failure. getConfig throws on a malformed config; that escapes to the
		// handler's catch like the registry-load failure already does below.
		manifest = resolveManifest(parseManifest(JSON.parse(readFileSync(manifestAbs, "utf-8"))), {
			roles: getConfig().roles,
		});
	} catch (e) {
		return {
			ok: false,
			error: `could not load manifest at ${manifestAbs}: ${(e as Error).message}`,
		};
	}

	// A malformed agents.json throws from loadRegistry; return it as an error rather
	// than letting it escape the tool handler (matches the foreground startRun path).
	let registry: ReturnType<typeof getRegistry>;
	try {
		registry = getRegistry();
	} catch (e) {
		return { ok: false, error: `could not load agent registry: ${(e as Error).message}` };
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
			...(job.stopStatus !== undefined && { stopStatus: job.stopStatus }),
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
export function unifiedRunView(resolved: ResolvedRun) {
	if (resolved.mode === "background") return backgroundRunView(resolved.job);
	return resolved.run.kind === "one-shot"
		? oneShotRunView(resolved.run.run)
		: loopRunView(resolved.run.session);
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

export function loopRunView(session: ConvergeSession) {
	const status = session.terminalStatus ?? (session.active ? "running" : "open");
	const stopped = session.terminalStatus !== undefined;
	const nextAction = stopped
		? `loop ${session.terminalStatus}; chit_trace "${session.loopId}" for the history`
		: session.active
			? `iteration in flight; chit_cancel "${session.loopId}" to stop it`
			: `chit_next "${session.loopId}" to run the next iteration; chit_cancel "${session.loopId}" to stop`;
	return {
		run_id: session.loopId,
		mode: "foreground" as const,
		execution: "loop" as const,
		status,
		iterationsCompleted: session.iteration,
		cancellable: !stopped,
		...(session.lastVerdict !== undefined && { lastVerdict: session.lastVerdict }),
		...(session.lastDecision !== undefined && { lastDecision: session.lastDecision }),
		...(session.failure !== undefined && { failure: session.failure }),
		auditRefs: session.auditRefs,
		nextAction,
	};
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
		nextAction: live
			? `running in the background; chit_status "${job.runId}" to poll, chit_cancel "${job.runId}" to stop`
			: dj.display === "stale"
				? `worker appears dead; chit_trace "${job.runId}" for what it recorded, then start a fresh run`
				: `${dj.display}${stopSuffix}; chit_trace "${job.runId}" for the history`,
	};
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
	}) => {
		if (!task && !manifest_path) {
			return errorResult("provide `task` (to converge with the built-in loop) or `manifest_path`");
		}
		const runCwd = resolve(cwd ?? process.cwd());
		// Read the manifest once to learn its policy; task-form uses the built-in loop
		// manifest. Foreground paths reuse this raw; background launchers re-read it
		// from the path (they store the absolute manifest_path on the job record).
		let raw: unknown;
		if (manifest_path) {
			const path = isAbsolute(manifest_path) ? manifest_path : resolve(runCwd, manifest_path);
			try {
				raw = JSON.parse(readFileSync(path, "utf-8"));
			} catch (e) {
				return errorResult(`could not read manifest at ${path}: ${(e as Error).message}`);
			}
		} else {
			raw = DEFAULT_CONVERGE_MANIFEST;
		}
		let manifest: NormalizedManifest;
		try {
			manifest = parseManifest(raw);
		} catch (e) {
			return errorResult(`invalid manifest: ${(e as Error).message}`);
		}

		if (manifest.policy.kind === "loop") {
			if (!task) return errorResult("a loop run needs a `task` to converge on");
			if (scope === undefined) {
				return errorResult(
					"a loop run needs a `scope` (both agents keep their thread across iterations)",
				);
			}
			if (mode === "background") {
				const r = launchConvergeJob({
					task,
					scope,
					cwd: runCwd,
					...(manifest_path !== undefined && { manifestPath: manifest_path }),
					maxIterations: max_iterations,
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
			runController.sweepLoops(Date.now());
			const prep = prepareConvergeExecute(
				raw,
				getConfig().registry,
				scope,
				runCwd,
				allow_unenforced_permissions,
				getConfig().roles,
			);
			if (!prep.ok) return errorResult(prep.error);
			let session: ReturnType<typeof startConvergeSession>;
			try {
				session = startConvergeSession({
					cwd: runCwd,
					scope,
					task,
					maxIterations: max_iterations,
					force: false,
					execute: prep.execute,
					loopSteps: prep.loopSteps,
				});
			} catch (e) {
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
			heartbeat(`${run_id} · iteration ${session.iteration + 1} · starting`);
			try {
				const result = await runNextIteration(session, extra.signal);
				if (result.kind === "cancelled") {
					heartbeat(`${run_id} · iteration ${result.iteration} · cancelled`);
					return jsonResult({
						cancelled: true,
						iteration: result.iteration,
						...loopRunView(session),
					});
				}
				if (result.kind === "failed") {
					heartbeat(`${run_id} · iteration ${result.iteration} · failed`);
					return jsonResult({
						failed: true,
						iteration: result.iteration,
						failure: result.failure,
						...loopRunView(session),
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
					changedFiles: result.changedFiles,
					workspaceWarnings: result.workspaceWarnings,
					...(result.usage && { usage: result.usage }),
					...(result.auditRunId && { auditRef: result.auditRunId }),
					...(result.stopStatus && { stopStatus: result.stopStatus }),
					...loopRunView(session),
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

// The history of any run: a one-shot's step transcript, or a loop/background
// run's durable loop log. Read-only.
server.registerTool(
	"chit_trace",
	{
		description:
			"The history of a run: a one-shot run's step transcript, or a loop/background run's iteration log (each iteration's summary, changed files, verdict, usage, and audit ref). Read-only. Inputs: run_id.",
		inputSchema: {
			run_id: z.string().describe("A run id (from chit_start)"),
		},
	},
	async ({ run_id }) => {
		const resolved = runController.resolve(run_id, Date.now());
		if (!resolved) return errorResult(`unknown run_id ${run_id}`);
		if (resolved.mode === "background") {
			const job = resolved.job;
			if (job.policy === "loop") {
				let records: unknown[] = [];
				try {
					records = publicLoopRecords(readLoop(job.cwd, job.loopId));
				} catch {
					// loop log not readable yet (worker still starting) or removed
				}
				return jsonResult({ run_id, execution: "job", policy: "loop", records });
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
		const resolved = runController.resolve(run_id, Date.now());
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
				cancel = cancelConverge(resolved.run.session);
			} catch (e) {
				return errorResult(safeMcpError(e));
			}
			return jsonResult({ run_id, cancel, run: loopRunView(resolved.run.session) });
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
			...(p.manifestPath !== undefined && { manifestPath: p.manifestPath }),
			maxIterations: p.maxIterations,
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
		try {
			const iters = readLoop(worktreePath, loopId).filter((r) => r.type === "iteration");
			const last = iters.at(-1);
			if (last && last.type === "iteration") {
				return { changedFiles: last.changedFiles, workspaceWarnings: last.workspaceWarnings ?? [] };
			}
		} catch {
			// loop log not readable (worker still starting, or removed); no detail
		}
		return { changedFiles: [], workspaceWarnings: [] };
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
			"Per-task converge manifest override (absolute or relative to cwd). Omit to use the bundled default (write-capable Claude implementer + read-only Codex reviewer). To swap roles (e.g. a Codex implementer), point this at a custom manifest like examples/converge-codex-writer.json.",
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
			"Start a batch: run several converge tasks in parallel, each in its own git worktree, as background jobs. This is the right tool for parallel work; for a single unattended task use chit_start with mode background instead. Plans the task graph, launches the initial runnable wave (no-dependency tasks, up to max_parallel), and returns immediately. Then poll chit_batch_status and call chit_batch_advance to launch the next wave as jobs finish. No auto-merge: the output is reviewable worktree branches. Each task's worktree branches from the batch base (base_branch); a task's `dependencies` only GATE when it launches (after the deps reach review_ready) and do NOT merge the deps' changes into it, so a task never sees another task's diff. Manifest resolution per task: task.manifestPath > batch manifest_path > the bundled default converge manifest (a write-capable Claude implementer + read-only Codex reviewer; point manifestPath at a custom manifest like examples/converge-codex-writer.json to swap roles).",
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
		},
	},
	async ({ tasks, cwd, max_parallel, base_branch, manifest_path, max_iterations }) => {
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
			"List the batches in this repo, newest first: id, status, task count, how many tasks are review_ready / failed, and whether it has been cleaned up. Use it to recover a batch id you lost, then chit_batch_status <id> for the full view. Read-only.",
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
			"Advance a batch: reconcile finished jobs into task state (converged -> review_ready; blocked/max-iterations/failed/stale -> failed; dependents proceed only past a review_ready task), then launch the next runnable wave. The only progression trigger besides start. Call it when chit_batch_status reports runnable tasks or a finished job.",
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
