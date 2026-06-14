import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { fakeAdapter } from "./adapter.ts";
import { loadConfig } from "./config.ts";
import { kindLabel } from "./manifest.ts";
import { resolveRoutine } from "./routine.ts";
import { runOneShot } from "./run.ts";
import { scaffoldRoutine } from "./scaffold.ts";

const dirs: string[] = [];
function tmp(): string {
	const d = mkdtempSync(join(tmpdir(), "chit-scaffold-"));
	dirs.push(d);
	return d;
}
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("scaffoldRoutine", () => {
	test("text template: creates the config and a manifest that resolves and RUNS", async () => {
		const cwd = tmp();
		const res = scaffoldRoutine(cwd, "review", "text");
		expect(res.createdConfig).toBe(true);
		expect(res.manifestPath).toBe("examples/review.json");
		expect(existsSync(join(cwd, "examples/review.json"))).toBe(true);

		// registered in the config and resolves to a valid text routine
		const config = loadConfig(cwd);
		expect(config.routines.review?.manifestPath).toBe("examples/review.json");
		const routine = resolveRoutine(config, "review", cwd);
		expect(kindLabel(routine.manifest)).toBe("text");

		// and it actually runs end to end (the whole point of a scaffold)
		const r = await runOneShot(routine, { topic: "dark mode" }, { adapter: fakeAdapter((req) => `ANSWER(${req.prompt})`), cwd, now: () => 0, newRunId: () => "r" });
		expect(r.status).toBe("completed");
		expect(r.output).toContain("ANSWER(");
		expect(r.output).toContain("dark mode"); // the input was templated into the prompt
	});

	test("loop template: resolves to a sandboxed loop (check + repeat)", () => {
		const cwd = tmp();
		scaffoldRoutine(cwd, "impl", "loop");
		const routine = resolveRoutine(loadConfig(cwd), "impl", cwd);
		expect(kindLabel(routine.manifest)).toBe("loop");
	});

	test("check template: resolves to a check-only sandboxed routine", () => {
		const cwd = tmp();
		scaffoldRoutine(cwd, "smoke", "check");
		const routine = resolveRoutine(loadConfig(cwd), "smoke", cwd);
		expect(kindLabel(routine.manifest)).toBe("loop"); // has a repeat -> loop
	});

	test("adds to an existing config, preserving prior routines", () => {
		const cwd = tmp();
		scaffoldRoutine(cwd, "first", "text");
		const res = scaffoldRoutine(cwd, "second", "loop");
		expect(res.createdConfig).toBe(false);
		const config = loadConfig(cwd);
		expect(Object.keys(config.routines).sort()).toEqual(["first", "second"]);
	});

	test("rejects a duplicate routine name", () => {
		const cwd = tmp();
		scaffoldRoutine(cwd, "dup", "text");
		expect(() => scaffoldRoutine(cwd, "dup", "text")).toThrow(/already exists/);
	});

	test("rejects a non-kebab-case name", () => {
		const cwd = tmp();
		expect(() => scaffoldRoutine(cwd, "BadName", "text")).toThrow(/kebab-case/);
	});
});
