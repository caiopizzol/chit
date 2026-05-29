import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, test } from "@playwright/test";
import { launchStudio } from "./studio.ts";

// The read-only Loops drawer against a real server. The harness boots
// `chit studio` in a temp cwd; we seed one convergence log under .chit/loops
// there (the server reads it per request), then exercise the visual contract:
// open the drawer, see the loop, select it, read the compact rail, and back
// out with Escape. Raw JSONL is written directly (the writer/reader format
// agreement is covered by unit + cross-component tests elsewhere).
test("loops drawer: list -> select -> compact rail -> Escape back", async ({ page }) => {
	const studio = await launchStudio("consult.json");
	const cwd = dirname(studio.file);
	const lines = [
		{
			type: "loop",
			schema: 1,
			loopId: "E1",
			scope: "e2e-scope",
			task: "e2e loop task",
			repo: cwd,
			startedAt: "2026-05-29T10:00:00.000Z",
			maxIterations: 3,
		},
		{
			type: "iteration",
			n: 1,
			implementSummary: "implemented the slice",
			changedFiles: ["a.ts", "b.ts"],
			checksRun: "264 tests",
			verdict: "revise",
			findingCount: 2,
			decision: "revise",
			checkDurationMs: 18000,
			at: "2026-05-29T10:01:00.000Z",
		},
		{
			type: "stop",
			status: "converged",
			reason: "proceed + complete",
			iterations: 1,
			totalElapsedMs: 192000,
			endedAt: "2026-05-29T10:03:00.000Z",
		},
	];
	mkdirSync(join(cwd, ".chit", "loops"), { recursive: true });
	writeFileSync(
		join(cwd, ".chit", "loops", "E1.jsonl"),
		`${lines.map((l) => JSON.stringify(l)).join("\n")}\n`,
	);

	try {
		await page.goto(studio.url);

		// The header button reflects the one loop on disk.
		const loopsBtn = page.locator(".loops-btn");
		await expect(loopsBtn).toContainText("(1)");

		// Open the drawer: the list shows the loop's task and status.
		await loopsBtn.click();
		const drawer = page.getByRole("dialog", { name: "Loops" });
		await expect(drawer).toBeVisible();
		await expect(drawer).toContainText("e2e loop task");
		await expect(drawer).toContainText("converged");

		// Select the loop: the compact rail shows the v0 fields.
		await drawer.locator(".loop-item").click();
		await expect(drawer).toContainText("implemented the slice");
		await expect(drawer).toContainText("e2e-scope"); // scope in the rail head
		await expect(drawer).toContainText("a.ts, b.ts"); // changed-file list, not just count
		await expect(drawer).toContainText("checks: 264 tests");
		await expect(drawer.locator(".verdict--revise")).toBeVisible();
		await expect(drawer).toContainText("stopped: converged");

		// The per-loop config strip reads the header: maxIterations 3, and the
		// checker manifest is labeled "not recorded" (the log does not store it).
		const config = drawer.locator(".loop-config");
		await expect(config).toContainText("max iterations");
		await expect(config).toContainText("3");
		await expect(config).toContainText("checker manifest");
		await expect(config.locator(".config-absent")).toHaveText("not recorded");

		// Escape backs out to the list (not closed): the loop row is shown again.
		await page.keyboard.press("Escape");
		await expect(drawer).toBeVisible();
		await expect(drawer.locator(".loop-item")).toBeVisible();

		// Escape again closes the drawer.
		await page.keyboard.press("Escape");
		await expect(drawer).toBeHidden();
	} finally {
		await studio.close();
	}
});
