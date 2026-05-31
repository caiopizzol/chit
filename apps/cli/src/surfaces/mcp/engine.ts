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
	resolveParticipantSnapshots,
} from "@chit/core";
import { buildAdapter } from "../../adapters/factory.ts";
import { AuditRecorder } from "../../audit/recorder.ts";
import { AuditStore } from "../../audit/store.ts";
import { wrapAdaptersWithAudit } from "../../audit/wrap.ts";
import { buildAgentInput } from "../../runtime/execute.ts";
import {
	type PreparedInputs,
	prepareInputs,
	RuntimeError,
	renderTemplate,
} from "../../runtime/render.ts";
import type { AdapterMap } from "../../runtime/types.ts";
import { wrapAdaptersWithSessions } from "../../sessions/coordinator.ts";
import { defaultSessionDir, FileSessionStore, legacySessionDir } from "../../sessions/store.ts";

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
	// Set when chit_start was called with audit:true and the run started cleanly.
	// runStep drives it (step.* + run.completed); adapter.call.* come from the
	// audit-wrapped adapters. Absent = unaudited run.
	recorder?: AuditRecorder;
	// Wall-clock start, for the run.completed duration. Always set.
	startedAtMs: number;
}

export type Heartbeat = (message: string) => void;

export interface StartRunOptions {
	rawManifest: unknown;
	inputs: Record<string, unknown>;
	registry: NormalizedRegistry;
	scope?: string;
	invocationCwd: string;
	allowUnenforcedPermissions: boolean;
	// Opt-in audit: persist a full run (prompts/outputs/usage as blobs) to the
	// audit store, keyed by this run's id. Off by default. auditStore is
	// injectable for tests; defaults to the real local-state store.
	audit?: boolean;
	auditStore?: AuditStore;
	// Wall-clock now, injectable for deterministic tests. Defaults to Date.now.
	now?: () => number;
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

	// A per_scope manifest needs a scope to persist sessions. Without one it
	// would silently run stateless — reject instead so the caller passes a scope.
	const needsScope = Object.values(manifest.participants).some((p) => p.session === "per_scope");
	if (needsScope && opts.scope === undefined) {
		throw new RuntimeError(
			`manifest "${manifest.id}" has per_scope participant(s); a scope is required (pass scope to chit_start)`,
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

	// Prepare inputs BEFORE starting audit: prepareInputs throws on unknown /
	// missing / wrong-type / missing-file inputs, and a chit_start that fails
	// validation must not leave an orphan run.started in the audit log.
	const preparedInputs = prepareInputs(manifest.inputs, opts.inputs, opts.invocationCwd);

	// Opt-in audit: only reached after all validation above, so run.started is
	// emitted for a viable run, not a rejected chit_start. The audit wrapper sits
	// BENEATH the session wrapper so the recorder sees injected/returned sessions.
	// The audit runId reuses this run's id, so MCP run_id == audit run.
	let recorder: AuditRecorder | undefined;
	let adapters = baseAdapters;
	if (opts.audit) {
		recorder = new AuditRecorder(
			opts.auditStore ?? new AuditStore(),
			runId,
			{
				manifestId: manifest.id,
				cwd: opts.invocationCwd,
				surface: "mcp",
				...(opts.scope !== undefined && { scope: opts.scope }),
				participants: resolveParticipantSnapshots(manifest, opts.registry),
			},
			opts.now,
		);
		recorder.runStarted();
		adapters = wrapAdaptersWithAudit(adapters, recorder);
	}
	if (opts.scope !== undefined) {
		adapters = wrapAdaptersWithSessions(
			adapters,
			manifest,
			opts.registry,
			opts.scope,
			new FileSessionStore(defaultSessionDir(), legacySessionDir()),
		);
	}

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
		recorder,
		startedAtMs: (opts.now ?? Date.now)(),
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

// Complete only when EVERY step is done — not just the output step. An
// independent branch that does not feed `output` must not let the run report
// complete while it is still pending (or failed/cancelled).
export function isComplete(run: Run): boolean {
	return Object.values(run.records).every((r) => r.status === "done");
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
	controller?: AbortController,
	controllers?: StepControllers,
): Promise<StepRecord> {
	const rec = run.records[stepId];
	if (!rec) throw new RuntimeError(`unknown step "${stepId}"`);
	// Only pending steps may run. running = in flight (reject duplicates);
	// done/failed/cancelled = terminal. This is the lock that makes "chit governs
	// legal order" mean a legal step also runs exactly once. These checks run
	// BEFORE any controller registration, so a rejected duplicate never touches
	// the registry and cannot clobber the in-flight step's controller.
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
	const signal = controller?.signal;
	// Mark running synchronously, BEFORE the first await, so a concurrent
	// runStep on the same step sees "running" and is rejected. This closes the
	// double-spawn hole: the record stayed "pending" through the whole call.
	rec.status = "running";
	// Register the cancel controller now that THIS call owns the step (atomic
	// with the lock above, still before the first await). chit_cancel resolves
	// the in-flight step through this registry; registering here, not in the
	// caller before the lock, is what keeps a rejected duplicate from
	// overwriting then deleting it.
	const key = controllerKey(run.runId, stepId);
	if (controller && controllers) controllers.set(key, controller);
	const startedAt = Date.now();
	// Audit (best-effort, swallowed): the step is now officially running. Paired
	// with the stepCompleted/stepFailed below on settle. adapter.call.* events
	// come from the audit-wrapped adapter during the call itself.
	run.recorder?.stepStarted(stepId, rec.kind, {
		participantId: rec.participantId,
		agentId: rec.agentId,
		session: rec.session,
	});
	try {
		// Cancel may have landed between readiness and here.
		if (signal?.aborted) throw new RuntimeError(`step "${stepId}" cancelled before start`);
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
		// Cancel may have landed while the call was completing (or an adapter
		// ignored the signal and returned anyway). Don't commit a cancelled step
		// as done.
		if (signal?.aborted) throw new RuntimeError(`step "${stepId}" cancelled`);
		rec.status = "done";
		rec.durationMs = Date.now() - startedAt;
		rec.output = output;
		run.outputs[stepId] = output;
		run.recorder?.stepCompleted(stepId, rec.durationMs, output);
		// The whole run is complete only when EVERY step is done. A failed/cancelled
		// step never reaches this, so run.completed marks a fully successful run; a
		// failed or abandoned run has no run.completed (its step.failed is the signal).
		if (run.recorder && isComplete(run)) {
			run.recorder.runCompleted("ok", Math.max(0, Date.now() - run.startedAtMs));
			// Terminal point: the run is fully done, so retention is safe here (no
			// step can still append). Never prunes this run.
			run.recorder.prune();
		}
		return rec;
	} catch (e) {
		// Discriminate on the signal, not the error shape: an aborted call is a
		// cancellation (the user stopped it), distinct from a real failure.
		rec.status = signal?.aborted ? "cancelled" : "failed";
		rec.durationMs = Date.now() - startedAt;
		rec.error = e instanceof Error ? e.message : String(e);
		// Audit the terminal step: a cancelled step is recorded as step.failed with
		// its cancellation reason (the schema has no step.cancelled).
		run.recorder?.stepFailed(stepId, rec.error, rec.durationMs);
		throw e;
	} finally {
		// Unregister, but only if we still own the slot. The lock prevents another
		// call from registering this key while we run, so the guard is defensive.
		if (controller && controllers && controllers.get(key) === controller) {
			controllers.delete(key);
		}
	}
}
