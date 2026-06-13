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
	// Apply the diff back to origin on success. Default behavior (false) is a
	// dry-run: run, show the diff, discard. The caller gates this on confirm.
	apply: boolean;
}

export interface ConvergeRunResult {
	receipt: ConvergeReceipt;
	diff: string;
	applied: boolean;
}

export async function runConvergeInSandbox(
	routine: ResolvedRoutine,
	values: Record<string, string>,
	deps: ConvergeRunDeps,
	opts: { scope?: string } = {},
): Promise<ConvergeRunResult> {
	// One id shared by the sandbox and the receipt.
	const runId = deps.newRunId();
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
				diffProvider: () => sandbox.diff(),
			},
			opts,
		);

		const diff = await sandbox.diff();
		const diffStat = await sandbox.diffStat();
		const status = await sandbox.status();

		if (receipt.status === "converged" && deps.apply) {
			await sandbox.apply();
			applied = true;
		}

		return {
			receipt: { ...receipt, sandbox: { workDir: sandbox.workDir, status, ...(diffStat ? { diffStat } : {}) } },
			diff,
			applied,
		};
	} finally {
		await sandbox.discard();
	}
}
