// chit MCP spike. Exposes a chit run as four stepwise tools so each step is a
// separate, visible tool call with a live heartbeat (proven to render in Claude
// Code). chit still owns the manifest's declared order; the model drives, but
// chit_run_step rejects out-of-order steps. No dynamic routing, no adapter
// event streaming yet.
//
// Register (stdio):
//   claude mcp add chit --scope local -- bun <repo>/apps/cli/src/surfaces/mcp/server.ts
//
// Stepwise manifest tools: chit_start -> chit_next -> chit_run_step (repeat) ->
// chit_trace. Converge tools (autonomous implement/review loop, one iteration
// per call): chit_converge_start -> chit_converge_next (repeat) with
// chit_converge_status / chit_converge_cancel / chit_converge_trace. Audit tools
// (read the local transcripts): chit_audit_list / chit_audit_show.

import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import {
	findEnforcementGaps,
	findUnknownAgents,
	formatEnforcementGaps,
	parseManifest,
} from "@chit-run/core";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadRegistry } from "../../agents/parse.ts";
import { listAudit, showAudit } from "../../audit/reader.ts";
import { AuditStore } from "../../audit/store.ts";
import {
	buildExecute,
	type ConvergeExecute,
	validateConvergeManifest,
} from "../../cli/converge.ts";
import { DEFAULT_CONVERGE_MANIFEST } from "../../cli/default-converge-manifest.ts";
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

// Idle-evicting run store (sweeps on chit_start) so the in-memory run map is
// bounded; see run-store.ts.
const runs = new RunStore();
// AbortControllers for in-flight steps, so chit_cancel can stop a running step
// even after the model's turn is interrupted (the server keeps running).
const controllers: StepControllers = new Map();
// Idle-evicting converge session store (sweeps on chit_converge_start). Holds the
// in-memory state for chit_converge_* loops; the durable record is the loop log.
const convergeSessions = new ConvergeStore();
// The local audit store (~/.local/state/chit/audit), read-only here: the audit
// tools inspect runs that converge/run/MCP-start wrote. Reads validate run ids
// and only resolve blob refs that appear in a run's own events.
const auditStore = new AuditStore();
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
	"chit_start",
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
		// Opportunistic idle cleanup on every chit_start request, before the work,
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
	"chit_next",
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

		// chit owns a controller for this step so chit_cancel can stop it. Fold in
		// the client's own signal: if Esc ever propagates, it aborts the same
		// controller. The controller stays registered for the whole call so a
		// chit_cancel issued after the model's turn is interrupted can still reach
		// it (the server keeps running the in-flight step).
		const controller = new AbortController();
		extra.signal.addEventListener("abort", () => controller.abort(), { once: true });
		// runStep registers this controller in `controllers` only after this call
		// wins the running-lock, and unregisters it on settle. Doing it there, not
		// here before the lock, stops a duplicate concurrent chit_run_step from
		// overwriting then deleting the live step's controller (which would leave
		// chit_cancel unable to reach it).

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
			// concurrent chit_start sweep could otherwise evict it immediately.
			runs.touch(run_id, Date.now());
		}
	},
);

server.registerTool(
	"chit_cancel",
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
	"chit_trace",
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

// Load + validate the converge manifest and build its audited execute. Returns a
// ready execute (plus any unenforced-permission warnings) or an error string,
// matching `chit converge`'s setup so the MCP and CLI paths refuse the same
// manifests (non-converge shape, unknown agent, unenforceable permission).
function prepareConvergeExecute(
	raw: unknown,
	scope: string,
	cwd: string,
	allowUnenforced: boolean,
): { ok: true; execute: ConvergeExecute; warnings: string[] } | { ok: false; error: string } {
	let manifest: ReturnType<typeof parseManifest>;
	try {
		manifest = parseManifest(raw);
	} catch (e) {
		return { ok: false, error: (e as Error).message };
	}
	const shapeError = validateConvergeManifest(manifest);
	if (shapeError) return { ok: false, error: shapeError };
	const registry = getRegistry();
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
	return { ok: true, execute: buildExecute(manifest, registry, scope, cwd), warnings };
}

server.registerTool(
	"chit_converge_start",
	{
		description:
			"Start an autonomous converge loop (a write-capable implementer slices the task, a read-only reviewer checks the diff) driven one iteration at a time. Returns a loop_id and the next action. Then call chit_converge_next per iteration. Records to .chit/loops/<loop_id>.jsonl, identical to `chit converge`.",
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
		const prep = prepareConvergeExecute(raw, scope, runCwd, allow_unenforced_permissions);
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
				...(result.usage && { usage: result.usage }),
				...(result.auditRunId && { auditRunId: result.auditRunId }),
				...(result.stopStatus && { stopStatus: result.stopStatus }),
				loop: describeConverge(session),
			});
		} catch (e) {
			return errorResult((e as Error).message);
		} finally {
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
			"Show one audited run: a summary (manifest/surface/scope/status/usage), the recorded participant config, and the event timeline. An incomplete run carries the reason (open call / failed step / abandoned). Prompt/output/event bodies are included ONLY when include_bodies is true (they can be large or hold secrets), and only for blob refs the run's own events carry.",
		inputSchema: {
			run_id: z.string(),
			include_bodies: z
				.boolean()
				.default(false)
				.describe("Include rendered prompt/output/event bodies. Off by default."),
		},
	},
	async ({ run_id, include_bodies }) => {
		try {
			return jsonResult(showAudit(auditStore, run_id, include_bodies));
		} catch (e) {
			return errorResult((e as Error).message);
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
if (import.meta.main) {
	await startMcpServer();
}
