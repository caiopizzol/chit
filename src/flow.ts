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
import { type ConvergeReceipt, runConverge } from "./converge.ts";
import { runConvergeInSandbox } from "./converge-run.ts";
import { validateInputs } from "./inputs.ts";
import { effectiveRunTimeoutMs, isComposition, isSandboxed, type Manifest } from "./manifest.ts";
import { type ResolvedRoutine, resolveRoutine, RoutineError } from "./routine.ts";
import { type RunReceipt, runOneShot } from "./run.ts";
import type { SandboxFactory } from "./sandbox.ts";
import { renderTemplate } from "./template.ts";

// A composition step is either a sub-routine to run or an `ask` gate that pauses for
// one operator answer (fed forward via {{ steps.<id>.output }}, like a sub-run's output).
export type ResolvedFlowStep =
	| { id: string; kind: "routine"; inputs: Record<string, string>; routine: ResolvedRoutine }
	| { id: string; kind: "ask"; ask: string };

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

	// Validate every template ref in a composition step (its sub-routine inputs, or an
	// ask question): a {{ steps.X.output }} must name an earlier step, a {{ inputs.Y }}
	// must be a declared input. Shared by routine and ask steps so an ask can reference
	// earlier outputs (e.g. "approve this plan: {{ steps.plan.output }}").
	const checkRefs = (template: string, stepId: string): void => {
		for (const ref of stepRefs(template)) {
			if (!priorIds.has(ref)) {
				throw new RoutineError(`composition step ${JSON.stringify(stepId)}: references step ${JSON.stringify(ref)}, which is not an earlier step`);
			}
		}
		for (const ref of inputRefs(template)) {
			if (!(ref in manifest.inputs)) {
				throw new RoutineError(`composition step ${JSON.stringify(stepId)}: references {{ inputs.${ref} }}, which is not a declared input`);
			}
		}
	};

	for (const [i, step] of manifest.steps.entries()) {
		if (step.kind === "ask") {
			// A decision gate between sub-routines: pauses for one operator answer, fed
			// forward like any step output. It launches no sub-run and writes nothing.
			checkRefs(step.ask, step.id);
			steps.push({ id: step.id, kind: "ask", ask: step.ask });
			priorIds.add(step.id);
			continue;
		}
		if (step.kind !== "routine") throw new Error("composition step must be a routine or ask step");
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
		for (const template of Object.values(step.inputs)) checkRefs(template, step.id);
		// A sandboxed sub-routine (writes or runs checks) must be the LAST step, and a
		// composition has at most one (a non-last sandboxed step is caught here). Earlier
		// steps must be pure read-only/text, so the composition adds no write surface.
		if (isSandboxed(sub.manifest) && !isLast) {
			throw new RoutineError(`composition ${JSON.stringify(flowRoutine.id)}: step ${JSON.stringify(step.id)} (${JSON.stringify(sub.id)}) writes or runs checks, so it must be the LAST step; earlier steps must be read-only/text.`);
		}
		steps.push({ id: step.id, kind: "routine", inputs: step.inputs, routine: sub });
		priorIds.add(step.id);
	}
	return { flow: flowRoutine, steps };
}

// A routine step records the sub-run it launched; an `ask` step records only status +
// timing (the answer is never persisted). `kind` is optional on the routine variant so
// legacy flow receipts (written before ask existed, with no `kind`) still type-check and
// render as routine steps.
export type FlowStepReceipt =
	| {
			id: string;
			kind?: "routine";
			routine: string;
			// The sub-run's receipt kind: "converge" for a sandboxed sub-routine, else "one-shot".
			policy: "one-shot" | "converge";
			subRunId: string;
			status: string;
			// Absolute clock when the sub-run started, so trace can place it on the timeline.
			startedAt: number;
			elapsedMs: number;
	  }
	| {
			id: string;
			kind: "ask";
			status: string;
			startedAt: number;
			elapsedMs: number;
	  };

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
	status: "completed" | "failed" | "cancelled";
	steps: FlowStepReceipt[];
	error?: string;
	// Set when the terminal sandboxed step converged but its write-back to origin failed.
	// Persisted here so `chit trace <flowRunId>` shows it, not just the sub-run's receipt.
	applyError?: string;
}

export interface FlowRunResult {
	receipt: FlowReceipt;
	// Sub-run receipts for the caller to persist (so `chit trace <subRunId>` works).
	// One-shot sub-receipts contain their final output body; the flow receipt does not.
	subReceipts: Array<RunReceipt | ConvergeReceipt>;
	terminalDiff?: string;
	applied?: boolean;
	// Set when the terminal sandboxed step converged but its write-back failed.
	applyError?: string;
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
	// Operator-cancellation signal (Ctrl-C). Checked before each sub-routine and
	// threaded into each sub-run so an in-flight call/check is killed promptly.
	signal?: AbortSignal;
	// Human-input seam for `ask` gates between sub-routines (the bin reads stdin; tests
	// inject a deterministic answer). Required only if the composition has an ask step.
	askUser?: (question: string) => Promise<string>;
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
	let cancelled = false;
	let terminalDiff: string | undefined;
	let applied: boolean | undefined;
	let applyError: string | undefined;

	for (const step of resolved.steps) {
		if (deps.signal?.aborted) {
			cancelled = true;
			break;
		}
		if (maxWallMs !== undefined && deps.now() - startedAt >= maxWallMs) {
			failed = `exceeded flow wall-time of ${maxWallMs}ms before step ${step.id}`;
			break;
		}
		const stepStart = deps.now();

		if (step.kind === "ask") {
			// A decision gate: pause for one operator answer, feed it forward. No sub-run,
			// no receipt body -- only status + timing land in the flow receipt.
			if (deps.askUser === undefined) {
				failed = `step ${step.id}: an ask gate needs an input handler, but none is wired`;
				stepReceipts.push({ id: step.id, kind: "ask", status: "failed", startedAt: stepStart, elapsedMs: deps.now() - stepStart });
				break;
			}
			deps.onProgress?.(`step ${step.id} (ask)`);
			let answer: string;
			try {
				answer = await deps.askUser(renderTemplate(step.ask, ctx));
			} catch (e) {
				// Ctrl-C during the prompt aborts the signal and rejects the ask -> a cancel.
				if (deps.signal?.aborted) {
					cancelled = true;
					stepReceipts.push({ id: step.id, kind: "ask", status: "cancelled", startedAt: stepStart, elapsedMs: deps.now() - stepStart });
					break;
				}
				failed = `step ${step.id} (ask): ${(e as Error).message}`;
				stepReceipts.push({ id: step.id, kind: "ask", status: "failed", startedAt: stepStart, elapsedMs: deps.now() - stepStart });
				break;
			}
			ctx.steps[step.id] = { output: answer };
			stepReceipts.push({ id: step.id, kind: "ask", status: "completed", startedAt: stepStart, elapsedMs: deps.now() - stepStart });
			continue;
		}

		deps.onProgress?.(`step ${step.id} -> ${step.routine.id}`);
		// Derived: a sub-routine that writes or runs checks is sandboxed (-> converge path);
		// otherwise it is a pure text run (-> one-shot path).
		const sandboxed = isSandboxed(step.routine.manifest);
		const looping = step.routine.manifest.repeat !== undefined;
		const policy: "one-shot" | "converge" = sandboxed || looping ? "converge" : "one-shot";

		const mapped: Record<string, string> = {};
		for (const [name, template] of Object.entries(step.inputs)) mapped[name] = renderTemplate(template, ctx);

		const validation = validateInputs(step.routine.manifest, mapped);
		if (!validation.ok) {
			failed = `step ${step.id} (${step.routine.id}): ${validation.errors.join("; ")}`;
			stepReceipts.push({ id: step.id, routine: step.routine.id, policy, subRunId: "", status: "failed", startedAt: stepStart, elapsedMs: deps.now() - stepStart });
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
					...(deps.signal !== undefined && { signal: deps.signal }),
					apply: deps.apply,
				},
				opts,
			);
			subReceipts.push(r.receipt);
			terminalDiff = r.diff;
			applied = r.applied;
			if (r.applyError !== undefined) applyError = r.applyError;
			ctx.steps[step.id] = { output: r.diff };
			stepReceipts.push({ id: step.id, routine: step.routine.id, policy, subRunId: r.receipt.runId, status: r.receipt.status, startedAt: stepStart, elapsedMs: deps.now() - stepStart });
			if (r.receipt.status === "cancelled") {
				cancelled = true;
				break;
			}
			if (r.receipt.status !== "converged") {
				failed = `step ${step.id} (${step.routine.id}) ${r.receipt.status}`;
				break;
			}
		} else if (looping) {
			// A non-sandboxed loop sub-routine (read-only, no checks, a { step, equals } repeat):
			// loop in the cwd (no worktree -- it writes nothing); its text result feeds forward.
			const r = await runConverge(
				step.routine,
				validation.values,
				{
					adapter: deps.adapter,
					checkRunner: deps.checkRunner,
					cwd: deps.cwd,
					now: deps.now,
					newRunId: deps.newRunId,
					...(step.routine.defaults?.maxIterations !== undefined && { maxIterations: step.routine.defaults.maxIterations }),
					...(deps.maxWallMs !== undefined && { maxWallMs: deps.maxWallMs }),
					...(deps.onProgress !== undefined && { onProgress: deps.onProgress }),
					...(deps.signal !== undefined && { signal: deps.signal }),
				},
				opts,
			);
			subReceipts.push(r);
			ctx.steps[step.id] = { output: r.output ?? "" };
			stepReceipts.push({ id: step.id, routine: step.routine.id, policy, subRunId: r.runId, status: r.status, startedAt: stepStart, elapsedMs: deps.now() - stepStart });
			if (r.status === "cancelled") {
				cancelled = true;
				break;
			}
			if (r.status !== "converged") {
				failed = `step ${step.id} (${step.routine.id}) ${r.status}`;
				break;
			}
		} else {
			const r = await runOneShot(
				step.routine,
				validation.values,
				{
					adapter: deps.adapter,
					cwd: deps.cwd,
					now: deps.now,
					newRunId: deps.newRunId,
					...(deps.onProgress !== undefined && { onProgress: deps.onProgress }),
					...(deps.signal !== undefined && { signal: deps.signal }),
					// Forward the input seam so a text sub-routine with its own ask gate behaves the
					// same composed as standalone (the routine model: behavior is shape, not context).
					...(deps.askUser !== undefined && { askUser: deps.askUser }),
				},
				opts,
			);
			subReceipts.push(r);
			ctx.steps[step.id] = { output: r.output ?? "" };
			stepReceipts.push({ id: step.id, routine: step.routine.id, policy, subRunId: r.runId, status: r.status, startedAt: stepStart, elapsedMs: deps.now() - stepStart });
			if (r.status === "cancelled") {
				cancelled = true;
				break;
			}
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
			status: cancelled ? "cancelled" : failed === undefined ? "completed" : "failed",
			steps: stepReceipts,
			...(failed !== undefined && { error: failed }),
			...(cancelled && { error: "cancelled by operator" }),
			...(applyError !== undefined && { applyError }),
		},
		subReceipts,
		...(terminalDiff !== undefined && { terminalDiff }),
		...(applied !== undefined && { applied }),
		...(applyError !== undefined && { applyError }),
	};
}
