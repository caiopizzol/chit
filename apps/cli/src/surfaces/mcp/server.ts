// chit MCP spike. Exposes a chit run as four stepwise tools so each step is a
// separate, visible tool call with a live heartbeat (proven to render in Claude
// Code). chit still owns the manifest's declared order; the model drives, but
// chit_run_step rejects out-of-order steps. No dynamic routing, no adapter
// event streaming yet.
//
// Register (stdio):
//   claude mcp add chit --scope local -- bun <repo>/apps/cli/src/surfaces/mcp/server.ts
//
// Stepwise manifest tools: chit_run_start -> chit_run_next -> chit_run_step (repeat) ->
// chit_run_trace. Converge tools (autonomous implement/review loop, one iteration
// per call): chit_converge_start -> chit_converge_next (repeat) with
// chit_converge_status / chit_converge_cancel / chit_converge_trace. Audit tools
// (read the local transcripts): chit_audit_list / chit_audit_show.

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadRegistry } from "../../agents/parse.ts";
import { listAudit, showAudit } from "../../audit/reader.ts";
import { AuditStore } from "../../audit/store.ts";
import {
	advanceBatch,
	type BatchEngineDeps,
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
import { formatDuration, isStale, jobTiming, pidAlive } from "../../jobs/health.ts";
import { acquireLock, LockError, releaseLock } from "../../jobs/lock.ts";
import { JobStore } from "../../jobs/store.ts";
import type { JobRecord, LoopJobRecord } from "../../jobs/types.ts";
import { runJobWorker } from "../../jobs/worker.ts";
import { repoKey, repoRoot } from "../../loops/location.ts";
import { LoopStoreError, readLoop, startLoop, stopLoop } from "../../loops/log-store.ts";
import { type ResolvedRun, RunController } from "./controller.ts";
import { ControllerStore } from "./controller-store.ts";
import {
	type ConvergeSession,
	cancelConverge,
	describeConverge,
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
import { buildStatus } from "./status.ts";

// AbortControllers for in-flight steps, so chit_run_cancel can stop a running step
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
// The agent registry is loaded lazily on first use, not at import. The CLI binary
// imports this module to expose `chit mcp`, so importing it must not read
// ~/.config/chit/agents.json (that read belongs to a running server, not to every
// `chit` invocation). loadRegistry can also throw on a malformed config; deferring
// it keeps that failure on the mcp path, not on import.
let registryCache: ReturnType<typeof loadRegistry> | undefined;
function getRegistry(): ReturnType<typeof loadRegistry> {
	registryCache ??= loadRegistry();
	return registryCache;
}

const server = new McpServer({ name: "chit", version: "0.0.0" }, { capabilities: { logging: {} } });

function jsonResult(obj: unknown) {
	return { content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }] };
}
function errorResult(message: string) {
	return { content: [{ type: "text" as const, text: `error: ${message}` }], isError: true };
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

function describeRun(run: Run) {
	const complete = isComplete(run);
	return {
		run_id: run.runId,
		manifest: run.manifest.id,
		complete,
		ready: complete ? [] : readySummary(run),
		output: complete ? finalOutput(run) : undefined,
		// Surface the audit run only when it was written cleanly (no swallowed
		// store error), so the client never gets a pointer to a missing transcript.
		// Absent for an unaudited run or one whose audit writes failed.
		audit: run.recorder && run.recorder.lastError === undefined ? { runId: run.runId } : undefined,
	};
}

server.registerTool(
	"chit_run_start",
	{
		description:
			"Start a stepwise run of a chit manifest. Returns a run_id and the steps ready to run. chit owns the declared order; only ready steps can be run. Then call chit_run_step for each ready step.",
		inputSchema: {
			manifest_path: z
				.string()
				.describe("Path to the manifest .json (absolute, or relative to cwd)"),
			inputs: z
				.record(z.string(), z.string())
				.default({})
				.describe("Manifest inputs as string key/value pairs"),
			scope: z.string().optional().describe("Scope id for per_scope session persistence"),
			cwd: z
				.string()
				.optional()
				.describe("Working dir passed to agents (defaults to the server cwd)"),
			allow_unenforced_permissions: z
				.boolean()
				.default(true)
				.describe(
					"Proceed when an adapter can't enforce a declared permission (both built-in adapters enforce read_only today)",
				),
			audit: z
				.boolean()
				.default(false)
				.describe(
					"Persist a full audit run (prompts/outputs/usage as blobs) under the local state dir, keyed by this run_id. Off by default: blobs can contain secrets.",
				),
		},
	},
	async ({ manifest_path, inputs, scope, cwd, allow_unenforced_permissions, audit }) => {
		// Opportunistic idle cleanup on every chit_run_start request, before the work,
		// so cleanup still happens when this start fails (bad manifest, etc.). Sweeps
		// only one-shot runs (a converge start sweeps loops), as the old stores did.
		runController.sweepOneShot(Date.now());
		const path = isAbsolute(manifest_path) ? manifest_path : resolve(process.cwd(), manifest_path);
		let raw: unknown;
		try {
			raw = JSON.parse(readFileSync(path, "utf-8"));
		} catch (e) {
			return errorResult(`could not read manifest at ${path}: ${(e as Error).message}`);
		}
		let run: Run;
		try {
			run = startRun(crypto.randomUUID(), {
				rawManifest: raw,
				inputs,
				registry: getRegistry(),
				scope,
				invocationCwd: cwd ?? process.cwd(),
				allowUnenforcedPermissions: allow_unenforced_permissions,
				audit,
			});
		} catch (e) {
			return errorResult((e as Error).message);
		}
		runController.registerOneShot(run, Date.now());
		return jsonResult(describeRun(run));
	},
);

server.registerTool(
	"chit_run_next",
	{
		description: "List the steps ready to run next for a run, or report that the run is complete.",
		inputSchema: { run_id: z.string() },
	},
	async ({ run_id }) => {
		const run = runController.getOneShot(run_id, Date.now());
		if (!run) return errorResult(`unknown run_id ${run_id}`);
		return jsonResult(describeRun(run));
	},
);

server.registerTool(
	"chit_run_step",
	{
		description:
			"Run one ready step. Rejects steps that are not ready (chit enforces the declared order). Emits a heartbeat while a long step runs. Returns the step output and the next ready steps.",
		inputSchema: { run_id: z.string(), step_id: z.string() },
	},
	async ({ run_id, step_id }, extra) => {
		const run = runController.getOneShot(run_id, Date.now());
		if (!run) return errorResult(`unknown run_id ${run_id}`);

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

		// chit owns a controller for this step so chit_run_cancel can stop it. Fold in
		// the client's own signal: if Esc ever propagates, it aborts the same
		// controller. The controller stays registered for the whole call so a
		// chit_run_cancel issued after the model's turn is interrupted can still reach
		// it (the server keeps running the in-flight step).
		const controller = new AbortController();
		extra.signal.addEventListener("abort", () => controller.abort(), { once: true });
		// runStep registers this controller in `controllers` only after this call
		// wins the running-lock, and unregisters it on settle. Doing it there, not
		// here before the lock, stops a duplicate concurrent chit_run_step from
		// overwriting then deleting the live step's controller (which would leave
		// chit_run_cancel unable to reach it).

		const rec0 = run.records[step_id];
		if (rec0?.kind === "call") {
			heartbeat(`${step_id} · starting · call ${rec0.participantId} (${rec0.agentId})`);
		}
		try {
			const rec = await runStep(run, step_id, heartbeat, controller, controllers);
			heartbeat(`${step_id} · done in ${rec.durationMs}ms`);
			return jsonResult({
				ran: step_id,
				durationMs: rec.durationMs,
				step_output: rec.output,
				...describeRun(run),
			});
		} catch (e) {
			const rec = run.records[step_id];
			if (rec?.status === "cancelled") {
				// Cancellation is a clean terminal outcome, not an error.
				heartbeat(`${step_id} · cancelled after ${rec.durationMs}ms`);
				return jsonResult({
					cancelled: true,
					step: step_id,
					durationMs: rec.durationMs,
					...describeRun(run),
				});
			}
			return errorResult((e as Error).message);
		} finally {
			// Refresh idle timer after the step settles: a multi-minute step's
			// touch-on-lookup is stale by now, and it's no longer running, so a
			// concurrent chit_run_start sweep could otherwise evict it immediately.
			runController.touchOneShot(run_id, Date.now());
		}
	},
);

server.registerTool(
	"chit_run_cancel",
	{
		description:
			"Cancel a step that is currently running: aborts its controller, which kills the agent's child process and settles the step as cancelled (terminal, blocks dependents). Returns cancelled:true if it stopped a running step, or a reason (already_done | not_running) otherwise. Use after interrupting a long step.",
		inputSchema: { run_id: z.string(), step_id: z.string() },
	},
	async ({ run_id, step_id }) => {
		const run = runController.getOneShot(run_id, Date.now());
		if (!run) return errorResult(`unknown run_id ${run_id}`);
		const result = cancelStep(run, step_id, controllers);
		if (result === "unknown_step") return errorResult(`unknown step "${step_id}"`);
		return jsonResult({
			step: step_id,
			cancelled: result === "cancelled",
			reason: result === "cancelled" ? undefined : result,
			...describeRun(run),
		});
	},
);

server.registerTool(
	"chit_run_trace",
	{
		description:
			"Return the transcript of a run so far: each step's status, participant, agent, elapsed, and output.",
		inputSchema: { run_id: z.string() },
	},
	async ({ run_id }) => {
		const run = runController.getOneShot(run_id, Date.now());
		if (!run) return errorResult(`unknown run_id ${run_id}`);
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
		return jsonResult({
			run_id,
			manifest: run.manifest.id,
			complete: isComplete(run),
			trace,
		});
	},
);

// --- converge tools -------------------------------------------------------
//
// chit_converge_start -> chit_converge_next (repeat, blocking) -> stops at the
// reviewer's verdict. chit_converge_status (what next?) and chit_converge_trace
// (what happened?) inspect between calls; chit_converge_cancel stops a loop.
// All sit on the same single-iteration primitive and loop log the CLI uses, so
// a loop driven over MCP is identical on disk to one driven by `chit converge`.

server.registerTool(
	"chit_converge_start",
	{
		description:
			"Start an autonomous converge loop (a write-capable implementer slices the task, a read-only reviewer checks the diff) driven one iteration at a time. Returns a loop_id and the next action. Then call chit_converge_next per iteration. Records the loop under chit's state dir (keyed by repo), identical to `chit converge`.",
		inputSchema: {
			task: z.string().describe("The slice to converge on"),
			scope: z
				.string()
				.describe("Session scope id; both agents keep their thread across iterations"),
			cwd: z
				.string()
				.optional()
				.describe(
					"Repo to run in (defaults to the server cwd); also where the loop log is written",
				),
			manifest_path: z
				.string()
				.optional()
				.describe(
					"Converge manifest path (absolute, or relative to cwd). Default: the built-in converge manifest.",
				),
			max_iterations: z.number().int().min(1).default(3).describe("Iteration budget. Default 3."),
			loop_id: z.string().optional().describe("Reuse/seed a loop id. Default: generated."),
			force: z
				.boolean()
				.default(false)
				.describe("Overwrite an existing loop log at this loop_id rather than refusing."),
			allow_unenforced_permissions: z
				.boolean()
				.default(false)
				.describe(
					"Run even when the manifest declares a permission its adapter cannot enforce (emits warnings). Default off: such a manifest is refused.",
				),
		},
	},
	async ({
		task,
		scope,
		cwd,
		manifest_path,
		max_iterations,
		loop_id,
		force,
		allow_unenforced_permissions,
	}) => {
		runController.sweepLoops(Date.now());
		// Resolve to an absolute path so the loop header's `repo` matches `chit
		// converge` (which resolves cwd); a relative cwd must not produce a
		// different on-disk loop log than the CLI for the same run.
		const runCwd = resolve(cwd ?? process.cwd());
		// A given manifest_path is read from disk; with none, use the embedded
		// default converge manifest (the published binary ships no examples/).
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
		const prep = prepareConvergeExecute(
			raw,
			getRegistry(),
			scope,
			runCwd,
			allow_unenforced_permissions,
		);
		if (!prep.ok) return errorResult(prep.error);
		let session: ReturnType<typeof startConvergeSession>;
		try {
			session = startConvergeSession({
				cwd: runCwd,
				scope,
				task,
				maxIterations: max_iterations,
				loopId: loop_id,
				force,
				execute: prep.execute,
				loopSteps: prep.loopSteps,
			});
		} catch (e) {
			return errorResult((e as Error).message);
		}
		runController.registerLoop(session, Date.now());
		return jsonResult({
			...describeConverge(session),
			...(prep.warnings.length > 0 && { warnings: prep.warnings }),
		});
	},
);

server.registerTool(
	"chit_converge_next",
	{
		description:
			"Run exactly ONE implement->review iteration of a converge loop, blocking until it settles. Emits a heartbeat while it runs. Pressing Esc (or chit_converge_cancel) cancels the in-flight iteration: it records a clean `cancelled` stop and NO iteration, never a fake-successful round. Returns this iteration's verdict/decision and the loop's next action; a set stopStatus means the loop also stopped.",
		inputSchema: { loop_id: z.string() },
	},
	async ({ loop_id }, extra) => {
		const session = runController.getLoop(loop_id, Date.now());
		if (!session) return errorResult(`unknown loop_id ${loop_id}`);

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

		// One advancer per loop: a background job worker holds the loop lock for its
		// whole run, so a foreground iteration on the same loop must not advance it
		// concurrently. Short retry, then fail fast (a bg job is long-lived; the
		// caller should cancel it or wait rather than block this turn).
		let loopLock: ReturnType<typeof acquireLock>;
		try {
			loopLock = acquireLock(jobStore.loopLockPath(loop_id), { retryMs: 50, maxAttempts: 4 });
		} catch (e) {
			if (e instanceof LockError) {
				return errorResult(
					`loop "${loop_id}" is being advanced by a background job; cancel it with chit_job_cancel or wait, then retry`,
				);
			}
			throw e;
		}

		const iterationNo = session.iteration + 1;
		heartbeat(`${loop_id} · iteration ${iterationNo} · starting`);
		try {
			// extra.signal folds into the iteration's abort: Esc propagates here and
			// cancels the in-flight implement/review (the #4 cancellation contract).
			const result = await runNextIteration(session, extra.signal);
			if (result.kind === "cancelled") {
				heartbeat(`${loop_id} · iteration ${result.iteration} · cancelled`);
				return jsonResult({
					cancelled: true,
					iteration: result.iteration,
					loop: describeConverge(session),
				});
			}
			if (result.kind === "failed") {
				heartbeat(`${loop_id} · iteration ${result.iteration} · failed`);
				return jsonResult({
					failed: true,
					iteration: result.iteration,
					failure: result.failure,
					loop: describeConverge(session),
				});
			}
			heartbeat(
				`${loop_id} · iteration ${result.iteration} · ${result.verdict}${
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
				...(result.auditRunId && { auditRunId: result.auditRunId }),
				...(result.stopStatus && { stopStatus: result.stopStatus }),
				loop: describeConverge(session),
			});
		} catch (e) {
			return errorResult((e as Error).message);
		} finally {
			releaseLock(loopLock);
			// Refresh the idle timer after a (possibly multi-minute) iteration so a
			// concurrent chit_converge_start sweep does not evict it immediately.
			runController.touchLoop(loop_id, Date.now());
		}
	},
);

server.registerTool(
	"chit_converge_status",
	{
		description:
			"Compact control-plane view of a converge loop: open/running/<stop status>, completed iterations, last verdict/decision, whether it is cancellable, and the next action. Answers 'what should I do next?'.",
		inputSchema: { loop_id: z.string() },
	},
	async ({ loop_id }) => {
		const session = runController.getLoop(loop_id, Date.now());
		if (!session) return errorResult(`unknown loop_id ${loop_id}`);
		return jsonResult(describeConverge(session));
	},
);

server.registerTool(
	"chit_converge_cancel",
	{
		description:
			"Cancel a converge loop. If an iteration is in flight, aborts it (it settles as a clean `cancelled` stop); if the loop is open but idle, closes it cancelled now. A loop that already stopped is reported back unchanged. Use to stop a loop from a later turn.",
		inputSchema: { loop_id: z.string() },
	},
	async ({ loop_id }) => {
		const session = runController.getLoop(loop_id, Date.now());
		if (!session) return errorResult(`unknown loop_id ${loop_id}`);
		const cancel = cancelConverge(session);
		return jsonResult({ cancel, loop: describeConverge(session) });
	},
);

server.registerTool(
	"chit_converge_trace",
	{
		description:
			"Diagnostic history of a converge loop: the durable loop-log records (header, each iteration's summary/changed files/verdict/decision/usage/audit ref, and the stop record) plus the live state and audit refs. Read-only over the loop log. Answers 'what happened?'.",
		inputSchema: { loop_id: z.string() },
	},
	async ({ loop_id }) => {
		const session = runController.getLoop(loop_id, Date.now());
		if (!session) return errorResult(`unknown loop_id ${loop_id}`);
		try {
			return jsonResult(traceConverge(session));
		} catch (e) {
			return errorResult((e as Error).message);
		}
	},
);

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
			"List audited runs (newest first): run id, manifest, surface, scope, loop, status (or `incomplete`), step count, usage/cost, and an open-call marker for a run killed mid-call. Use chit_audit_show for one run's timeline.",
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
		return jsonResult({ runs: listAudit(auditStore, limit) });
	},
);

server.registerTool(
	"chit_audit_show",
	{
		description:
			"Show one audited run as a receipt: a summary (manifest/surface/scope/status/usage), the recorded participant config, and a step-level timeline (run/step lifecycle and adapter calls with duration and usage). The raw per-call adapter event stream is hidden by default; set verbose to include those rows. Prompt/output/event bodies are included ONLY when include_bodies is true (they can be large or hold secrets), and only for blob refs the run's own events carry. verbose and include_bodies are independent.",
		inputSchema: {
			run_id: z.string(),
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
	async ({ run_id, verbose, include_bodies }) => {
		try {
			return jsonResult(showAudit(auditStore, run_id, { includeBodies: include_bodies, verbose }));
		} catch (e) {
			return errorResult((e as Error).message);
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

// --- background job tools --------------------------------------------------
//
// chit_converge_run starts an autonomous converge loop in a DETACHED worker
// process and returns immediately; chit_job_status inspects it; chit_job_cancel
// stops it from any later turn. Unlike the foreground chit_converge_* tools (one
// blocking iteration per call, in-memory session), a job survives MCP reconnect:
// its state lives in the durable JobStore, the loop log, and the audit store.

// Spawn the worker as `bun <entry> job-run <jobId>`, reusing this process's exact
// runtime + entry (process.argv[0..1]) so it works the same from source or the
// packaged binary. detached + stdio ignore + unref: the worker outlives this
// server (survives reconnect) and is its own process-group leader (pgid === pid),
// so chit_job_cancel can signal the whole group.
function spawnJobWorker(jobId: string, cwd: string): void {
	const child = spawn(String(process.argv[0]), [String(process.argv[1]), "job-run", jobId], {
		cwd,
		detached: true,
		stdio: "ignore",
	});
	child.unref();
}

// Launch one detached background converge job: validate the manifest, reserve the
// loop, create the durable job record, spawn the worker. Shared by chit_converge_run
// (one job) and the batch engine (one per runnable task), so both refuse the
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
	const prep = prepareConvergeExecute(raw, getRegistry(), p.scope, p.cwd, p.allowUnenforced);
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
			return {
				ok: false,
				error: `${e.message}. Use chit_converge_next to continue a foreground loop, or start a background job with force=true or a new loop_id.`,
			};
		}
		return { ok: false, error: (e as Error).message };
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
		stopLoop(p.cwd, loopId, { status: "blocked", reason: "could not create job record" });
		return { ok: false, error: (e as Error).message };
	}
	try {
		spawnJobWorker(runId, p.cwd);
	} catch (e) {
		jobStore.update(runId, (c) => ({
			...c,
			state: "failed",
			failure: `could not spawn worker: ${(e as Error).message}`,
			endedAt: new Date().toISOString(),
		}));
		stopLoop(p.cwd, loopId, { status: "blocked", reason: "worker spawn failed" });
		return { ok: false, error: `could not spawn background worker: ${(e as Error).message}` };
	}
	// run_id == the durable record's runId. The return keeps the legacy `jobId`
	// field name for the still-present old tools (Union-A); 4b switches to run_id.
	return { ok: true, jobId: runId, loopId, warnings: prep.warnings };
}

server.registerTool(
	"chit_converge_run",
	{
		description:
			"Start an autonomous converge loop as a BACKGROUND job (a detached worker advances it; you keep chatting). Runs ONE task in the current worktree. Returns immediately with a job_id and loop_id. Inspect with chit_job_status / chit_status, stop with chit_job_cancel. Use the foreground chit_converge_start/next instead when you want to checkpoint each iteration. For SEVERAL tasks in parallel, do NOT launch multiple chit_converge_run jobs in one repo (they share the working tree and collide): use chit_batch_start, which isolates each task in its own git worktree. v1 starts a NEW loop only: an existing loop_id is refused (use chit_converge_next to continue a foreground loop, or force=true / a new loop_id).",
		inputSchema: {
			task: z.string().describe("The slice to converge on"),
			scope: z
				.string()
				.describe("Session scope id; both agents keep their thread across iterations"),
			cwd: z.string().optional().describe("Repo to run in (defaults to the server cwd)"),
			manifest_path: z
				.string()
				.optional()
				.describe("Converge manifest path (absolute or relative to cwd). Default: the built-in."),
			max_iterations: z.number().int().min(1).default(3).describe("Iteration budget. Default 3."),
			loop_id: z.string().optional().describe("Seed a loop id. Default: generated."),
			force: z
				.boolean()
				.default(false)
				.describe("Overwrite an existing loop log at this loop_id rather than refusing."),
			allow_unenforced_permissions: z
				.boolean()
				.default(false)
				.describe("Run even when a declared permission cannot be enforced (emits warnings)."),
		},
	},
	async ({
		task,
		scope,
		cwd,
		manifest_path,
		max_iterations,
		loop_id,
		force,
		allow_unenforced_permissions,
	}) => {
		const runCwd = resolve(cwd ?? process.cwd());
		const r = launchConvergeJob({
			task,
			scope,
			cwd: runCwd,
			...(manifest_path !== undefined && { manifestPath: manifest_path }),
			maxIterations: max_iterations,
			...(loop_id !== undefined && { loopId: loop_id }),
			force,
			allowUnenforced: allow_unenforced_permissions,
		});
		if (!r.ok) return errorResult(r.error);
		return jsonResult({
			jobId: r.jobId,
			loopId: r.loopId,
			repo: repoRoot(runCwd),
			state: "queued",
			nextAction: `running in the background; poll chit_job_status "${r.jobId}" (or chit_status), cancel with chit_job_cancel "${r.jobId}"`,
			...(r.warnings.length > 0 && { warnings: r.warnings }),
		});
	},
);

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
				? `${runningDetail.length > 0 ? `${runningDetail.join(", ")}; ` : ""}chit_job_cancel to stop, or wait and poll again`
				: display === "queued"
					? "queued; the worker is starting"
					: display === "stale"
						? `worker appears dead; inspect with chit_job_status${latestRef ? ` (chit_audit_show ${latestRef} for the transcript)` : ""}, then start a fresh job`
						: `${display}${job.stopStatus ? ` (${job.stopStatus})` : ""}; ${latestRef ? `open a transcript with chit_audit_show ${latestRef}` : "no audit transcript was recorded"}`;
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
			? `${runningDetail.length > 0 ? `${runningDetail.join(", ")}; ` : ""}chit_job_cancel to stop, or wait and poll again`
			: display === "queued"
				? "queued; the worker is starting"
				: display === "stale"
					? `worker appears dead; inspect with chit_job_status${latestRef ? ` (chit_audit_show ${latestRef} for the transcript)` : ""}`
					: `${display}; ${latestRef ? `open a transcript with chit_audit_show ${latestRef}` : "no audit transcript was recorded"}`;
	return {
		...base,
		manifestId: job.manifestId,
		...(job.scope !== undefined && { scope: job.scope }),
		nextAction,
	};
}

// Request cancellation of one job: persist the intent FIRST (survives a worker
// restart / stale detection), then signal the worker's process group, but never a
// stale job's possibly-reused pid. Shared by chit_job_cancel and the batch
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

server.registerTool(
	"chit_job_status",
	{
		description:
			"Show one background job: state (queued/running/completed/cancelled/failed, or derived `stale` when the worker is gone), current phase, timing fields (elapsedMs, lastHeartbeatAgeMs, phaseElapsedMs), loop id, iterations, last verdict, audit refs, and the latest iteration's changed files / workspace warnings / usage. Read-only.",
		inputSchema: { job_id: z.string() },
	},
	async ({ job_id }) => {
		const job = jobStore.get(job_id);
		if (!job) return errorResult(`unknown job_id ${job_id}`);
		return jsonResult(describeJob(job));
	},
);

server.registerTool(
	"chit_job_cancel",
	{
		description:
			"Cancel a background job from any turn. Persists the cancel intent FIRST (so it survives a worker restart), then signals the worker's process group. A queued job is cancelled before it starts; a running job stops at the next safe point and records a clean `cancelled` stop. A job that already finished is reported back unchanged.",
		inputSchema: { job_id: z.string() },
	},
	async ({ job_id }) => {
		const r = requestJobCancel(job_id);
		if (r.status === "missing") return errorResult(`unknown job_id ${job_id}`);
		if (r.status === "terminal") {
			return jsonResult({
				jobId: job_id,
				state: r.state,
				cancelled: false,
				note: `job already ${r.state}`,
			});
		}
		return jsonResult({
			jobId: job_id,
			state: r.state,
			cancelRequested: true,
			signaled: r.signaled,
			note: "cancellation requested; the worker stops at the next safe point and records a clean cancelled stop",
		});
	},
);

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
		audit: run.recorder && run.recorder.lastError === undefined ? { run_id: run.runId } : undefined,
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
					records = readLoop(job.cwd, job.loopId);
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
					? `chit_audit_show ${job.auditRefs.at(-1)} for the transcript`
					: "no audit transcript recorded",
			});
		}
		if (resolved.run.kind === "loop") {
			const session = resolved.run.session;
			try {
				return jsonResult({ run_id, execution: "loop", ...traceConverge(session) });
			} catch (e) {
				return errorResult((e as Error).message);
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
			const r = requestJobCancel(run_id);
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
			const cancel = cancelConverge(resolved.run.session);
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
// graph, creates one worktree per task, and launches a chit_converge_run job per
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
	return errorResult((e as Error).message);
}

server.registerTool(
	"chit_batch_start",
	{
		description:
			"Start a batch: run several converge tasks in parallel, each in its own git worktree, as background jobs. This is the right tool for parallel work; for a single unattended task use chit_converge_run instead. Plans the task graph, launches the initial runnable wave (no-dependency tasks, up to max_parallel), and returns immediately. Then poll chit_batch_status and call chit_batch_advance to launch the next wave as jobs finish. No auto-merge: the output is reviewable worktree branches. Each task's worktree branches from the batch base (base_branch); a task's `dependencies` only GATE when it launches (after the deps reach review_ready) and do NOT merge the deps' changes into it, so a task never sees another task's diff. Manifest resolution per task: task.manifestPath > batch manifest_path > the bundled default converge manifest (a write-capable Claude implementer + read-only Codex reviewer; point manifestPath at a custom manifest like examples/converge-codex-writer.json to swap roles).",
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
		const store = new BatchStore(resolve(cwd ?? process.cwd()));
		return jsonResult({ batches: listBatches(store, limit) });
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
		const store = new BatchStore(resolve(cwd ?? process.cwd()));
		const batch = store.get(batch_id);
		if (!batch) return errorResult(`unknown batch_id ${batch_id}`);
		return jsonResult(describeBatch(batch, batchDeps));
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
			"Cancel a batch: request cancellation of every active task job (intent-first, the same safety as chit_job_cancel) and mark pending tasks cancelled. Running jobs settle cleanly in the background. Worktrees are left in place for inspection.",
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
// chit_converge_run spawns the worker as `<runtime> <this-entry> job-run <id>`,
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
