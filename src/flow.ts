// Composition: run a flow routine by running OTHER routines in order, mapping the
// flow's inputs and earlier steps' outputs into each one's inputs.
//
// v1 contract (deliberately strict, so it adds NO new write-safety surface):
//   - sub-routines are one-shot or converge (no nested flows -> no cycles).
//   - AT MOST ONE converge step, and it MUST be the last step.
//   - one-shot steps run in the caller cwd unsandboxed, so they must be read-only
//     (no read-write participant). Only the terminal converge step may write, and
//     it does so inside its own disposable worktree (dry-run by default, --apply).
// These config-aware checks live in resolveFlow, not in pure manifest parsing.
//
// Honesty about receipts: the FlowReceipt itself is body-free (step ids, sub-run
// ids, statuses, elapsed). But each one-shot sub-run's own receipt still stores
// its final output, exactly as a standalone one-shot run does -- the bodies live
// in those sub-receipts, not in the flow receipt.

import type { Adapter } from "./adapter.ts";
import type { CheckRunner } from "./check-runner.ts";
import type { ConvergeReceipt } from "./converge.ts";
import { runConvergeInSandbox } from "./converge-run.ts";
import { validateInputs } from "./inputs.ts";
import type { FlowManifest, Policy } from "./manifest.ts";
import { type ResolvedRoutine, resolveRoutine, RoutineError } from "./routine.ts";
import { type RunReceipt, runOneShot } from "./run.ts";
import type { SandboxFactory } from "./sandbox.ts";
import { renderTemplate } from "./template.ts";

export interface ResolvedFlowStep {
	id: string;
	inputs: Record<string, string>;
	routine: ResolvedRoutine;
}

export interface ResolvedFlow {
	flow: ResolvedRoutine;
	steps: ResolvedFlowStep[];
}

function stepRefs(template: string): string[] {
	const out: string[] = [];
	const re = /\{\{\s*steps\.([a-zA-Z0-9_-]+)\.output\s*\}\}/g;
	let m: RegExpExecArray | null = re.exec(template);
	while (m !== null) {
		if (m[1]) out.push(m[1]);
		m = re.exec(template);
	}
	return out;
}

// Validate the graph and resolve every sub-routine. Config-aware on purpose.
export function resolveFlow(
	flowRoutine: ResolvedRoutine,
	resolve: (id: string) => ResolvedRoutine,
): ResolvedFlow {
	if (flowRoutine.manifest.policy !== "flow") {
		throw new Error("resolveFlow called with a non-flow routine");
	}
	const manifest: FlowManifest = flowRoutine.manifest;
	const steps: ResolvedFlowStep[] = [];
	const priorIds = new Set<string>();

	for (const [i, step] of manifest.steps.entries()) {
		const isLast = i === manifest.steps.length - 1;
		let sub: ResolvedRoutine;
		try {
			sub = resolve(step.routine);
		} catch (e) {
			throw new RoutineError(`flow ${JSON.stringify(flowRoutine.id)} step ${JSON.stringify(step.id)}: ${(e as Error).message}`);
		}
		if (sub.manifest.policy === "flow") {
			throw new RoutineError(`flow step ${JSON.stringify(step.id)}: nested flows are not supported in v1 (${JSON.stringify(step.routine)} is a flow)`);
		}
		for (const template of Object.values(step.inputs)) {
			for (const ref of stepRefs(template)) {
				if (!priorIds.has(ref)) {
					throw new RoutineError(`flow step ${JSON.stringify(step.id)}: input references step ${JSON.stringify(ref)}, which is not an earlier step`);
				}
			}
		}
		if (sub.manifest.policy === "converge") {
			// "Must be last" also enforces "at most one": only the final step may be
			// converge, so a second converge step is necessarily not-last and is caught here.
			if (!isLast) {
				throw new RoutineError(`flow ${JSON.stringify(flowRoutine.id)}: the converge step ${JSON.stringify(step.id)} must be the last step (a flow has at most one converge step)`);
			}
		} else {
			const writer = Object.values(sub.manifest.participants).find((p) => p.filesystem === "read-write");
			if (writer !== undefined) {
				throw new RoutineError(`flow step ${JSON.stringify(step.id)} (${JSON.stringify(sub.id)}): a one-shot flow step must be read-only -- participant ${JSON.stringify(writer.id)} is read-write, and one-shot steps run in your tree unsandboxed. Only the terminal converge step may write.`);
			}
		}
		steps.push({ id: step.id, inputs: step.inputs, routine: sub });
		priorIds.add(step.id);
	}
	return { flow: flowRoutine, steps };
}

export interface FlowStepReceipt {
	id: string;
	routine: string;
	policy: Policy;
	subRunId: string;
	status: string;
	elapsedMs: number;
}

export interface FlowReceipt {
	runId: string;
	routineId: string;
	policy: "flow";
	scope?: string;
	digest: string;
	inputs: Record<string, string>;
	startedAt: number;
	finishedAt: number;
	elapsedMs: number;
	status: "completed" | "failed";
	steps: FlowStepReceipt[];
	error?: string;
}

export interface FlowRunResult {
	receipt: FlowReceipt;
	// Sub-run receipts for the caller to persist (so `chit trace <subRunId>` works).
	// One-shot sub-receipts contain their final output body; the flow receipt does not.
	subReceipts: Array<RunReceipt | ConvergeReceipt>;
	terminalDiff?: string;
	applied?: boolean;
}

export interface FlowDeps {
	adapter: Adapter;
	checkRunner: CheckRunner;
	sandboxFactory: SandboxFactory;
	cwd: string;
	now: () => number;
	newRunId: () => string;
	maxWallMs?: number;
	apply: boolean;
}

export async function runFlow(
	resolved: ResolvedFlow,
	values: Record<string, string>,
	deps: FlowDeps,
	opts: { scope?: string } = {},
): Promise<FlowRunResult> {
	const runId = deps.newRunId();
	const startedAt = deps.now();
	const ctx = { inputs: values, steps: {} as Record<string, { output: string }> };
	const stepReceipts: FlowStepReceipt[] = [];
	const subReceipts: Array<RunReceipt | ConvergeReceipt> = [];
	let failed: string | undefined;
	let terminalDiff: string | undefined;
	let applied: boolean | undefined;

	for (const step of resolved.steps) {
		const stepStart = deps.now();
		const policy = step.routine.manifest.policy;

		const mapped: Record<string, string> = {};
		for (const [name, template] of Object.entries(step.inputs)) mapped[name] = renderTemplate(template, ctx);

		const validation = validateInputs(step.routine.manifest, mapped);
		if (!validation.ok) {
			failed = `step ${step.id} (${step.routine.id}): ${validation.errors.join("; ")}`;
			stepReceipts.push({ id: step.id, routine: step.routine.id, policy, subRunId: "", status: "failed", elapsedMs: deps.now() - stepStart });
			break;
		}

		if (policy === "converge") {
			const r = await runConvergeInSandbox(
				step.routine,
				validation.values,
				{
					sandboxFactory: deps.sandboxFactory,
					adapter: deps.adapter,
					checkRunner: deps.checkRunner,
					cwd: deps.cwd,
					now: deps.now,
					newRunId: deps.newRunId,
					...(deps.maxWallMs !== undefined && { maxWallMs: deps.maxWallMs }),
					apply: deps.apply,
				},
			);
			subReceipts.push(r.receipt);
			terminalDiff = r.diff;
			applied = r.applied;
			ctx.steps[step.id] = { output: r.diff };
			stepReceipts.push({ id: step.id, routine: step.routine.id, policy, subRunId: r.receipt.runId, status: r.receipt.status, elapsedMs: deps.now() - stepStart });
			if (r.receipt.status !== "converged") {
				failed = `step ${step.id} (${step.routine.id}) ${r.receipt.status}`;
				break;
			}
		} else {
			const r = await runOneShot(step.routine, validation.values, {
				adapter: deps.adapter,
				cwd: deps.cwd,
				now: deps.now,
				newRunId: deps.newRunId,
			});
			subReceipts.push(r);
			ctx.steps[step.id] = { output: r.output ?? "" };
			stepReceipts.push({ id: step.id, routine: step.routine.id, policy, subRunId: r.runId, status: r.status, elapsedMs: deps.now() - stepStart });
			if (r.status !== "completed") {
				failed = `step ${step.id} (${step.routine.id}) ${r.status}`;
				break;
			}
		}
	}

	const finishedAt = deps.now();
	return {
		receipt: {
			runId,
			routineId: resolved.flow.id,
			policy: "flow",
			...(opts.scope !== undefined && { scope: opts.scope }),
			digest: resolved.flow.digest,
			inputs: values,
			startedAt,
			finishedAt,
			elapsedMs: finishedAt - startedAt,
			status: failed === undefined ? "completed" : "failed",
			steps: stepReceipts,
			...(failed !== undefined && { error: failed }),
		},
		subReceipts,
		...(terminalDiff !== undefined && { terminalDiff }),
		...(applied !== undefined && { applied }),
	};
}
