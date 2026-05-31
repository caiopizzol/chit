import type { NormalizedManifest } from "@chit/core";
import { type PreparedInputs, prepareInputs, RuntimeError, renderTemplate } from "./render.ts";
import type { AdapterMap, ExecuteOptions, RunResult, TraceEvent } from "./types.ts";

export function buildAgentInput(role: string, prompt: string): string {
	return `Role:\n${role}\n\nTask:\n${prompt}`;
}

function checkAdaptersExist(manifest: NormalizedManifest, adapters: AdapterMap): void {
	const missing = new Map<string, string[]>();
	for (const [stepId, step] of Object.entries(manifest.steps)) {
		if (step.kind !== "call") continue;
		const participant = manifest.participants[step.call];
		if (!participant) continue;
		if (!(participant.agent in adapters)) {
			const list = missing.get(participant.agent) ?? [];
			list.push(`${stepId} (participant "${step.call}")`);
			missing.set(participant.agent, list);
		}
	}
	if (missing.size === 0) return;
	const lines: string[] = [];
	for (const [agent, refs] of missing) {
		lines.push(`  "${agent}" needed by: ${refs.join(", ")}`);
	}
	throw new RuntimeError(`no adapter registered for agent(s):\n${lines.join("\n")}`);
}

async function runStep(
	manifest: NormalizedManifest,
	stepId: string,
	preparedInputs: PreparedInputs,
	stepOutputs: Record<string, string>,
	adapters: AdapterMap,
	invocationCwd: string,
	onTrace: (event: TraceEvent) => void,
): Promise<string> {
	const step = manifest.steps[stepId];
	if (!step) throw new RuntimeError(`internal: step "${stepId}" not found`);
	// Date.now() is fine here: this is CLI runtime code, not a workflow script.
	const startedAt = Date.now();
	try {
		if (step.kind === "format") {
			onTrace({ type: "step.started", stepId, kind: "format" });
			const output = renderTemplate(step.format, preparedInputs, stepOutputs);
			onTrace({ type: "step.completed", stepId, output, durationMs: Date.now() - startedAt });
			return output;
		}

		const participant = manifest.participants[step.call];
		if (!participant) {
			throw new RuntimeError(`internal: participant "${step.call}" not found`);
		}
		const adapter = adapters[participant.agent];
		if (!adapter) {
			throw new RuntimeError(`no adapter for agent "${participant.agent}"`);
		}
		// Emit started AFTER rendering so the trace carries the exact prompt sent.
		const renderedPrompt = renderTemplate(step.prompt, preparedInputs, stepOutputs);
		onTrace({
			type: "step.started",
			stepId,
			kind: "call",
			participantId: step.call,
			agentId: participant.agent,
			session: participant.session,
			prompt: renderedPrompt,
		});
		const input = buildAgentInput(participant.role, renderedPrompt);
		const result = await adapter.call({
			participantId: step.call,
			agentId: participant.agent,
			stepId,
			input,
			cwd: invocationCwd,
			filesystem: participant.permissions.filesystem,
		});
		onTrace({
			type: "step.completed",
			stepId,
			output: result.output,
			durationMs: Date.now() - startedAt,
			...(result.usage && { usage: result.usage }),
		});
		return result.output;
	} catch (e) {
		const error = e instanceof Error ? e.message : String(e);
		onTrace({ type: "step.failed", stepId, error, durationMs: Date.now() - startedAt });
		throw e;
	}
}

export async function executeManifest(
	manifest: NormalizedManifest,
	options: ExecuteOptions,
): Promise<RunResult> {
	const trace: TraceEvent[] = [];
	const liveHook = options.onTrace;
	const recordEvent = (event: TraceEvent) => {
		trace.push(event);
		if (liveHook) liveHook(event);
	};

	const preparedInputs = prepareInputs(manifest.inputs, options.inputs, options.invocationCwd);
	checkAdaptersExist(manifest, options.adapters);

	const stepOutputs: Record<string, string> = {};

	for (const level of manifest.executionOrder) {
		const results = await Promise.allSettled(
			level.map((stepId) =>
				runStep(
					manifest,
					stepId,
					preparedInputs,
					stepOutputs,
					options.adapters,
					options.invocationCwd,
					recordEvent,
				),
			),
		);

		let firstFailure: { stepId: string; error: string } | null = null;
		for (let i = 0; i < results.length; i++) {
			const r = results[i];
			const stepId = level[i];
			if (!r || !stepId) continue;
			if (r.status === "rejected") {
				if (!firstFailure) {
					const e = r.reason;
					firstFailure = { stepId, error: e instanceof Error ? e.message : String(e) };
				}
			} else {
				stepOutputs[stepId] = r.value;
			}
		}

		if (firstFailure) {
			return {
				ok: false,
				failedStep: firstFailure.stepId,
				error: firstFailure.error,
				outputs: stepOutputs,
				trace,
			};
		}
	}

	const finalOutput = stepOutputs[manifest.output];
	if (finalOutput === undefined) {
		throw new RuntimeError(`internal: output step "${manifest.output}" produced no value`);
	}
	return { ok: true, output: finalOutput, outputs: stepOutputs, trace };
}
