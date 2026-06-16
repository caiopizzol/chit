// Run a non-sandboxed execution routine (pure call/format, read-only, no checks)
// once in the cwd, and return a receipt. This is the "text" path -- grill, plan.
// No disk IO; injected clock and id, so it is deterministic under test.
//
// (Sandboxed execution -- anything with checks or a read-write participant -- and
// composition go through converge.ts and flow.ts. Dispatch in cli.ts picks one.)

import type { Adapter } from "./adapter.ts";
import { formatElapsed } from "./elapsed.ts";
import { withHeartbeat } from "./heartbeat.ts";
import { effectiveCallTimeoutMs, effectiveRunTimeoutMs, type Manifest } from "./manifest.ts";
import type { ResolvedRoutine } from "./routine.ts";
import { evaluateStructured } from "./structured.ts";
import { renderTemplate } from "./template.ts";

export interface StepReceipt {
	id: string;
	kind: "call" | "format" | "ask";
	participant?: string;
	// The agent id (profile) plus the binding it resolved to, so trace can prove which
	// adapter + model actually ran -- even if the config later changes.
	agent?: string;
	adapter?: string;
	model?: string;
	effort?: string;
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
	// Human-input seam: an `ask` step calls this to get one operator answer (the bin
	// reads stdin; tests inject a deterministic answer). A routine with no ask steps
	// never calls it; an ask step that runs without it wired is an error.
	askUser?: (question: string) => Promise<string>;
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

	// A call step's agent id and the adapter/model it resolves to, recorded on every call
	// receipt (ok, failed, AND cancelled) so trace proves what ran. adapter/model are
	// omitted when the routine has no bindings (hand-built test routines bypass resolve).
	const callBinding = (
		participantId: string,
	): { agent?: string; adapter?: string; model?: string; effort?: string } => {
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

	const ctx = { inputs: values, steps: {} as Record<string, { output: string; json?: unknown }> };
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
				const result = await withHeartbeat(
					() =>
						deps.adapter.call({
							agent: participant.agent,
							instructions: participant.instructions,
							prompt: renderTemplate(step.prompt, ctx),
							filesystem: participant.filesystem,
							cwd: deps.cwd,
							...(callTimeoutMs !== undefined && { timeoutMs: callTimeoutMs }),
							...(deps.signal !== undefined && { signal: deps.signal }),
						}),
					{
						label: `call ${step.call}`,
						now: deps.now,
						...(deps.onProgress !== undefined && { onProgress: deps.onProgress }),
					},
				);
				const callElapsed = deps.now() - stepStart;
				deps.onProgress?.(`  call ${step.call} done in ${formatElapsed(callElapsed)}`);
				// Structured output: validate against the schema. A one-shot has no retry loop, so
				// invalid JSON is a hard failure (thrown -> the catch records a failed step).
				if (step.json !== undefined) {
					const ev = evaluateStructured(result.output, step.json.schema);
					if (!ev.ok) throw new Error(ev.error);
					ctx.steps[step.id] = { output: ev.normalized, json: ev.value };
				} else {
					ctx.steps[step.id] = { output: result.output };
				}
				steps.push({
					id: step.id,
					kind: "call",
					participant: step.call,
					...callBinding(step.call),
					status: "ok",
					startedAt: stepStart,
					elapsedMs: callElapsed,
				});
			} else if (step.kind === "format") {
				ctx.steps[step.id] = { output: renderTemplate(step.format, ctx) };
				steps.push({
					id: step.id,
					kind: "format",
					status: "ok",
					startedAt: stepStart,
					elapsedMs: deps.now() - stepStart,
				});
			} else if (step.kind === "ask") {
				if (deps.askUser === undefined) throw new Error(`step ${step.id} is an \`ask\` but no input handler is wired`);
				deps.onProgress?.(`  ask ${step.id} …`);
				// The answer feeds later steps via {{ steps.<id>.output }}; it is NOT recorded
				// on the receipt (the step receipt below carries status + timing only).
				const answer = await deps.askUser(renderTemplate(step.ask, ctx));
				ctx.steps[step.id] = { output: answer };
				steps.push({ id: step.id, kind: "ask", status: "ok", startedAt: stepStart, elapsedMs: deps.now() - stepStart });
			} else {
				// A non-sandboxed text routine has only call/format/ask steps (dispatch guarantees it).
				throw new Error(`runOneShot cannot run a ${step.kind} step (${step.id})`);
			}
		} catch (e) {
			// A call killed by the cancellation signal is a cancel, not a failure. Record
			// the step that was active so the timeline shows what was interrupted.
			if (deps.signal?.aborted) {
				cancelled = true;
				steps.push({
					id: step.id,
					kind: step.kind === "call" ? "call" : step.kind === "ask" ? "ask" : "format",
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
				kind: step.kind === "call" ? "call" : step.kind === "ask" ? "ask" : "format",
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
	// The run's output is its last TEXT-producing step. An `ask` answer feeds later steps
	// but is not the routine's product (and is kept out of the receipt), so it is never the
	// implicit output -- fall back to the last non-ask step.
	const outputId = manifest.output ?? [...manifest.steps].reverse().find((s) => s.kind !== "ask")?.id;
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
