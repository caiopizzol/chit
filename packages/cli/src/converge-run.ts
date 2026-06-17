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
import { validateChangedFiles } from "./manifest.ts";
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
	// The origin commit the run is based on (from the caller's preflight). Recorded on the
	// receipt so a later `chit apply` can refuse a base that no longer matches HEAD.
	baseCommit?: string;
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
	// The exact, re-appliable patch (a staged binary diff) of the run's changes. The CLI
	// stores it beside the receipt so `chit apply <run-id>` re-plays this reviewed diff.
	patch: string;
	applied: boolean;
	// Set when the run converged but the write-back (sandbox.apply) failed. The receipt
	// carries the same message, so an apply failure still leaves durable evidence.
	applyError?: string;
	// When true, the patch is a debug artifact from a failed/non-converged/violated run.
	// Not applyable by `chit apply`; stored separately as .debug.patch for inspection.
	debugPatch?: boolean;
}

export async function runConvergeInSandbox(
	routine: ResolvedRoutine,
	values: Record<string, string>,
	deps: ConvergeRunDeps,
	opts: { scope?: string } = {},
): Promise<ConvergeRunResult> {
	// One id shared by the sandbox and the receipt.
	const runId = deps.newRunId();
	deps.onProgress?.(`run ${runId}`);
	deps.onProgress?.("  creating sandbox (git worktree) ...");
	const baseCommit = deps.baseCommit ?? (await deps.sandboxFactory.preflight(deps.cwd)).baseCommit;
	const sandbox = await deps.sandboxFactory.create(deps.cwd, runId, baseCommit);
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
		// The exact patch, captured BEFORE the sandbox is discarded, for `chit apply`.
		const patch = await sandbox.patch();

		// Change policy enforcement: check AFTER the loop, BEFORE apply. A violation is
		// a structured deterministic failure -- the run may have converged, but the result
		// is rejected and the patch becomes a debug artifact, not an applyable one.
		const policy = routine.manifest.changePolicy;
		let changePolicyViolation: ConvergeReceipt["changePolicyViolation"];
		if (policy !== undefined && status.length > 0) {
			const validation = validateChangedFiles(policy, status);
			if (!validation.ok) {
				changePolicyViolation = {
					unexpectedFiles: validation.unexpectedFiles,
					...(policy.allowedChangedPaths !== undefined && { allowed: policy.allowedChangedPaths }),
					...(policy.deniedChangedPaths !== undefined && { denied: policy.deniedChangedPaths }),
				};
				deps.onProgress?.(`  change policy violation: ${validation.unexpectedFiles.length} unexpected file(s)`);
			}
		}

		let applyError: string | undefined;
		// Only apply when: the loop converged, no change policy violation, and the caller asked to.
		if (receipt.status === "converged" && changePolicyViolation === undefined && deps.apply) {
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

		// A change policy violation is a deterministic failure regardless of convergence.
		// The loop may have converged or not, but the overall run is rejected either way.
		const finalStatus = changePolicyViolation !== undefined ? "failed" : receipt.status;
		const finalError =
			changePolicyViolation !== undefined
				? `change policy violation: unexpected changed files: ${changePolicyViolation.unexpectedFiles.join(", ")}`
				: receipt.error;
		const isDebugPatch = finalStatus !== "converged" && patch.trim() !== "";

		return {
			receipt: {
				...receipt,
				status: finalStatus,
				sandbox: { workDir: sandbox.workDir, status, ...(diffStat ? { diffStat } : {}) },
				baseCommit,
				...(applyError !== undefined && { applyError }),
				...(changePolicyViolation !== undefined && { changePolicyViolation }),
				...(changePolicyViolation !== undefined && { failureKind: "unexpected_changed_files" as const }),
				...(finalError !== undefined && { error: finalError }),
			},
			diff,
			patch,
			applied,
			...(applyError !== undefined && { applyError }),
			...(isDebugPatch && { debugPatch: true }),
		};
	} finally {
		await sandbox.discard();
	}
}
