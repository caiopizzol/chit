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
import { effectiveRunTimeoutMs, isComposition, isSandboxed, type Manifest } from "./manifest.ts";
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

function refsOf(template: string, re: RegExp): string[] {
	const out: string[] = [];
	let m: RegExpExecArray | null = re.exec(template);
	while (m !== null) {
		if (m[1]) out.push(m[1]);
		m = re.exec(template);
	}
	return out;
}

function stepRefs(template: string): string[] {
	return refsOf(template, /\{\{\s*steps\.([a-zA-Z0-9_-]+)\.output\s*\}\}/g);
}

function inputRefs(template: string): string[] {
	return refsOf(template, /\{\{\s*inputs\.([a-zA-Z0-9_-]+)\s*\}\}/g);
}

// Validate the graph and resolve every sub-routine. Config-aware on purpose.
export function resolveFlow(
	flowRoutine: ResolvedRoutine,
	resolve: (id: string) => ResolvedRoutine,
): ResolvedFlow {
	if (!isComposition(flowRoutine.manifest)) {
		throw new Error("resolveFlow called with a non-composition routine");
	}
	const manifest: Manifest = flowRoutine.manifest;
	const steps: ResolvedFlowStep[] = [];
	const priorIds = new Set<string>();

	for (const [i, step] of manifest.steps.entries()) {
		if (step.kind !== "routine") throw new Error("composition step must be a routine step");
		const isLast = i === manifest.steps.length - 1;
		let sub: ResolvedRoutine;
		try {
			sub = resolve(step.routine);
		} catch (e) {
			throw new RoutineError(`composition ${JSON.stringify(flowRoutine.id)} step ${JSON.stringify(step.id)}: ${(e as Error).message}`);
		}
		if (isComposition(sub.manifest)) {
			throw new RoutineError(`composition step ${JSON.stringify(step.id)}: ${JSON.stringify(step.routine)} is itself a composition -- nested composition is not supported (call execution routines only)`);
		}
		for (const template of Object.values(step.inputs)) {
			for (const ref of stepRefs(template)) {
				if (!priorIds.has(ref)) {
					throw new RoutineError(`composition step ${JSON.stringify(step.id)}: input references step ${JSON.stringify(ref)}, which is not an earlier step`);
				}
			}
			for (const ref of inputRefs(template)) {
				if (!(ref in manifest.inputs)) {
					throw new RoutineError(`composition step ${JSON.stringify(step.id)}: input references {{ inputs.${ref} }}, which is not a declared input`);
				}
			}
		}
		// A sandboxed sub-routine (writes or runs checks) must be the LAST step, and a
		// composition has at most one (a non-last sandboxed step is caught here). Earlier
		// steps must be pure read-only/text, so the composition adds no write surface.
		if (isSandboxed(sub.manifest) && !isLast) {
			throw new RoutineError(`composition ${JSON.stringify(flowRoutine.id)}: step ${JSON.stringify(step.id)} (${JSON.stringify(sub.id)}) writes or runs checks, so it must be the LAST step; earlier steps must be read-only/text.`);
		}
		steps.push({ id: step.id, inputs: step.inputs, routine: sub });
		priorIds.add(step.id);
	}
	return { flow: flowRoutine, steps };
}

export interface FlowStepReceipt {
	id: string;
	routine: string;
	// The sub-run's receipt kind: "converge" for a sandboxed sub-routine, else "one-shot".
	policy: "one-shot" | "converge";
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
	onProgress?: (line: string) => void;
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
	// Whole-flow wall-time budget: an explicit deps override, else the composition's
	// own `runTimeoutMinutes`, else the default. Checked before starting each step, so
	// a flow that blows its budget stops rather than launching the next sub-routine.
	// (Each sub-run is still bounded by its own limits; this caps the flow as a whole.)
	const maxWallMs = deps.maxWallMs ?? effectiveRunTimeoutMs(resolved.flow.manifest);
	const ctx = { inputs: values, steps: {} as Record<string, { output: string }> };
	const stepReceipts: FlowStepReceipt[] = [];
	const subReceipts: Array<RunReceipt | ConvergeReceipt> = [];
	let failed: string | undefined;
	let terminalDiff: string | undefined;
	let applied: boolean | undefined;

	for (const step of resolved.steps) {
		if (maxWallMs !== undefined && deps.now() - startedAt >= maxWallMs) {
			failed = `exceeded flow wall-time of ${maxWallMs}ms before step ${step.id}`;
			break;
		}
		const stepStart = deps.now();
		deps.onProgress?.(`step ${step.id} -> ${step.routine.id}`);
		// Derived: a sub-routine that writes or runs checks is sandboxed (-> converge path);
		// otherwise it is a pure text run (-> one-shot path).
		const sandboxed = isSandboxed(step.routine.manifest);
		const policy: "one-shot" | "converge" = sandboxed ? "converge" : "one-shot";

		const mapped: Record<string, string> = {};
		for (const [name, template] of Object.entries(step.inputs)) mapped[name] = renderTemplate(template, ctx);

		const validation = validateInputs(step.routine.manifest, mapped);
		if (!validation.ok) {
			failed = `step ${step.id} (${step.routine.id}): ${validation.errors.join("; ")}`;
			stepReceipts.push({ id: step.id, routine: step.routine.id, policy, subRunId: "", status: "failed", elapsedMs: deps.now() - stepStart });
			break;
		}

		if (sandboxed) {
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
					// Honor the sub-routine's config-level converge default, exactly as a
					// standalone `chit run` of it would -- so it behaves the same in a flow.
					...(step.routine.defaults?.maxIterations !== undefined && { maxIterations: step.routine.defaults.maxIterations }),
					...(deps.maxWallMs !== undefined && { maxWallMs: deps.maxWallMs }),
					...(deps.onProgress !== undefined && { onProgress: deps.onProgress }),
					apply: deps.apply,
				},
				opts,
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
			const r = await runOneShot(
				step.routine,
				validation.values,
				{ adapter: deps.adapter, cwd: deps.cwd, now: deps.now, newRunId: deps.newRunId, ...(deps.onProgress !== undefined && { onProgress: deps.onProgress }) },
				opts,
			);
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
