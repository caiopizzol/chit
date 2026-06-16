// The loop executor (internally "converge"). Run the routine's ordered steps
// repeatedly until the `repeat.until` condition holds -- either every check step
// passes ("checks-pass") or a named step's output equals a target ({ step, equals },
// e.g. an evaluator call returns "yes") -- or maxIterations is hit. State threads
// across iterations through a persistent context: a check step's failing output (or
// an evaluator's critique) becomes that step's `output`, so the NEXT iteration's call
// steps can reference {{ steps.<id>.output }} and react. That feedback IS the loop.
//
// Looping is independent of the sandbox: this executor runs in whatever cwd it is
// given. A loop that writes or checks is wrapped in a worktree by runConvergeInSandbox;
// a pure read-only loop runs directly in the caller's cwd.
//
// Like runOneShot, this does no disk IO and takes an injected clock, id, adapter,
// and check-runner, so it is fully deterministic under test with fakes. No real
// model call and no real check run happen in the test suite.

import type { Adapter } from "./adapter.ts";
import type { CheckRunner } from "./check-runner.ts";
import { formatElapsed } from "./elapsed.ts";
import { effectiveCallTimeoutMs, effectiveRunTimeoutMs, type Manifest, type RepeatCondition, type RepeatUntil } from "./manifest.ts";
import type { ResolvedRoutine } from "./routine.ts";
import { evaluateStructured, readPath } from "./structured.ts";
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
	effort?: string;
	status: "ok" | "failed" | "cancelled";
	// Absolute clock when the step started (see StepReceipt) -- the timeline source.
	startedAt: number;
	elapsedMs: number;
	checks?: CheckReceipt[];
	// The validated structured output of a json call step (the convergence signal), if any.
	json?: unknown;
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
	// The exit condition this loop ran under (audit: what "converged" meant). Defaults to
	// "checks-pass" for a single-pass sandboxed routine that has no `repeat`.
	until: RepeatUntil;
	// The origin commit the sandbox started from (preflight requires a clean tree). Recorded
	// so `chit apply` can refuse to apply onto a different base.
	baseCommit?: string;
	startedAt: number;
	finishedAt: number;
	elapsedMs: number;
	status: "converged" | "did-not-converge" | "failed" | "cancelled";
	iterations: IterationReceipt[];
	// The loop's text result: the final-iteration output of its last call/format step (or the
	// declared `output`). Mainly for a non-sandboxed loop, whose result is text, not a diff.
	output?: string;
	sandbox?: SandboxReceipt;
	error?: string;
	// Set when the run converged but applying the diff back to origin failed (e.g. a
	// dirty origin or a conflict). The run still succeeded in the sandbox and still
	// leaves this durable receipt; only the write-back failed.
	applyError?: string;
	// Set when `chit apply` (or --auto-apply) applied this run's patch to the operator's tree. A
	// durable fact: `chit runs` keeps reading "applied" even after later commits move HEAD so the
	// stored patch no longer re-applies cleanly (the other statuses are derived live from git).
	appliedAt?: number;
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
	const callBinding = (participantId: string): { agent?: string; adapter?: string; model?: string; effort?: string } => {
		const agentId = manifest.participants[participantId]?.agent;
		if (agentId === undefined) return {};
		const b = routine.agents?.[agentId];
		return {
			agent: agentId,
			...(b !== undefined && {
				adapter: b.adapter,
				...(b.model !== undefined && { model: b.model }),
				...(b.effort !== undefined && { effort: b.effort }),
			}),
		};
	};
	const callTimeoutMs = effectiveCallTimeoutMs(manifest);
	// Whole-run wall-time: an explicit deps override (config), else the routine's
	// limits, else the default. Undefined means no bound ("none").
	const maxWallMs = deps.maxWallMs ?? effectiveRunTimeoutMs(manifest);
	const maxIterations = effectiveMaxIterations(manifest, deps.maxIterations);
	// The exit condition. A routine with no `repeat` runs once with checks-pass semantics
	// (a single-pass sandboxed run converges iff its checks pass / it has none).
	const until: RepeatUntil = manifest.repeat?.until ?? "checks-pass";
	const runId = deps.newRunId();
	const startedAt = deps.now();

	// Persistent across iterations: every step id pre-seeded to "" so a
	// cross-iteration reference renders empty on iteration 1 (a typo'd id still throws).
	const ctx: { inputs: Record<string, string>; steps: Record<string, { output: string; json?: unknown }>; iteration: number; diff?: string } = {
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
		// A step that fails this iteration without aborting the run (today: a structured-output
		// step whose JSON fails validation) must block convergence even when the until condition
		// does not read that step -- a declared schema is a contract, so a violation is not "done".
		let iterationHadStepFailure = false;

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
					deps.onProgress?.(`  call ${step.call} done in ${formatElapsed(deps.now() - stepStart)}`);
					// Structured output: parse + validate the model's text against the declared schema.
					// A soft failure (call succeeded, output did not match) is NOT a runError -- store the
					// error as this step's output so the next iteration can show the model what to fix.
					let callStatus: "ok" | "failed" = "ok";
					let callError: string | undefined;
					let callJson: unknown;
					if (step.json !== undefined) {
						const ev = evaluateStructured(result.output, step.json.schema);
						if (ev.ok) {
							ctx.steps[step.id] = { output: ev.normalized, json: ev.value };
							callJson = ev.value;
						} else {
							ctx.steps[step.id] = { output: ev.error };
							callStatus = "failed";
							iterationHadStepFailure = true;
							callError = ev.error;
							deps.onProgress?.(`  call ${step.call} output did not match its schema`);
						}
					} else {
						ctx.steps[step.id] = { output: result.output };
					}
					stepReceipts.push({
						id: step.id,
						kind: "call",
						participant: step.call,
						...callBinding(step.call),
						status: callStatus,
						startedAt: stepStart,
						elapsedMs: deps.now() - stepStart,
						...(callJson !== undefined && { json: callJson }),
						...(callError !== undefined && { error: callError }),
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
						const checkElapsed = deps.now() - checkStart;
						deps.onProgress?.(`  check ${label} → ${res.ok ? "ok" : "fail"} in ${formatElapsed(checkElapsed)}`);
						checks.push({ command: label, ok: res.ok, startedAt: checkStart, elapsedMs: checkElapsed });
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
				// Only call/format/check reach the sandbox path (Rule 4 keeps ask out, and a
				// routine step is a composition); map anything else to "check" defensively.
				const kind = step.kind === "call" || step.kind === "format" || step.kind === "check" ? step.kind : "check";
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
		// Did this iteration meet the exit condition? checks-pass = every check passed;
		// { step, equals } = that step's (trimmed) output equals the target (e.g. an evaluator
		// returned "yes"); { all: [...] } = EVERY listed condition holds (so a review can block).
		// The `allChecksPassed` field carries this generic "converged this iteration" verdict
		// (its legacy name; the view labels it by `until`).
		const conditionMet = (cond: RepeatCondition): boolean => {
			if (cond === "checks-pass") return allChecksPassed;
			// A structured-field condition reads the validated JSON; a raw condition compares text.
			if ("path" in cond) return readPath(ctx.steps[cond.step]?.json, cond.path) === cond.equals;
			return (ctx.steps[cond.step]?.output ?? "").trim() === cond.equals;
		};
		const meets =
			runError === undefined &&
			!iterationHadStepFailure &&
			(typeof until === "object" && "all" in until ? until.all.every(conditionMet) : conditionMet(until));
		iterations.push({ n, startedAt: iterationStart, steps: stepReceipts, allChecksPassed: meets });
		if (meets) converged = true;
	}

	const finishedAt = deps.now();
	// The loop's text result: the declared `output`, else the last call/format step's
	// final-iteration value (ctx holds the latest output per step). Skipped as products: a
	// check (failure text, not a result) and the { step, equals } evaluator step (its verdict
	// like "yes" is the signal, not the work). Mainly consumed by a non-sandboxed loop.
	// The { step, equals } evaluator steps (single OR every one inside `all`) are signals, not
	// the work, so they are skipped when picking the implicit output -- like check steps.
	const signalSteps = new Set<string>(
		typeof until === "object" ? ("all" in until ? until.all.flatMap((c) => (typeof c === "object" ? [c.step] : [])) : [until.step]) : [],
	);
	const outputId =
		manifest.output ?? [...manifest.steps].reverse().find((s) => (s.kind === "call" || s.kind === "format") && !signalSteps.has(s.id))?.id;
	const output = outputId !== undefined ? ctx.steps[outputId]?.output : undefined;
	return {
		runId,
		routineId: routine.id,
		policy: "converge",
		...(opts.scope !== undefined && { scope: opts.scope }),
		digest: routine.digest,
		inputs: values,
		maxIterations,
		until,
		startedAt,
		finishedAt,
		elapsedMs: finishedAt - startedAt,
		status: runError !== undefined ? "failed" : cancelled ? "cancelled" : converged ? "converged" : "did-not-converge",
		iterations,
		...(output !== undefined && output !== "" && { output }),
		...(runError !== undefined && { error: runError }),
		...(cancelled && { error: "cancelled by operator" }),
	};
}
