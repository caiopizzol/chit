// chit MCP spike. Exposes a chit run as four stepwise tools so each step is a
// separate, visible tool call with a live heartbeat (proven to render in Claude
// Code). chit still owns the manifest's declared order; the model drives, but
// chit_run_step rejects out-of-order steps. No dynamic routing, no adapter
// event streaming yet.
//
// Register (stdio):
//   claude mcp add chit --scope local -- bun <repo>/apps/cli/src/surfaces/mcp/server.ts
//
// Tools: chit_start -> chit_next -> chit_run_step (repeat) -> chit_trace.

import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadRegistry } from "../../agents/parse.ts";
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
const registry = loadRegistry();

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
					"Proceed when an adapter can't enforce a declared permission (e.g. claude read_only)",
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
				registry,
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

await server.connect(new StdioServerTransport());
