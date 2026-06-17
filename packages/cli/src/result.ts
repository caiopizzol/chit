// The compact machine-readable result contract for a finished run: `chit result <run-id> --json`.
//
// Where `chit trace` is the human audit surface, `result` is the agent contract: the generic
// facts an agent branches on after a run finishes (did it converge, can I apply, which declared
// conditions held), derived from the receipt already on disk. It is config-first: the convergence
// model is the user's. result reports the declared `repeat.until` verbatim and evaluates each of
// its conditions against the final iteration, so a user-authored verdict/critic/review step shows
// up as a generic `signal`, never a built-in "review" concept. No role names are hardcoded here.
//
// A result needs a written receipt, so it is always a finished run (phase "finished", done true).
// One-shot and flow receipts have no convergence condition: until is null, signals/checks empty,
// and only the patch/apply facts and next command remain. The contract degrades, it never lies.

import { relative } from "node:path";
import type { ConvergeReceipt, IterationReceipt } from "./converge.ts";
import type { RepeatCondition, RepeatUntil } from "./manifest.ts";
import { type ReceiptStatus, receiptExitCode } from "./runstate.ts";
import {
	type AnyReceipt,
	debugPatchPath,
	loadDebugPatch,
	loadPatch,
	type PatchStatus,
	patchPath,
	patchStatus,
} from "./store.ts";
import { readPath } from "./structured.ts";

// One declared convergence condition, evaluated against the final iteration:
//   checks-pass   every check step in the final iteration passed (the deterministic gate)
//   step-equals   a named step's trimmed text output equals the target (a model/human verdict)
//   step-json     a dot-path of a named step's validated JSON output equals a scalar (the robust
//                 verdict form, e.g. review.passed === true)
// An `{ all: [...] }` until expands to one signal per member, so an agent sees exactly which
// condition is blocking convergence, without Chit naming any of them.
export type ResultSignal =
	| { kind: "checks-pass"; passed: boolean }
	| { kind: "step-equals"; stepId: string; equals: string; value: string | null; passed: boolean }
	| {
			kind: "step-json";
			stepId: string;
			path: string;
			equals: string | number | boolean;
			value: unknown;
			passed: boolean;
	  };

// One check command from the final iteration and whether it passed. Bodies stay in the receipt
// (and `chit trace --full`); result carries only the pass/fail an agent branches on.
export interface ResultCheck {
	stepId: string;
	command: string;
	ok: boolean;
}

export interface RunResult {
	runId: string;
	routineId: string;
	// Always "finished"/true: a result exists only once a receipt is written.
	phase: "finished";
	done: true;
	status: ReceiptStatus;
	// The exit code `chit wait` returned for this run (same derivation as the state read model).
	exitCode: number;
	scope?: string;
	// Apply surface. applyReady is true iff `chit apply <run-id>` would replay the stored patch
	// onto HEAD right now; patch is the full lifecycle status behind that boolean (none/applied/
	// blocked/pending/conflicts), so an agent can tell "nothing to apply" from "HEAD moved off base".
	applyReady: boolean;
	patch: PatchStatus;
	// Project-relative path to the applyable patch / the inspect-only debug patch, or null when
	// that file does not exist. Lets an agent read the diff without re-deriving the store layout.
	patchPath: string | null;
	debugPatchPath: string | null;
	// Set when the run converged but writing the patch back to the tree failed.
	applyError?: string;
	// The declared convergence condition (a loop's repeat.until, or the implicit "checks-pass" of a
	// single-pass sandboxed run). null for a text/flow run that declares no convergence condition.
	until: RepeatUntil | null;
	// Each condition of `until`, evaluated against the final iteration.
	signals: ResultSignal[];
	// stepId -> the validated JSON a `call` step produced in the final iteration. This is where a
	// user-authored evaluator's structured output (its schema is the contract) surfaces generically.
	structuredSteps: Record<string, unknown>;
	// The final iteration's check commands and their pass/fail.
	checks: ResultCheck[];
	// A failed/cancelled run's error, or a converged run's apply error -- whatever the receipt holds.
	error?: string;
	// A useful next command: apply when the patch is ready, otherwise inspect via trace.
	nextCommand: string;
}

function finalIteration(receipt: ConvergeReceipt): IterationReceipt | undefined {
	return receipt.iterations.at(-1);
}

// checks-pass held in an iteration iff every check step in it passed. (The receipt's per-iteration
// `allChecksPassed` flag was repurposed to mean "met the whole until condition", so it cannot be
// reused for this per-check verdict; recompute from the check steps' own statuses.) Vacuously true
// when the iteration ran no check steps, matching the loop executor.
function checksPassed(it: IterationReceipt | undefined): boolean {
	if (it === undefined) return false;
	return it.steps.every((s) => s.kind !== "check" || s.status === "ok");
}

function evalCondition(cond: RepeatCondition, it: IterationReceipt | undefined): ResultSignal {
	if (cond === "checks-pass") return { kind: "checks-pass", passed: checksPassed(it) };
	const step = it?.steps.find((s) => s.id === cond.step);
	if ("path" in cond) {
		// Read the dot-path from the step's validated JSON; a missing step/field reads as null.
		const value = step?.json !== undefined ? readPath(step.json, cond.path) : undefined;
		return {
			kind: "step-json",
			stepId: cond.step,
			path: cond.path,
			equals: cond.equals,
			value: value === undefined ? null : value,
			passed: value === cond.equals,
		};
	}
	const value = step?.output !== undefined ? step.output.trim() : null;
	return { kind: "step-equals", stepId: cond.step, equals: cond.equals, value, passed: value === cond.equals };
}

function conditionsOf(until: RepeatUntil): RepeatCondition[] {
	return typeof until === "object" && "all" in until ? until.all : [until];
}

function signalsOf(receipt: ConvergeReceipt): ResultSignal[] {
	const it = finalIteration(receipt);
	return conditionsOf(receipt.until ?? "checks-pass").map((c) => evalCondition(c, it));
}

function structuredStepsOf(receipt: ConvergeReceipt): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const s of finalIteration(receipt)?.steps ?? []) {
		if (s.kind === "call" && s.json !== undefined) out[s.id] = s.json;
	}
	return out;
}

function checksOf(receipt: ConvergeReceipt): ResultCheck[] {
	const out: ResultCheck[] = [];
	for (const s of finalIteration(receipt)?.steps ?? []) {
		if (s.kind !== "check") continue;
		for (const c of s.checks ?? []) out.push({ stepId: s.id, command: c.command, ok: c.ok });
	}
	return out;
}

// Build the compact result contract from a finished run's receipt. The patch facts are derived
// live from git exactly as the state read model derives them, so `result` and `status` never
// disagree about apply readiness.
export async function buildRunResult(cwd: string, receipt: AnyReceipt): Promise<RunResult> {
	const baseCommit = "baseCommit" in receipt ? receipt.baseCommit : undefined;
	const appliedAt = "appliedAt" in receipt ? receipt.appliedAt : undefined;
	const applyError = "applyError" in receipt ? receipt.applyError : undefined;
	const error = "error" in receipt ? receipt.error : undefined;

	const patch = await patchStatus(cwd, receipt.runId, baseCommit, appliedAt);
	const hasPatch = loadPatch(cwd, receipt.runId) !== undefined;
	const hasDebugPatch = loadDebugPatch(cwd, receipt.runId) !== undefined;
	const applyReady = patch === "pending";

	// Convergence facts exist only for a loop/sandboxed (converge) receipt; a text or flow run
	// declares no exit condition, so these stay null/empty rather than being invented.
	const converge = receipt.policy === "converge" ? receipt : undefined;

	return {
		runId: receipt.runId,
		routineId: receipt.routineId,
		phase: "finished",
		done: true,
		status: receipt.status,
		exitCode: receiptExitCode(receipt),
		...(receipt.scope !== undefined && { scope: receipt.scope }),
		applyReady,
		patch,
		patchPath: hasPatch ? relative(cwd, patchPath(cwd, receipt.runId)) : null,
		debugPatchPath: hasDebugPatch ? relative(cwd, debugPatchPath(cwd, receipt.runId)) : null,
		...(applyError !== undefined && { applyError }),
		until: converge ? (converge.until ?? "checks-pass") : null,
		signals: converge ? signalsOf(converge) : [],
		structuredSteps: converge ? structuredStepsOf(converge) : {},
		checks: converge ? checksOf(converge) : [],
		...(error !== undefined && { error }),
		nextCommand: applyReady ? `chit apply ${receipt.runId}` : `chit trace ${receipt.runId}`,
	};
}
