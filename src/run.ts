// Execute a one-shot routine: run its steps in order, calling the adapter for
// `call` steps and assembling text for `format` steps, then return a receipt of
// what happened. The executor itself does no disk IO and takes an injected clock
// and id -- so it is fully deterministic under test with a fake adapter.
//
// Converge execution is intentionally NOT here. A converge routine can be listed
// and inspected; running its loop (and the digest/drift safety that guards it) is
// the hardened runtime's job, not this proof's.

import type { Adapter } from "./adapter.ts";
import type { OneShotManifest, Policy } from "./manifest.ts";
import type { ResolvedRoutine } from "./routine.ts";
import { renderTemplate } from "./template.ts";

export interface StepReceipt {
	id: string;
	kind: "call" | "format";
	participant?: string;
	agent?: string;
	status: "ok" | "failed";
	elapsedMs: number;
	error?: string;
}

export interface RunReceipt {
	runId: string;
	routineId: string;
	policy: Policy;
	scope?: string;
	digest: string;
	inputs: Record<string, string>;
	startedAt: number;
	finishedAt: number;
	elapsedMs: number;
	status: "completed" | "failed";
	steps: StepReceipt[];
	output?: string;
	error?: string;
}

export interface RunDeps {
	adapter: Adapter;
	cwd: string;
	now: () => number;
	newRunId: () => string;
}

export async function runOneShot(
	routine: ResolvedRoutine,
	values: Record<string, string>,
	deps: RunDeps,
	opts: { scope?: string } = {},
): Promise<RunReceipt> {
	if (routine.manifest.policy !== "one-shot") {
		throw new Error("runOneShot called with a non-one-shot routine");
	}
	const manifest: OneShotManifest = routine.manifest;
	const runId = deps.newRunId();
	const startedAt = deps.now();

	const ctx = { inputs: values, steps: {} as Record<string, { output: string }> };
	const steps: StepReceipt[] = [];
	let failed: string | undefined;

	for (const step of manifest.steps) {
		const stepStart = deps.now();
		try {
			if (step.kind === "call") {
				const participant = manifest.participants[step.call];
				if (participant === undefined) throw new Error(`participant ${step.call} vanished`);
				const prompt = renderTemplate(step.prompt, ctx);
				const result = await deps.adapter.call({
					agent: participant.agent,
					instructions: participant.instructions,
					prompt,
					filesystem: participant.filesystem,
					cwd: deps.cwd,
				});
				ctx.steps[step.id] = { output: result.output };
				steps.push({
					id: step.id,
					kind: "call",
					participant: step.call,
					agent: participant.agent,
					status: "ok",
					elapsedMs: deps.now() - stepStart,
				});
			} else {
				ctx.steps[step.id] = { output: renderTemplate(step.format, ctx) };
				steps.push({ id: step.id, kind: "format", status: "ok", elapsedMs: deps.now() - stepStart });
			}
		} catch (e) {
			failed = (e as Error).message;
			steps.push({
				id: step.id,
				kind: step.kind,
				...(step.kind === "call" && { participant: step.call }),
				status: "failed",
				elapsedMs: deps.now() - stepStart,
				error: failed,
			});
			break;
		}
	}

	const finishedAt = deps.now();
	const output = ctx.steps[manifest.output]?.output;
	return {
		runId,
		routineId: routine.id,
		policy: "one-shot",
		...(opts.scope !== undefined && { scope: opts.scope }),
		digest: routine.digest,
		inputs: values,
		startedAt,
		finishedAt,
		elapsedMs: finishedAt - startedAt,
		status: failed === undefined ? "completed" : "failed",
		steps,
		...(failed === undefined && output !== undefined && { output }),
		...(failed !== undefined && { error: failed }),
	};
}
