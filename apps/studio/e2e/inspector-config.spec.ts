import { expect, test } from "@playwright/test";
import { launchStudio } from "./studio.ts";

// Selecting a call node shows the effective agent config resolved from the
// registry (read-only), reusing the same shape and formatter as `chit show`, so
// an operator sees exactly what that participant will run with.
test("inspector shows the effective resolved config for a selected call node", async ({ page }) => {
	const studio = await launchStudio("consult.json");
	try {
		await page.goto(studio.url);
		const node = page.locator('.react-flow__node[data-id="ask_claude"]');
		await expect(node).toBeVisible();
		await node.click();

		const inspector = page.locator(".inspector");
		await expect(inspector).toContainText("effective config (resolved");
		// consult's claude participant uses built-in defaults: no pinned model, and
		// strict-MCP is effectively on for claude-cli.
		await expect(inspector).toContainText("model=default");
		await expect(inspector).toContainText("strictMcp=on");
	} finally {
		await studio.close();
	}
});
