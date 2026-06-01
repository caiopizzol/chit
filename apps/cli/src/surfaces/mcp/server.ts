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
import { prepareConvergeExecute } from "../../cli/converge.ts";
import { DEFAULT_CONVERGE_MANIFEST } from "../../cli/default-converge-manifest.ts";
import { isStale, pidAlive } from "../../jobs/health.ts";
import { acquireLock, LockError, releaseLock } from "../../jobs/lock.ts";
import { JobStore } from "../../jobs/store.ts";
import type { JobRecord } from "../../jobs/types.ts";
import { runJobWorker } from "../../jobs/worker.ts";
import { repoKey, repoRoot } from "../../loops/location.ts";
import { LoopStoreError, readLoop, startLoop, stopLoop } from "../../loops/log-store.ts";
import {
	cancelConverge,
	describeConverge,
	runNextIteration,
	startConvergeSession,
	traceConverge,
} from "./converge-engine.ts";
import { ConvergeStore } from "./converge-store.ts";
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
import { RunStore } from "./run-store.ts";
import { buildStatus } from "./status.ts";

// Idle-evicting run store (sweeps on chit_run_start) so the in-memory run map is
// bounded; see run-store.ts.
const runs = new RunStore();
// AbortControllers for in-flight steps, so chit_run_cancel can stop a running step
// even after the model's turn is interrupted (the server keeps running).
const controllers: StepControllers = new Map();
// Idle-evicting converge session store (sweeps on chit_converge_start). Holds the
// in-memory state for chit_converge_* loops; the durable record is the loop log.
const convergeSessions = new ConvergeStore();
// The local audit store (~/.local/state/chit/audit), read-only here: the audit
// tools inspect runs that converge/run/MCP-start wrote. Reads validate run ids
// and only resolve blob refs that appear in a run's own events.
const auditStore = new AuditStore();
// Durable background jobs (~/.local/state/chit/jobs). Unlike the in-memory run
// and converge stores, jobs survive MCP reconnect: a detached worker process
// owns the run, and these tools read/cancel it through the durable record.
const jobStore = new JobStore();
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
		// so cleanup still happens when this start fails (bad manifest, etc.).
		runs.sweep(Date.now());
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
		runs.add(run, Date.now());
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
		const run = runs.get(run_id, Date.now());
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
		const run = runs.get(run_id, Date.now());
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
			runs.touch(run_id, Date.now());
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
		const run = runs.get(run_id, Date.now());
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
		const run = runs.get(run_id, Date.now());
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
		convergeSessions.sweep(Date.now());
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
			});
		} catch (e) {
			return errorResult((e as Error).message);
		}
		convergeSessions.add(session, Date.now());
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
		const session = convergeSessions.get(loop_id, Date.now());
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
			convergeSessions.touch(loop_id, Date.now());
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
		const session = convergeSessions.get(loop_id, Date.now());
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
		const session = convergeSessions.get(loop_id, Date.now());
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
		const session = convergeSessions.get(loop_id, Date.now());
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
			"Operator overview: the stepwise runs and converge loops live in THIS server right now (each loop with its status and next action), plus a compact list of recently audited runs (newest first). Read-only; answers 'what is active and what should I do next?'. Active state is per-session (a new session starts empty, and idle runs are evicted); recent state is durable. Drill into one item with chit_converge_status/chit_run_trace, or chit_audit_show for a run's receipt.",
		inputSchema: {
			recent_limit: z
				.number()
				.int()
				.min(0)
				.default(5)
				.describe(
					"How many recently audited runs to include (newest first). Default 5; 0 for none.",
				),
		},
	},
	async ({ recent_limit }) => {
		return jsonResult(
			buildStatus(runs, convergeSessions, auditStore, jobStore, recent_limit, Date.now()),
		);
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

server.registerTool(
	"chit_converge_run",
	{
		description:
			"Start an autonomous converge loop as a BACKGROUND job (a detached worker advances it; you keep chatting). Returns immediately with a job_id and loop_id. Inspect with chit_job_status / chit_status, stop with chit_job_cancel. Use the foreground chit_converge_start/next instead when you want to checkpoint each iteration. v1 starts a NEW loop only: an existing loop_id is refused (use chit_converge_next to continue a foreground loop, or force=true / a new loop_id).",
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
		let raw: unknown;
		let manifestAbs: string | undefined;
		if (manifest_path) {
			manifestAbs = isAbsolute(manifest_path) ? manifest_path : resolve(runCwd, manifest_path);
			try {
				raw = JSON.parse(readFileSync(manifestAbs, "utf-8"));
			} catch (e) {
				return errorResult(`could not read manifest at ${manifestAbs}: ${(e as Error).message}`);
			}
		} else {
			raw = DEFAULT_CONVERGE_MANIFEST;
		}
		// Validate synchronously so a bad manifest / unknown agent / unenforceable
		// permission is an immediate error, not a job that fails in the background.
		const prep = prepareConvergeExecute(
			raw,
			getRegistry(),
			scope,
			runCwd,
			allow_unenforced_permissions,
		);
		if (!prep.ok) return errorResult(prep.error);

		const loopId = loop_id ?? crypto.randomUUID();
		// Reserve the loop (the loud "already exists" check for v1's start-only
		// contract). startLoop refuses an existing loop log unless force.
		try {
			startLoop(runCwd, { scope, task, maxIterations: max_iterations, loopId, force });
		} catch (e) {
			if (e instanceof LoopStoreError) {
				return errorResult(
					`${e.message}. Use chit_converge_next to continue a foreground loop, or start a background job with force=true or a new loop_id.`,
				);
			}
			return errorResult((e as Error).message);
		}

		const jobId = crypto.randomUUID();
		const job: JobRecord = {
			jobId,
			loopId,
			repoKey: repoKey(runCwd),
			cwd: runCwd,
			scope,
			task,
			...(manifestAbs !== undefined && { manifestPath: manifestAbs }),
			maxIterations: max_iterations,
			allowUnenforced: allow_unenforced_permissions,
			state: "queued",
			createdAt: new Date().toISOString(),
			iterationsCompleted: 0,
			auditRefs: [],
		};
		try {
			jobStore.create(job);
		} catch (e) {
			stopLoop(runCwd, loopId, { status: "blocked", reason: "could not create job record" });
			return errorResult((e as Error).message);
		}
		try {
			spawnJobWorker(jobId, runCwd);
		} catch (e) {
			// The worker never started: mark the job failed and close the reserved
			// loop so neither is left dangling.
			jobStore.update(jobId, (c) => ({
				...c,
				state: "failed",
				failure: `could not spawn worker: ${(e as Error).message}`,
				endedAt: new Date().toISOString(),
			}));
			stopLoop(runCwd, loopId, { status: "blocked", reason: "worker spawn failed" });
			return errorResult(`could not spawn background worker: ${(e as Error).message}`);
		}
		return jsonResult({
			jobId,
			loopId,
			repo: repoRoot(runCwd),
			state: "queued",
			nextAction: `running in the background; poll chit_job_status "${jobId}" (or chit_status), cancel with chit_job_cancel "${jobId}"`,
			...(prep.warnings.length > 0 && { warnings: prep.warnings }),
		});
	},
);

// Compact, durable per-job view: lifecycle state (with derived `stale` when a
// running worker is gone/silent), the live phase, and the latest iteration's
// changed files / workspace warnings / usage read from the loop log (the job
// record points, the loop log details).
function describeJob(job: JobRecord) {
	const now = Date.now();
	const stale = isStale(job, now);
	const display = stale ? "stale" : job.state;
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
			? "in progress; chit_job_cancel to stop, or wait and poll again"
			: display === "queued"
				? "queued; the worker is starting"
				: display === "stale"
					? "worker appears dead; inspect with chit_job_status (and chit_audit_show <auditRef> for transcripts), then start a fresh job"
					: `${display}${job.stopStatus ? ` (${job.stopStatus})` : ""}; open a transcript with chit_audit_show <auditRef>`;
	return {
		jobId: job.jobId,
		loopId: job.loopId,
		scope: job.scope,
		task: job.task,
		state: job.state,
		display,
		stale,
		alive: pidAlive(job.pid),
		...(job.phase !== undefined && { phase: job.phase }),
		...(job.iteration !== undefined && { iteration: job.iteration }),
		iterationsCompleted: job.iterationsCompleted,
		...(job.lastVerdict !== undefined && { lastVerdict: job.lastVerdict }),
		...(job.stopStatus !== undefined && { stopStatus: job.stopStatus }),
		...(job.failure !== undefined && { failure: job.failure }),
		...(job.cancelRequestedAt !== undefined && { cancelRequestedAt: job.cancelRequestedAt }),
		auditRefs: job.auditRefs,
		createdAt: job.createdAt,
		...(job.startedAt !== undefined && { startedAt: job.startedAt }),
		...(job.endedAt !== undefined && { endedAt: job.endedAt }),
		...(job.lastHeartbeatAt !== undefined && { lastHeartbeatAt: job.lastHeartbeatAt }),
		...(latest !== undefined && { latest }),
		nextAction,
	};
}

server.registerTool(
	"chit_job_status",
	{
		description:
			"Show one background job: state (queued/running/completed/cancelled/failed, or derived `stale` when the worker is gone), current phase, loop id, iterations, last verdict, audit refs, and the latest iteration's changed files / workspace warnings / usage. Read-only.",
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
		const job = jobStore.get(job_id);
		if (!job) return errorResult(`unknown job_id ${job_id}`);
		if (job.state !== "queued" && job.state !== "running") {
			return jsonResult({
				jobId: job_id,
				state: job.state,
				cancelled: false,
				note: `job already ${job.state}`,
			});
		}
		// Intent first: persist cancelRequestedAt before signaling, so a worker that
		// restarts or is stale-detected still has the reason on record.
		const updated = jobStore.update(job_id, (c) => ({
			...c,
			cancelRequestedAt: new Date().toISOString(),
			...(c.state === "running" && { phase: "cancelling" as const }),
		}));
		// Then signal the worker's process group (best effort): the in-flight
		// iteration aborts; a queued worker will see the intent before iteration 1.
		// Only signal a job that is NOT stale: a stale job's pid may have been reused
		// by an unrelated process, and process.kill(-pgid) would hit that group. For
		// a stale job the persisted intent stands; the worker is already gone.
		let signaled = false;
		if (!isStale(updated, Date.now()) && updated.pgid !== undefined && pidAlive(updated.pid)) {
			try {
				process.kill(-updated.pgid, "SIGTERM");
				signaled = true;
			} catch {
				// ESRCH: the worker already exited. The persisted intent still stands.
			}
		}
		return jsonResult({
			jobId: job_id,
			state: updated.state,
			cancelRequested: true,
			signaled,
			note: "cancellation requested; the worker stops at the next safe point and records a clean cancelled stop",
		});
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
