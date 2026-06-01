import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, test } from "@playwright/test";
import { loopLogDir } from "../../cli/src/loops/location.ts";
import { launchStudio } from "./studio.ts";

// The audit transcript view against a real server. A loop iteration's auditRef
// (the bare audit run id) points into the audit store, which lives in the
// local-state dir. The loop log lives there too (keyed by repo). The harness
// boots `chit studio` with XDG_STATE_HOME pointed at a temp dir we seed with one
// audit run and one loop; then we open the drawer, select the loop, click "view
// transcript" on the iteration, and read the audit timeline.
test("audit drawer: loop iteration -> view transcript -> timeline + body", async ({ page }) => {
	const RUN_ID = "auditrun1";
	const xdg = mkdtempSync(join(tmpdir(), "chit-e2e-xdg-"));
	// The loop log is seeded at the same state-dir path the server reads; both
	// resolve it from XDG_STATE_HOME, so point this process there too.
	process.env.XDG_STATE_HOME = xdg;
	try {
		// Seed the audit run under XDG_STATE_HOME/chit/audit/runs/<runId>/.
		const runDir = join(xdg, "chit", "audit", "runs", RUN_ID);
		mkdirSync(join(runDir, "blobs"), { recursive: true });
		const inputRef = "a".repeat(64);
		const outputRef = "b".repeat(64);
		const events = [
			{
				type: "run.started",
				runId: RUN_ID,
				ts: "2026-05-31T10:00:00.000Z",
				manifestId: "converge",
				cwd: "/x",
				surface: "converge",
				scope: "e2e-scope",
				participants: {
					implementer: {
						agentId: "claude",
						adapter: "claude-cli",
						session: "per_scope",
						permissions: { filesystem: "write" },
						enforcesReadOnly: false,
						config: { model: "opus", strictMcp: true, passModelOnResume: false },
					},
				},
			},
			{
				type: "adapter.call.started",
				runId: RUN_ID,
				ts: "2026-05-31T10:00:01.000Z",
				stepId: "implement",
				participantId: "implementer",
				agentId: "claude-cli",
				cwd: "/x",
				inputBlob: inputRef,
			},
			{
				type: "adapter.call.completed",
				runId: RUN_ID,
				ts: "2026-05-31T10:00:10.000Z",
				stepId: "implement",
				outputBlob: outputRef,
				durationMs: 9000,
				status: "ok",
				usage: { inputTokens: 6590, outputTokens: 40, estimatedCostUsd: 0.0658 },
			},
			{
				type: "run.completed",
				runId: RUN_ID,
				ts: "2026-05-31T10:00:12.000Z",
				status: "ok",
				durationMs: 12000,
			},
		];
		writeFileSync(
			join(runDir, "events.jsonl"),
			`${events.map((e) => JSON.stringify(e)).join("\n")}\n`,
		);
		writeFileSync(join(runDir, "blobs", inputRef), "THE RENDERED PROMPT");
		writeFileSync(join(runDir, "blobs", outputRef), "THE AGENT OUTPUT");

		const studio = await launchStudio("consult.json", { XDG_STATE_HOME: xdg });
		const cwd = dirname(studio.file);
		// A loop whose one iteration links to the audit run via auditRef.
		const lines = [
			{
				type: "loop",
				schema: 1,
				loopId: "E1",
				scope: "e2e-scope",
				task: "audited loop",
				repo: cwd,
				repoKey: "e2e",
				startedAt: "2026-05-31T10:00:00.000Z",
				maxIterations: 3,
			},
			{
				type: "iteration",
				n: 1,
				implementSummary: "did the slice",
				changedFiles: ["a.ts"],
				checksRun: "tests",
				verdict: "proceed",
				findingCount: 0,
				decision: "proceed",
				checkDurationMs: 5000,
				at: "2026-05-31T10:01:00.000Z",
				auditRef: RUN_ID,
			},
			{
				type: "stop",
				status: "converged",
				reason: "done",
				iterations: 1,
				totalElapsedMs: 12000,
				endedAt: "2026-05-31T10:03:00.000Z",
			},
		];
		const loopsDir = loopLogDir(cwd);
		mkdirSync(loopsDir, { recursive: true });
		writeFileSync(
			join(loopsDir, "E1.jsonl"),
			`${lines.map((l) => JSON.stringify(l)).join("\n")}\n`,
		);

		try {
			await page.goto(studio.url);
			await page.locator(".loops-btn").click();
			const drawer = page.getByRole("dialog", { name: "Loops" });
			await drawer.locator(".loop-item").click();

			// The audited iteration shows a transcript link; click it.
			const link = drawer.locator(".rail-audit-link");
			await expect(link).toBeVisible();
			await link.click();

			// The audit timeline renders, with the run status and usage summary.
			await expect(drawer).toContainText("adapter.call.completed");
			await expect(drawer).toContainText("run.completed");
			await expect(drawer).toContainText("status:");
			await expect(drawer).toContainText("reported cost: $0.0658");

			// The recorded participant config snapshot renders (from run.started, not
			// the current registry), with the same formatting as `chit audit show`.
			await expect(drawer).toContainText("participants (recorded config)");
			await expect(drawer).toContainText("model=opus");
			await expect(drawer).toContainText("strictMcp=on");

			// Bodies are collapsed by default; expanding one reveals the prompt.
			const body = drawer.locator(".audit-body summary").first();
			await body.click();
			await expect(drawer).toContainText("THE RENDERED PROMPT");

			// Escape backs out of the transcript to the loop (rail visible again).
			await page.keyboard.press("Escape");
			await expect(drawer.locator(".loop-rail")).toBeVisible();
		} finally {
			await studio.close();
		}
	} finally {
		rmSync(xdg, { recursive: true, force: true });
	}
});
