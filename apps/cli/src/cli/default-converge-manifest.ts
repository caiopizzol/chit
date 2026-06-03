// The default converge manifest, embedded so `chit converge` (no --manifest)
// and the MCP `chit_start` with a `task` (no manifest_path) work from the published
// binary, which ships only dist/ (not examples/). Kept identical to
// examples/converge.json by a drift-guard test (default-converge-manifest.test.ts);
// examples/converge.json stays as the canonical example users read and copy.

export const DEFAULT_CONVERGE_MANIFEST: unknown = {
	schema: 1,
	id: "converge",
	description:
		"Autonomous convergence: a write-capable Claude implements a slice, then a read-only Codex reviews the diff and returns proceed/revise/block. Drive it in a loop with the `chit converge` CLI driver, or stepwise from the MCP - one chit_next per iteration, same scope so both agents keep their thread, feeding the prior review back in via inputs.prior_review. The human sequences and checkpoints (inspect the diff each round, stop if it goes sideways); chit runs the agents. Run against an isolated worktree, not the main checkout.",

	inputs: {
		task: { type: "string" },
		prior_review: { type: "string", optional: true },
	},

	requires: {
		can_show_markdown: true,
	},

	participants: {
		implementer: {
			agent: "claude",
			instructions:
				"You implement one small, focused slice of a software task in the repository at your cwd. Make the ACTUAL code edits with your tools - do not just describe them. Stay scoped to the task; do not refactor unrelated code. If a prior review is provided, address its concrete findings. Run the project's checks if quick. Then summarize precisely: which files you changed, what each change does and why, what you deliberately did NOT do, and which checks you ran with their results.",
			session: "per_scope",
			permissions: { filesystem: "write" },
		},
		reviewer: {
			agent: "codex",
			instructions:
				"You are a skeptical implementation reviewer for a convergence loop. The implementer just edited the repository at your cwd. Inspect the current git diff and the changed files, and verify the work against the task. Base your verdict on the TASK changes. Untracked generated build artifacts (e.g. __pycache__, *.pyc) are workspace hygiene, not task changes: note them at most as a minor aside and do NOT revise solely because of them. chit keeps its own control-plane state outside the repo, so it never appears in the diff. Run non-mutating checks if useful. Do not edit. Do not agree for the sake of agreeing. Use prior context from this scope. Cite file:line and command results.",
			session: "per_scope",
			permissions: { filesystem: "read_only" },
		},
	},

	steps: {
		implement: {
			call: "implementer",
			prompt:
				"Task:\n{{ inputs.task }}\n\nPrior review to address (empty on the first iteration):\n{{ inputs.prior_review }}\n\nImplement this slice now by editing files in the repo at your cwd. Keep it small and focused. Then summarize what you changed (files + what/why), what you did not do, and any checks you ran.",
		},

		review: {
			call: "reviewer",
			prompt:
				'Task under review:\n{{ inputs.task }}\n\nThe implementer\'s summary of what it just implemented:\n{{ steps.implement.output }}\n\nInspect the current git diff and the changed files at your cwd. Verify the change against the task and run non-mutating checks if useful. Return prose with:\n1. Verdict: proceed / revise / block.\n2. Findings ordered by severity, with file:line.\n3. What the implementer should fix next if the verdict is revise.\n4. Remaining risk if proceeding.\n\nThen, as the LAST thing in your reply, emit a single machine-readable fenced JSON block that the driver parses (the prose above is for humans). Use exactly these keys:\n```json\n{"verdict": "proceed | revise | block", "findingCount": 0, "checksRun": "the non-mutating checks you ran, or \'none\'", "risk": "remaining risk if proceeding"}\n```\nfindingCount is the integer number of findings; checksRun is a short human string.',
		},

		out: {
			format:
				"## Converge iteration\n\n### Implementer\n{{ steps.implement.output }}\n\n### Reviewer\n{{ steps.review.output }}",
		},
	},

	output: "out",

	policy: { kind: "loop", implementStep: "implement", reviewStep: "review" },
};
