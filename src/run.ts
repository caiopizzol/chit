// Run a non-sandboxed execution routine (pure call/format, read-only, no checks)
// once in the cwd, and return a receipt. This is the "text" path -- grill, plan.
// No disk IO; injected clock and id, so it is deterministic under test.
//
// (Sandboxed execution -- anything with checks or a read-write participant -- and
// composition go through converge.ts and flow.ts. Dispatch in cli.ts picks one.)

import type { Adapter } from "./adapter.ts";
import { effectiveCallTimeoutMs, effectiveRunTimeoutMs, type Manifest } from "./manifest.ts";
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
	// Internal receipt-kind tag (the manifest has no policy); discriminates the
	// stored-receipt union. "one-shot" = a single text run.
	policy: "one-shot";
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
	// Optional live-progress sink: one line per notable event, so a multi-minute
	// run is not a black box. The bin prints these to stderr as they happen.
	onProgress?: (line: string) => void;
}

export async function runOneShot(
	routine: ResolvedRoutine,
	values: Record<string, string>,
	deps: RunDeps,
	opts: { scope?: string } = {},
): Promise<RunReceipt> {
	const manifest: Manifest = routine.manifest;
	const callTimeoutMs = effectiveCallTimeoutMs(manifest);
	// Whole-run wall-time bound (undefined = "none"). Same meaning as on the loop and
	// composition paths; a text run is short, but keeping the bound here means a routine
	// that sets runTimeoutMinutes is never silently ignored.
	const maxWallMs = effectiveRunTimeoutMs(manifest);
	const runId = deps.newRunId();
	const startedAt = deps.now();

	const ctx = { inputs: values, steps: {} as Record<string, { output: string }> };
	const steps: StepReceipt[] = [];
	let failed: string | undefined;

	for (const step of manifest.steps) {
		if (maxWallMs !== undefined && deps.now() - startedAt >= maxWallMs) {
			failed = `exceeded max wall-time of ${maxWallMs}ms`;
			break;
		}
		const stepStart = deps.now();
		try {
			if (step.kind === "call") {
				const participant = manifest.participants[step.call];
				if (participant === undefined) throw new Error(`participant ${step.call} vanished`);
				deps.onProgress?.(`  call ${step.call} (${participant.agent}) …`);
				const result = await deps.adapter.call({
					agent: participant.agent,
					instructions: participant.instructions,
					prompt: renderTemplate(step.prompt, ctx),
					filesystem: participant.filesystem,
					cwd: deps.cwd,
					...(callTimeoutMs !== undefined && { timeoutMs: callTimeoutMs }),
				});
				ctx.steps[step.id] = { output: result.output };
				steps.push({ id: step.id, kind: "call", participant: step.call, agent: participant.agent, status: "ok", elapsedMs: deps.now() - stepStart });
			} else if (step.kind === "format") {
				ctx.steps[step.id] = { output: renderTemplate(step.format, ctx) };
				steps.push({ id: step.id, kind: "format", status: "ok", elapsedMs: deps.now() - stepStart });
			} else {
				// A non-sandboxed text routine has only call/format steps (dispatch guarantees it).
				throw new Error(`runOneShot cannot run a ${step.kind} step (${step.id})`);
			}
		} catch (e) {
			failed = (e as Error).message;
			steps.push({
				id: step.id,
				kind: step.kind === "call" ? "call" : "format",
				...(step.kind === "call" && { participant: step.call }),
				status: "failed",
				elapsedMs: deps.now() - stepStart,
				error: failed,
			});
			break;
		}
	}

	const finishedAt = deps.now();
	const outputId = manifest.output ?? manifest.steps.at(-1)?.id;
	const output = outputId !== undefined ? ctx.steps[outputId]?.output : undefined;
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
