import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { launchStudio } from "./studio.ts";

// Real connection drag: the gesture unit tests cannot reach. Drag from the
// ask_codex source handle to the out target handle; the reference token must
// be appended and the edge must appear, and saving must persist it to disk.
test("drag-to-connect appends a reference, shows the edge, and persists on save", async ({
	page,
}) => {
	const studio = await launchStudio("wire.json");
	try {
		await page.goto(studio.url);
		await expect(page.locator('.react-flow__node[data-id="ask_codex"]')).toBeVisible();
		const edge = page.locator('.react-flow__edge[aria-label="Edge from ask_codex to out"]');
		await expect(edge).toHaveCount(0); // not connected yet

		const src = page.locator('.react-flow__node[data-id="ask_codex"] .react-flow__handle.source');
		const tgt = page.locator('.react-flow__node[data-id="out"] .react-flow__handle.target');
		const s = await src.boundingBox();
		const t = await tgt.boundingBox();
		if (!s || !t) throw new Error("handles not found");

		await page.mouse.move(s.x + s.width / 2, s.y + s.height / 2);
		await page.mouse.down();
		await page.mouse.move(s.x + 60, s.y + 30); // wiggle so RF starts the connection
		await page.mouse.move(t.x + t.width / 2, t.y + t.height / 2, { steps: 5 });
		await page.mouse.up();

		await expect(edge).toHaveCount(1); // edge now rendered

		await page.getByRole("button", { name: "Save", exact: true }).click();
		await page.getByRole("button", { name: "Write to disk" }).click();

		await expect
			.poll(() => JSON.parse(readFileSync(studio.file, "utf-8")).steps.out.format)
			.toContain("{{ steps.ask_codex.output }}");
	} finally {
		await studio.close();
	}
});
