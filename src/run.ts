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
	// The agent id (profile) plus the binding it resolved to, so trace can prove which
	// adapter + model actually ran -- even if the config later changes.
	agent?: string;
	adapter?: string;
	model?: string;
	status: "ok" | "failed" | "cancelled";
	// Absolute clock (deps.now()) when the step started. With the run's startedAt this
	// gives a timeline (offset = startedAt - run.startedAt); elapsedMs is the duration.
	startedAt: number;
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
	status: "completed" | "failed" | "cancelled";
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
	// Operator-cancellation signal (Ctrl-C). Checked before each step and threaded
	// into the call so an in-flight call is killed promptly; a cancelled run records
	// a "cancelled" receipt rather than a failure.
	signal?: AbortSignal;
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

	// The resolved adapter/model a participant's agent id binds to, recorded on its
	// call receipt so trace proves what actually ran. Empty when the routine has no
	// bindings (hand-built test routines bypass resolve).
	const callBinding = (participantId: string): { adapter?: string; model?: string } => {
		const agentId = manifest.participants[participantId]?.agent;
		const b = agentId !== undefined ? routine.agents?.[agentId] : undefined;
		return b !== undefined ? { adapter: b.adapter, ...(b.model !== undefined && { model: b.model }) } : {};
	};

	const ctx = { inputs: values, steps: {} as Record<string, { output: string }> };
	const steps: StepReceipt[] = [];
	let failed: string | undefined;
	let cancelled = false;

	for (const step of manifest.steps) {
		if (deps.signal?.aborted) {
			cancelled = true;
			break;
		}
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
					...(deps.signal !== undefined && { signal: deps.signal }),
				});
				ctx.steps[step.id] = { output: result.output };
				steps.push({ id: step.id, kind: "call", participant: step.call, agent: participant.agent, ...callBinding(step.call), status: "ok", startedAt: stepStart, elapsedMs: deps.now() - stepStart });
			} else if (step.kind === "format") {
				ctx.steps[step.id] = { output: renderTemplate(step.format, ctx) };
				steps.push({ id: step.id, kind: "format", status: "ok", startedAt: stepStart, elapsedMs: deps.now() - stepStart });
			} else {
				// A non-sandboxed text routine has only call/format steps (dispatch guarantees it).
				throw new Error(`runOneShot cannot run a ${step.kind} step (${step.id})`);
			}
		} catch (e) {
			// A call killed by the cancellation signal is a cancel, not a failure. Record
			// the step that was active so the timeline shows what was interrupted.
			if (deps.signal?.aborted) {
				cancelled = true;
				steps.push({
					id: step.id,
					kind: step.kind === "call" ? "call" : "format",
					...(step.kind === "call" && { participant: step.call, ...callBinding(step.call) }),
					status: "cancelled",
					startedAt: stepStart,
					elapsedMs: deps.now() - stepStart,
				});
				break;
			}
			failed = (e as Error).message;
			steps.push({
				id: step.id,
				kind: step.kind === "call" ? "call" : "format",
				...(step.kind === "call" && { participant: step.call, ...callBinding(step.call) }),
				status: "failed",
				startedAt: stepStart,
				elapsedMs: deps.now() - stepStart,
				error: failed,
			});
			break;
		}
	}

	const finishedAt = deps.now();
	const outputId = manifest.output ?? manifest.steps.at(-1)?.id;
	const output = outputId !== undefined ? ctx.steps[outputId]?.output : undefined;
	const status = cancelled ? "cancelled" : failed === undefined ? "completed" : "failed";
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
		status,
		steps,
		...(status === "completed" && output !== undefined && { output }),
		...(cancelled && { error: "cancelled by operator" }),
		...(failed !== undefined && { error: failed }),
	};
}
