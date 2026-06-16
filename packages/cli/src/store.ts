// Where run receipts live: one JSON file per run under .chit/runs (gitignored).
// Be precise about what is on disk: a receipt stores run metadata, the operator
// INPUTS, and the routine's FINAL OUTPUT in plaintext -- but never per-step model
// transcripts (those are not captured). So `trace` can summarize without a body
// dump, but the final output and inputs do sit here. Whether to store the body by
// default, keep a blob ref, or require opt-in audit is an open design question.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnCapture } from "./proc.ts";
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

// Every stored receipt, for the run-history view. Reads the receipt JSONs under .chit/runs,
// skipping the .patch siblings and any file that does not parse (a corrupt or partial receipt
// must not break the whole history). A pure read: it derives history from the evidence already
// on disk and stores nothing new. Ordering is the caller's job.
export function listReceipts(cwd: string): AnyReceipt[] {
	const dir = runsDir(cwd);
	if (!existsSync(dir)) return [];
	const receipts: AnyReceipt[] = [];
	for (const name of readdirSync(dir)) {
		if (!name.endsWith(".json")) continue;
		try {
			receipts.push(JSON.parse(readFileSync(join(dir, name), "utf-8")) as AnyReceipt);
		} catch {
			// Skip an unreadable receipt rather than fail the list.
		}
	}
	return receipts;
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

// The lifecycle state of a run's stored patch, derived live from git + the patch itself -- no new
// state is kept. It describes whether the PATCH can be applied from here, NOT whether the work
// exists in the repo (a committed change can read "blocked" once its patch no longer applies).
// Ordered the way `chit apply` reasons about it:
//   none      no patch stored (not a sandboxed run, or nothing to apply)
//   applied   Chit recorded applying it (durable), or the patch reverse-applies cleanly (changes in the tree)
//   blocked   not applied, and HEAD moved off the recorded base -- `chit apply` cannot apply it
//   pending   forward-applies cleanly onto the current tree -- ready for `chit apply`
//   conflicts none of the above -- the tree diverged; re-run rather than apply
export type PatchStatus = "none" | "applied" | "blocked" | "pending" | "conflicts";

async function gitApplyCleans(cwd: string, patch: string, reverse: boolean): Promise<boolean> {
	const r = await spawnCapture(["git", "apply", "--check", ...(reverse ? ["--reverse"] : []), "-"], { cwd, stdin: patch });
	return r.exitCode === 0;
}

export async function patchStatus(cwd: string, runId: string, baseCommit?: string, appliedAt?: number): Promise<PatchStatus> {
	const patch = loadPatch(cwd, runId);
	if (patch === undefined || patch.trim() === "") return "none";
	// A durable record that Chit applied this patch wins over the live git derivation: the work
	// landed even if later commits mean the patch no longer re-applies cleanly.
	if (appliedAt !== undefined) return "applied";
	if (await gitApplyCleans(cwd, patch, true)) return "applied";
	if (baseCommit !== undefined) {
		const head = await spawnCapture(["git", "rev-parse", "HEAD"], { cwd });
		if (head.exitCode === 0 && head.stdout.trim() !== baseCommit) return "blocked";
	}
	if (await gitApplyCleans(cwd, patch, false)) return "pending";
	return "conflicts";
}
