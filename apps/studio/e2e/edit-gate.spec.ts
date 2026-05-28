import { expect, test } from "@playwright/test";
import { launchStudio } from "./studio.ts";

// Real typing through the edit/preview/save gate: Save must reflect the final
// content, not a stale intermediate, and an edit that introduces a parse error
// must keep Save disabled even after the debounce settles.
test("editing the description gates Save: valid enables, empty disables, restore re-enables", async ({
	page,
}) => {
	const studio = await launchStudio("consult.json");
	try {
		await page.goto(studio.url);
		const save = page.getByRole("button", { name: "Save", exact: true });
		const desc = page.locator("#manifest-description");
		await expect(desc).toBeVisible();
		await expect(save).toBeDisabled(); // not dirty at boot

		// Valid edit -> Save enables after the debounced preview.
		await desc.fill("Edited description that is valid.");
		await expect(save).toBeEnabled();

		// Empty -> parse error (description must be non-empty) -> Save stays
		// disabled and the error surfaces.
		await desc.fill("");
		await expect(save).toBeDisabled();
		await expect(page.locator(".refetch-error")).toContainText("description");

		// Restore a valid value -> Save enables again and the error clears.
		await desc.fill("Valid again.");
		await expect(save).toBeEnabled();
		await expect(page.locator(".refetch-error")).toHaveCount(0);
	} finally {
		await studio.close();
	}
});
