import { existsSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { launchStudio } from "./studio.ts";

// The header install/drawer flow against a real install lifecycle (pointed at
// a throwaway CHIT_SKILLS_DIR by the harness). consult.json is fully enforced
// now (codex sandbox + claude plan mode), so the install modal has no
// permission-warning consent gate and Install is enabled at once. The states run
// as one machine-wide sequence to avoid repeated server boots: install ->
// duplicate-refused -> uninstall.
test("header install modal + installed drawer: install, duplicate, uninstall", async ({ page }) => {
	const studio = await launchStudio("consult.json");
	const skillDir = join(studio.skillsDir, "consult");
	try {
		await page.goto(studio.url);

		const headerInstall = page.locator(".install-btn");
		const headerInstalled = page.locator(".installed-btn");
		await expect(headerInstall).toBeEnabled(); // clean at boot, install allowed
		await expect(headerInstalled).not.toContainText("("); // nothing installed yet

		// --- No consent gate: consult is fully enforced, so Install is enabled at
		// once and the modal shows no permission warning. ---
		await headerInstall.click();
		const dialog = page.getByRole("dialog", { name: /into Claude Code/ });
		const confirm = dialog.getByRole("button", { name: "Install", exact: true });
		await expect(dialog).toBeVisible();
		await expect(dialog).not.toContainText("Claude Code cannot enforce");
		await expect(
			page.getByRole("checkbox", { name: "Install with permission warning" }),
		).toHaveCount(0);
		await expect(confirm).toBeEnabled();
		expect(existsSync(skillDir)).toBe(false);

		// --- Install succeeds, count goes to 1, folder exists. ---
		await confirm.click();
		await expect(dialog).toBeHidden();
		await expect(headerInstalled).toContainText("(1)");
		expect(existsSync(skillDir)).toBe(true);

		// --- Duplicate install: refused with a controlled error, list stable. ---
		await headerInstall.click();
		const dialog2 = page.getByRole("dialog", { name: /into Claude Code/ });
		await dialog2.getByRole("button", { name: "Install", exact: true }).click();
		// The modal stays open and surfaces the failure; the registry is unchanged.
		await expect(dialog2).toBeVisible();
		await expect(dialog2.locator(".refetch-error")).toContainText("already exists");
		await expect(headerInstalled).toContainText("(1)");
		expect(existsSync(skillDir)).toBe(true);
		await dialog2.getByRole("button", { name: "Cancel" }).click();
		await expect(dialog2).toBeHidden();

		// --- Uninstall (two-step confirm): list clears, folder removed. ---
		await headerInstalled.click();
		const drawer = page.getByRole("dialog", { name: "Installed chits" });
		await expect(drawer).toBeVisible();
		await expect(drawer).toContainText("consult");
		await drawer.getByRole("button", { name: "Uninstall" }).click();
		await drawer.getByRole("button", { name: "Confirm" }).click();
		await expect(drawer.getByText("No chits installed on this machine.")).toBeVisible();
		expect(existsSync(skillDir)).toBe(false);

		// Closing the drawer, the header count is gone (back to bare "Installed").
		await drawer.getByRole("button", { name: "Close" }).first().click();
		await expect(drawer).toBeHidden();
		await expect(headerInstalled).not.toContainText("(");
	} finally {
		await studio.close();
	}
});
