// The sandboxed execution path (internally "converge"). Run the routine's ordered
// steps repeatedly until every check
// step passes, or maxIterations is hit. State threads across iterations through a
// persistent context -- a check step's combined failing output becomes its
// `output`, so the NEXT iteration's call steps can reference {{ steps.verify.output }}
// and react to the failures. That feedback IS the loop.
//
// Like runOneShot, this does no disk IO and takes an injected clock, id, adapter,
// and check-runner, so it is fully deterministic under test with fakes. No real
// model call and no real check run happen in the test suite.

import type { Adapter } from "./adapter.ts";
import type { CheckRunner } from "./check-runner.ts";
import { effectiveCallTimeoutMs, effectiveRunTimeoutMs, type Manifest } from "./manifest.ts";
import type { ResolvedRoutine } from "./routine.ts";
import { renderTemplate } from "./template.ts";

export interface CheckReceipt {
	command: string;
	ok: boolean;
	startedAt: number;
	elapsedMs: number;
}

export interface ConvergeStepReceipt {
	id: string;
	kind: "call" | "format" | "check";
	participant?: string;
	// The agent id plus the resolved binding it ran on (see StepReceipt).
	agent?: string;
	adapter?: string;
	model?: string;
	status: "ok" | "failed" | "cancelled";
	// Absolute clock when the step started (see StepReceipt) -- the timeline source.
	startedAt: number;
	elapsedMs: number;
	checks?: CheckReceipt[];
	error?: string;
}

export interface IterationReceipt {
	n: number;
	// Absolute clock when the iteration started, so trace can place it on the timeline.
	startedAt: number;
	steps: ConvergeStepReceipt[];
	allChecksPassed: boolean;
}

export interface ConvergeReceipt {
	runId: string;
	routineId: string;
	policy: "converge";
	scope?: string;
	digest: string;
	inputs: Record<string, string>;
	maxIterations: number;
	startedAt: number;
	finishedAt: number;
	elapsedMs: number;
	status: "converged" | "did-not-converge" | "failed" | "cancelled";
	iterations: IterationReceipt[];
	sandbox?: SandboxReceipt;
	error?: string;
	// Set when the run converged but applying the diff back to origin failed (e.g. a
	// dirty origin or a conflict). The run still succeeded in the sandbox and still
	// leaves this durable receipt; only the write-back failed.
	applyError?: string;
}

export interface SandboxReceipt {
	workDir: string;
	status: string[];
	diffStat?: string;
}

export interface ConvergeDeps {
	adapter: Adapter;
	checkRunner: CheckRunner;
	cwd: string;
	now: () => number;
	newRunId: () => string;
	// Override for the manifest's maxIterations (e.g. a config default). Clamped.
	maxIterations?: number;
	// A hard wall-time bound for the whole loop; checked before each iteration. With
	// the per-call timeout this keeps a slow-but-not-hung run from running unbounded.
	maxWallMs?: number;
	diffProvider?: () => Promise<string> | string;
	onProgress?: (line: string) => void;
	// Operator-cancellation signal (Ctrl-C). Checked between iterations and steps, and
	// threaded into calls/checks so an in-flight subprocess is killed promptly.
	signal?: AbortSignal;
}

const DEFAULT_MAX_ITERATIONS = 5;
const ITERATION_CEILING = 20;

// The sandbox diff is fed into review prompts via {{ diff }}. A large diff is a
// prompt-budget (token + latency) risk, so cap what reaches the model. The full
// diff is still shown to the operator and stored in the diffstat; only the prompt
// copy is bounded.
export const MAX_DIFF_PROMPT_CHARS = 20_000;

export function capDiffForPrompt(diff: string): string {
	if (diff.length <= MAX_DIFF_PROMPT_CHARS) return diff;
	return `${diff.slice(0, MAX_DIFF_PROMPT_CHARS)}\n... [diff truncated for prompt budget: ${diff.length} chars total]`;
}

// A sandboxed execution routine with no `repeat` runs exactly once; with `repeat`
// it loops up to its maxIterations (config override beats manifest beats default).
export function effectiveMaxIterations(manifest: Manifest, override?: number): number {
	if (manifest.repeat === undefined) return 1;
	const chosen = override ?? manifest.repeat.maxIterations ?? DEFAULT_MAX_ITERATIONS;
	return Math.max(1, Math.min(ITERATION_CEILING, chosen));
}

export async function runConverge(
	routine: ResolvedRoutine,
	values: Record<string, string>,
	deps: ConvergeDeps,
	opts: { scope?: string } = {},
): Promise<ConvergeReceipt> {
	const manifest: Manifest = routine.manifest;
	// A call step's agent id and the adapter/model it resolves to, recorded on every call
	// receipt (ok, failed, AND cancelled) so trace proves what ran.
	const callBinding = (participantId: string): { agent?: string; adapter?: string; model?: string } => {
		const agentId = manifest.participants[participantId]?.agent;
		if (agentId === undefined) return {};
		const b = routine.agents?.[agentId];
		return { agent: agentId, ...(b !== undefined && { adapter: b.adapter, ...(b.model !== undefined && { model: b.model }) }) };
	};
	const callTimeoutMs = effectiveCallTimeoutMs(manifest);
	// Whole-run wall-time: an explicit deps override (config), else the routine's
	// limits, else the default. Undefined means no bound ("none").
	const maxWallMs = deps.maxWallMs ?? effectiveRunTimeoutMs(manifest);
	const maxIterations = effectiveMaxIterations(manifest, deps.maxIterations);
	const runId = deps.newRunId();
	const startedAt = deps.now();

	// Persistent across iterations: every step id pre-seeded to "" so a
	// cross-iteration reference renders empty on iteration 1 (a typo'd id still throws).
	const ctx: { inputs: Record<string, string>; steps: Record<string, { output: string }>; iteration: number; diff?: string } = {
		inputs: values,
		steps: Object.fromEntries(manifest.steps.map((s) => [s.id, { output: "" }])),
		iteration: 0,
	};

	const iterations: IterationReceipt[] = [];
	let runError: string | undefined;
	let converged = false;
	let cancelled = false;

	for (let n = 1; n <= maxIterations && runError === undefined && !converged && !cancelled; n++) {
		if (deps.signal?.aborted) {
			cancelled = true;
			break;
		}
		if (maxWallMs !== undefined && deps.now() - startedAt >= maxWallMs) {
			runError = `exceeded max wall-time of ${maxWallMs}ms after ${n - 1} iteration(s)`;
			break;
		}
		ctx.iteration = n;
		deps.onProgress?.(`iteration ${n}`);
		const iterationStart = deps.now();
		const stepReceipts: ConvergeStepReceipt[] = [];
		let allChecksPassed = true;

		for (const step of manifest.steps) {
			if (deps.signal?.aborted) {
				cancelled = true;
				break;
			}
			const stepStart = deps.now();
			try {
				if (deps.diffProvider !== undefined) ctx.diff = capDiffForPrompt(await deps.diffProvider());
				if (step.kind === "call") {
					const participant = manifest.participants[step.call];
					if (participant === undefined) throw new Error(`participant ${step.call} vanished`);
					deps.onProgress?.(`  call ${step.call} (${participant.agent})`);
						const result = await deps.adapter.call({
						agent: participant.agent,
						instructions: participant.instructions,
						prompt: renderTemplate(step.prompt, ctx),
						filesystem: participant.filesystem,
						cwd: deps.cwd,
						...(callTimeoutMs !== undefined && { timeoutMs: callTimeoutMs }),
						...(deps.signal !== undefined && { signal: deps.signal }),
					});
					ctx.steps[step.id] = { output: result.output };
					stepReceipts.push({
						id: step.id,
						kind: "call",
						participant: step.call,
						...callBinding(step.call),
						status: "ok",
						startedAt: stepStart,
						elapsedMs: deps.now() - stepStart,
					});
				} else if (step.kind === "format") {
					ctx.steps[step.id] = { output: renderTemplate(step.format, ctx) };
					stepReceipts.push({ id: step.id, kind: "format", status: "ok", startedAt: stepStart, elapsedMs: deps.now() - stepStart });
				} else if (step.kind === "check") {
					const checks: CheckReceipt[] = [];
					const failures: string[] = [];
					let stepPassed = true;
					for (const cmd of step.checks) {
						const checkStart = deps.now();
						const res = await deps.checkRunner.run(cmd, deps.cwd, callTimeoutMs, deps.signal);
						const label = [cmd.command, ...cmd.args].join(" ");
							deps.onProgress?.(`  check ${label} → ${res.ok ? "ok" : "fail"}`);
						checks.push({ command: label, ok: res.ok, startedAt: checkStart, elapsedMs: deps.now() - checkStart });
						if (!res.ok) {
							stepPassed = false;
							failures.push(`$ ${label}\n${res.output}`.trim());
						}
					}
					// Feed the failing output forward: next iteration's call steps read it.
					ctx.steps[step.id] = { output: failures.join("\n\n") };
					if (!stepPassed) allChecksPassed = false;
					stepReceipts.push({
						id: step.id,
						kind: "check",
						status: deps.signal?.aborted ? "cancelled" : stepPassed ? "ok" : "failed",
						startedAt: stepStart,
						elapsedMs: deps.now() - stepStart,
						checks,
						});
				} else {
					// An execution routine has no `routine` steps (those are a composition).
					throw new Error(`runConverge cannot run a ${step.kind} step (${step.id})`);
				}
			} catch (e) {
				const kind = step.kind === "routine" ? "check" : step.kind;
				// A call/check killed by the cancellation signal is a cancel, not a failure;
				// record the active step so the timeline shows what was interrupted.
				if (deps.signal?.aborted) {
					cancelled = true;
					stepReceipts.push({
						id: step.id,
						kind,
						...(step.kind === "call" && { participant: step.call, ...callBinding(step.call) }),
						status: "cancelled",
						startedAt: stepStart,
						elapsedMs: deps.now() - stepStart,
					});
					break;
				}
				runError = (e as Error).message;
				stepReceipts.push({
					id: step.id,
					kind,
					...(step.kind === "call" && { participant: step.call, ...callBinding(step.call) }),
					status: "failed",
					startedAt: stepStart,
					elapsedMs: deps.now() - stepStart,
					error: runError,
				});
				break;
			}
		}

		// An aborted check returns a flagged result rather than throwing, so the catch
		// above won't see it; treat a signal that fired during the iteration as a cancel.
		if (deps.signal?.aborted) cancelled = true;
		if (cancelled) {
			// Record the partial iteration (so the timeline shows how far it got and what
			// was active), but only if it actually began running steps.
			if (stepReceipts.length > 0) iterations.push({ n, startedAt: iterationStart, steps: stepReceipts, allChecksPassed: false });
			break;
		}
		iterations.push({ n, startedAt: iterationStart, steps: stepReceipts, allChecksPassed: runError === undefined && allChecksPassed });
		if (runError === undefined && allChecksPassed) converged = true;
	}

	const finishedAt = deps.now();
	return {
		runId,
		routineId: routine.id,
		policy: "converge",
		...(opts.scope !== undefined && { scope: opts.scope }),
		digest: routine.digest,
		inputs: values,
		maxIterations,
		startedAt,
		finishedAt,
		elapsedMs: finishedAt - startedAt,
		status: runError !== undefined ? "failed" : cancelled ? "cancelled" : converged ? "converged" : "did-not-converge",
		iterations,
		...(runError !== undefined && { error: runError }),
		...(cancelled && { error: "cancelled by operator" }),
	};
}
