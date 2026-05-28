import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { launchStudio } from "./studio.ts";

// Real edge select + Delete key: the other gesture unit tests cannot reach.
// consult.json's out references both advisors; selecting the ask_codex -> out
// edge and pressing Delete must remove that reference and the edge, and saving
// must persist the removal.
test("select edge + Delete removes the reference, the edge, and persists on save", async ({
	page,
}) => {
	const studio = await launchStudio("consult.json");
	try {
		await page.goto(studio.url);
		const edge = page.locator('.react-flow__edge[aria-label="Edge from ask_codex to out"]');
		await expect(edge).toHaveCount(1); // present at start

		// Click the midpoint between the two handles: that lands on the edge's
		// curve (its wide interaction stroke), whereas clicking the edge group's
		// bbox center can miss the bezier entirely.
		const src = page.locator('.react-flow__node[data-id="ask_codex"] .react-flow__handle.source');
		const tgt = page.locator('.react-flow__node[data-id="out"] .react-flow__handle.target');
		const s = await src.boundingBox();
		const t = await tgt.boundingBox();
		if (!s || !t) throw new Error("handles not found");
		const mx = (s.x + s.width / 2 + (t.x + t.width / 2)) / 2;
		const my = (s.y + s.height / 2 + (t.y + t.height / 2)) / 2;
		await page.mouse.click(mx, my);

		// Selection must register before Delete has a target.
		await expect(
			page.locator('.react-flow__edge.selected[aria-label="Edge from ask_codex to out"]'),
		).toHaveCount(1);

		await page.keyboard.press("Delete");
		await expect(edge).toHaveCount(0); // gone after disconnect + re-render

		await page.getByRole("button", { name: "Save", exact: true }).click();
		await page.getByRole("button", { name: "Write to disk" }).click();

		await expect
			.poll(() => JSON.parse(readFileSync(studio.file, "utf-8")).steps.out.format)
			.not.toContain("{{ steps.ask_codex.output }}");
		// the other advisor's reference is untouched
		expect(JSON.parse(readFileSync(studio.file, "utf-8")).steps.out.format).toContain(
			"{{ steps.ask_claude.output }}",
		);
	} finally {
		await studio.close();
	}
});
