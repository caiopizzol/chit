// Stepwise run engine for the MCP spike. executeManifest runs the whole DAG to
// completion; this drives ONE step at a time so each step can be a separate,
// visible MCP tool call. chit owns the order: a step is runnable only when its
// manifest.dependencies are all done. Out-of-order steps are rejected. This is
// the "stepwise static DAG" guardrail (no dynamic, model-invented routing).
//
// Spike scope: no adapter event streaming. The heartbeat is latest-state text
// emitted on a timer while a (possibly multi-minute) adapter call runs.

import {
	findEnforcementGaps,
	findUnknownAgents,
	type NormalizedManifest,
	type NormalizedRegistry,
	parseManifest,
} from "@chit/core";
import { buildAdapter } from "../../adapters/factory.ts";
import { buildAgentInput } from "../../runtime/execute.ts";
import {
	type PreparedInputs,
	prepareInputs,
	RuntimeError,
	renderTemplate,
} from "../../runtime/render.ts";
import type { AdapterMap } from "../../runtime/types.ts";
import { wrapAdaptersWithSessions } from "../../sessions/coordinator.ts";
import { defaultSessionDir, FileSessionStore } from "../../sessions/store.ts";

export interface StepRecord {
	stepId: string;
	kind: "call" | "format";
	participantId?: string;
	agentId?: string;
	session?: string;
	status: "pending" | "running" | "done" | "failed" | "cancelled";
	durationMs?: number;
	output?: string;
	error?: string;
}

export interface Run {
	runId: string;
	manifest: NormalizedManifest;
	preparedInputs: PreparedInputs;
	adapters: AdapterMap;
	invocationCwd: string;
	outputs: Record<string, string>;
	records: Record<string, StepRecord>;
}

export type Heartbeat = (message: string) => void;

export interface StartRunOptions {
	rawManifest: unknown;
	inputs: Record<string, unknown>;
	registry: NormalizedRegistry;
	scope?: string;
	invocationCwd: string;
	allowUnenforcedPermissions: boolean;
}

export function startRun(runId: string, opts: StartRunOptions): Run {
	const manifest = parseManifest(opts.rawManifest);

	const unknown = findUnknownAgents(manifest, opts.registry);
	if (unknown.length > 0) {
		throw new RuntimeError(
			`unknown agent(s): ${unknown.map((u) => `${u.agentId} (participant "${u.participantId}")`).join(", ")}`,
		);
	}
	const gaps = findEnforcementGaps(manifest, opts.registry);
	if (gaps.length > 0 && !opts.allowUnenforcedPermissions) {
		throw new RuntimeError(
			`cannot enforce permissions for ${gaps
				.map((g) => `${g.participantId}:${g.permission}`)
				.join(", ")}; pass allow_unenforced_permissions=true`,
		);
	}

	const baseAdapters: AdapterMap = {};
	for (const p of Object.values(manifest.participants)) {
		if (!(p.agent in baseAdapters)) {
			const agent = opts.registry.agents[p.agent];
			if (!agent) continue;
			baseAdapters[p.agent] = buildAdapter(agent);
		}
	}
	const adapters =
		opts.scope !== undefined
			? wrapAdaptersWithSessions(
					baseAdapters,
					manifest,
					opts.registry,
					opts.scope,
					new FileSessionStore(defaultSessionDir()),
				)
			: baseAdapters;

	const preparedInputs = prepareInputs(manifest.inputs, opts.inputs, opts.invocationCwd);

	const records: Record<string, StepRecord> = {};
	for (const [stepId, step] of Object.entries(manifest.steps)) {
		if (step.kind === "call") {
			const participant = manifest.participants[step.call];
			records[stepId] = {
				stepId,
				kind: "call",
				participantId: step.call,
				agentId: participant?.agent,
				session: participant?.session,
				status: "pending",
			};
		} else {
			records[stepId] = { stepId, kind: "format", status: "pending" };
		}
	}

	return {
		runId,
		manifest,
		preparedInputs,
		adapters,
		invocationCwd: opts.invocationCwd,
		outputs: {},
		records,
	};
}

// A step is ready iff it is pending and every dependency is done.
export function readySteps(run: Run): string[] {
	const ready: string[] = [];
	for (const [stepId, rec] of Object.entries(run.records)) {
		if (rec.status !== "pending") continue;
		const deps = run.manifest.dependencies[stepId] ?? [];
		if (deps.every((d) => run.records[d]?.status === "done")) ready.push(stepId);
	}
	return ready;
}

export function isComplete(run: Run): boolean {
	return run.records[run.manifest.output]?.status === "done";
}

export function finalOutput(run: Run): string | undefined {
	return run.outputs[run.manifest.output];
}

// Registry of AbortControllers for in-flight steps, keyed per run+step. The
// server registers a controller while a step runs (and folds in the client's
// own cancel signal); chit_cancel aborts it. Cancellation is an explicit chit
// action, not a dependency on ambient Esc behavior.
export type StepControllers = Map<string, AbortController>;

export function controllerKey(runId: string, stepId: string): string {
	return `${runId}:${stepId}`;
}

export type CancelResult = "cancelled" | "already_done" | "not_running" | "unknown_step";

// Abort an in-flight step's controller if one is registered. The running
// runStep then rejects (its adapter kills the child) and the record settles to
// "cancelled" a tick later — chit_cancel reports what it could do right now.
export function cancelStep(run: Run, stepId: string, controllers: StepControllers): CancelResult {
	const rec = run.records[stepId];
	if (!rec) return "unknown_step";
	const controller = controllers.get(controllerKey(run.runId, stepId));
	if (controller) {
		controller.abort();
		return "cancelled";
	}
	if (rec.status === "done") return "already_done";
	return "not_running";
}

export async function runStep(
	run: Run,
	stepId: string,
	heartbeat: Heartbeat,
	signal?: AbortSignal,
): Promise<StepRecord> {
	const rec = run.records[stepId];
	if (!rec) throw new RuntimeError(`unknown step "${stepId}"`);
	// Only pending steps may run. running = in flight (reject duplicates);
	// done/failed/cancelled = terminal. This is the lock that makes "chit governs
	// legal order" mean a legal step also runs exactly once.
	if (rec.status === "running") throw new RuntimeError(`step "${stepId}" is already running`);
	if (rec.status === "done") throw new RuntimeError(`step "${stepId}" already ran`);
	if (rec.status === "failed")
		throw new RuntimeError(`step "${stepId}" previously failed (terminal)`);
	if (rec.status === "cancelled")
		throw new RuntimeError(`step "${stepId}" was cancelled (terminal)`);

	const deps = run.manifest.dependencies[stepId] ?? [];
	const undone = deps.filter((d) => run.records[d]?.status !== "done");
	if (undone.length > 0) {
		// The guardrail: chit decides what is legal to run next.
		throw new RuntimeError(`step "${stepId}" is not ready; waiting on: ${undone.join(", ")}`);
	}

	const step = run.manifest.steps[stepId];
	if (!step) throw new RuntimeError(`internal: step "${stepId}" missing`);
	// Mark running synchronously, BEFORE the first await, so a concurrent
	// runStep on the same step sees "running" and is rejected. This closes the
	// double-spawn hole: the record stayed "pending" through the whole call.
	rec.status = "running";
	const startedAt = Date.now();
	try {
		let output: string;
		if (step.kind === "format") {
			output = renderTemplate(step.format, run.preparedInputs, run.outputs);
		} else {
			const participant = run.manifest.participants[step.call];
			if (!participant) throw new RuntimeError(`internal: participant "${step.call}" missing`);
			const adapter = run.adapters[participant.agent];
			if (!adapter) throw new RuntimeError(`no adapter for agent "${participant.agent}"`);
			const prompt = renderTemplate(step.prompt, run.preparedInputs, run.outputs);
			const input = buildAgentInput(participant.role, prompt);
			// Heartbeat on a timer while the adapter call runs. Latest-state text,
			// not a transcript (no adapter event streaming in the spike).
			const iv = setInterval(() => {
				const elapsed = Math.round((Date.now() - startedAt) / 1000);
				heartbeat(
					`${stepId} · ${step.call} (${participant.agent}) still running · ${elapsed}s elapsed`,
				);
			}, 5000);
			try {
				const result = await adapter.call({
					participantId: step.call,
					agentId: participant.agent,
					stepId,
					input,
					cwd: run.invocationCwd,
					signal,
				});
				output = result.output;
			} finally {
				clearInterval(iv);
			}
		}
		rec.status = "done";
		rec.durationMs = Date.now() - startedAt;
		rec.output = output;
		run.outputs[stepId] = output;
		return rec;
	} catch (e) {
		// Discriminate on the signal, not the error shape: an aborted call is a
		// cancellation (the user stopped it), distinct from a real failure.
		rec.status = signal?.aborted ? "cancelled" : "failed";
		rec.durationMs = Date.now() - startedAt;
		rec.error = e instanceof Error ? e.message : String(e);
		throw e;
	}
}
