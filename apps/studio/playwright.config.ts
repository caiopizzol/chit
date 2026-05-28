import { defineConfig, devices } from "@playwright/test";

// Narrow first harness: cover the React Flow gesture contract that unit tests
// cannot reach (connection drag, Delete-key edge removal, real typing into the
// edit/save loop). Each spec spawns its own `chit studio <temp-fixture>`
// server via e2e/studio.ts, so workers=1 keeps server boots calm. Chromium
// only; no screenshots, video, or visual regression.
export default defineConfig({
	testDir: "./e2e",
	fullyParallel: false,
	workers: 1,
	forbidOnly: !!process.env.CI,
	reporter: "list",
	use: {
		trace: "off",
		screenshot: "off",
		video: "off",
	},
	projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
