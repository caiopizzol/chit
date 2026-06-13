// Orchestrate a real converge run safely: create a sandbox, run the loop INSIDE
// it (so read-write steps edit an isolated copy, never the caller's tree), then
// apply the diff back to origin only when the run converged AND the caller asked
// to. The sandbox is always torn down. This is the write-safety boundary that
// lets live `chit run` execute a converge routine.
//
// The loop executor (runConverge) stays pure -- this layer owns the sandbox and
// the apply/discard decision, and is itself testable with a fake sandbox.

import type { Adapter } from "./adapter.ts";
import type { CheckRunner } from "./check-runner.ts";
import { type ConvergeReceipt, runConverge } from "./converge.ts";
import type { ResolvedRoutine } from "./routine.ts";
import type { SandboxFactory } from "./sandbox.ts";

export interface ConvergeRunDeps {
	sandboxFactory: SandboxFactory;
	adapter: Adapter;
	checkRunner: CheckRunner;
	cwd: string;
	now: () => number;
	newRunId: () => string;
	maxIterations?: number;
	maxWallMs?: number;
	onProgress?: (line: string) => void;
	// Operator-cancellation signal (Ctrl-C). Threaded into the loop; the sandbox is
	// torn down in `finally` regardless, so a cancelled run leaves no worktree behind.
	signal?: AbortSignal;
	// Apply the diff back to origin on success. Default behavior (false) is a
	// dry-run: run, show the diff, discard. The caller gates this on confirm.
	apply: boolean;
}

export interface ConvergeRunResult {
	receipt: ConvergeReceipt;
	diff: string;
	applied: boolean;
	// Set when the run converged but the write-back (sandbox.apply) failed. The receipt
	// carries the same message, so an apply failure still leaves durable evidence.
	applyError?: string;
}

export async function runConvergeInSandbox(
	routine: ResolvedRoutine,
	values: Record<string, string>,
	deps: ConvergeRunDeps,
	opts: { scope?: string } = {},
): Promise<ConvergeRunResult> {
	// One id shared by the sandbox and the receipt.
	const runId = deps.newRunId();
	deps.onProgress?.("  creating sandbox (git worktree) …");
	const sandbox = await deps.sandboxFactory.create(deps.cwd, runId);
	let applied = false;
	try {
		const receipt = await runConverge(
			routine,
			values,
			{
				adapter: deps.adapter,
				checkRunner: deps.checkRunner,
				cwd: sandbox.workDir,
				now: deps.now,
				newRunId: () => runId,
				...(deps.maxIterations !== undefined && { maxIterations: deps.maxIterations }),
				...(deps.maxWallMs !== undefined && { maxWallMs: deps.maxWallMs }),
				...(deps.onProgress !== undefined && { onProgress: deps.onProgress }),
				...(deps.signal !== undefined && { signal: deps.signal }),
				diffProvider: () => sandbox.diff(),
			},
			opts,
		);

		const diff = await sandbox.diff();
		const diffStat = await sandbox.diffStat();
		const status = await sandbox.status();

		let applyError: string | undefined;
		if (receipt.status === "converged" && deps.apply) {
			deps.onProgress?.("  applying changes to your tree …");
			try {
				await sandbox.apply();
				applied = true;
			} catch (e) {
				// The run converged; only the write-back failed (e.g. a dirty origin). Record
				// it instead of throwing, so the converged run still leaves a durable receipt.
				applyError = (e as Error).message;
			}
		}

		return {
			receipt: {
				...receipt,
				sandbox: { workDir: sandbox.workDir, status, ...(diffStat ? { diffStat } : {}) },
				...(applyError !== undefined && { applyError }),
			},
			diff,
			applied,
			...(applyError !== undefined && { applyError }),
		};
	} finally {
		await sandbox.discard();
	}
}
