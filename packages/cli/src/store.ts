// Where run receipts live: one JSON file per run under .chit/runs (gitignored).
// Be precise about what is on disk: a receipt stores run metadata, the operator
// INPUTS, and the routine's FINAL OUTPUT in plaintext -- but never per-step model
// transcripts (those are not captured). So `trace` can summarize without a body
// dump, but the final output and inputs do sit here. Whether to store the body by
// default, keep a blob ref, or require opt-in audit is an open design question.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ConvergeReceipt } from "./converge.ts";
import type { FlowReceipt } from "./flow.ts";
import type { RunReceipt } from "./run.ts";

// A stored receipt is one of three shapes (text run / sandboxed loop / composition).
// Its `policy` field is an INTERNAL per-kind discriminator tag, not the v1 manifest
// policy (manifests have none) -- the user never sees it.
export type AnyReceipt = RunReceipt | ConvergeReceipt | FlowReceipt;

export function runsDir(cwd: string): string {
	return join(cwd, ".chit", "runs");
}

export function receiptPath(cwd: string, runId: string): string {
	return join(runsDir(cwd), `${runId}.json`);
}

export function saveReceipt(cwd: string, receipt: AnyReceipt): string {
	const dir = runsDir(cwd);
	mkdirSync(dir, { recursive: true });
	const path = receiptPath(cwd, receipt.runId);
	writeFileSync(path, `${JSON.stringify(receipt, null, 2)}\n`, "utf-8");
	return path;
}

export function loadReceipt(cwd: string, runId: string): AnyReceipt {
	const path = receiptPath(cwd, runId);
	if (!existsSync(path)) {
		throw new Error(`no run ${JSON.stringify(runId)} found (looked in ${runsDir(cwd)})`);
	}
	return JSON.parse(readFileSync(path, "utf-8")) as AnyReceipt;
}

// A sandboxed run's exact diff, stored beside its receipt so `chit apply <run-id>` can
// re-play the reviewed patch without re-running the models (which would yield a different
// diff). Only written when there is something to apply (a converged sandboxed run).
export function patchPath(cwd: string, runId: string): string {
	return join(runsDir(cwd), `${runId}.patch`);
}

export function savePatch(cwd: string, runId: string, patch: string): string {
	const dir = runsDir(cwd);
	mkdirSync(dir, { recursive: true });
	const path = patchPath(cwd, runId);
	writeFileSync(path, patch, "utf-8");
	return path;
}

export function loadPatch(cwd: string, runId: string): string | undefined {
	const path = patchPath(cwd, runId);
	return existsSync(path) ? readFileSync(path, "utf-8") : undefined;
}
