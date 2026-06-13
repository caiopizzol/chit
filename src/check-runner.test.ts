import { describe, expect, test } from "bun:test";
import { argvCheckRunner, fakeCheckRunner } from "./check-runner.ts";
import type { Check } from "./manifest.ts";

const check: Check = { command: "bun", args: ["test"] };

describe("fakeCheckRunner", () => {
	test("returns the scripted result and records calls", async () => {
		const runner = fakeCheckRunner((_c, i) => ({ ok: i > 0, exitCode: i > 0 ? 0 : 1, output: i > 0 ? "" : "boom" }));
		const first = await runner.run(check, "/work");
		const second = await runner.run(check, "/work");
		expect(first).toEqual({ ok: false, exitCode: 1, output: "boom" });
		expect(second).toEqual({ ok: true, exitCode: 0, output: "" });
		expect(runner.calls).toHaveLength(2);
		expect(runner.calls[0]).toEqual({ check, cwd: "/work" });
	});

	test("defaults to passing", async () => {
		expect(await fakeCheckRunner().run(check, "/x")).toEqual({ ok: true, exitCode: 0, output: "" });
	});
});

describe("argvCheckRunner", () => {
	test("reports a passing command", async () => {
		const r = await argvCheckRunner.run({ command: "true", args: [] }, process.cwd());
		expect(r.ok).toBe(true);
		expect(r.exitCode).toBe(0);
	});

	test("reports a failing command with output", async () => {
		const r = await argvCheckRunner.run({ command: "sh", args: ["-c", "echo nope >&2; exit 3"] }, process.cwd());
		expect(r.ok).toBe(false);
		expect(r.exitCode).toBe(3);
		expect(r.output).toContain("nope");
	});
});
