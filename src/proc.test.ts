import { describe, expect, test } from "bun:test";
import { spawnCapture } from "./proc.ts";

describe("spawnCapture", () => {
	test("captures stdout and the exit code", async () => {
		const r = await spawnCapture(["echo", "hello"], { cwd: process.cwd() });
		expect(r.exitCode).toBe(0);
		expect(r.stdout.trim()).toBe("hello");
		expect(r.timedOut).toBe(false);
	});

	test("pipes stdin", async () => {
		const r = await spawnCapture(["cat"], { cwd: process.cwd(), stdin: "piped-in" });
		expect(r.stdout).toBe("piped-in");
	});

	test("reports a non-zero exit without timing out", async () => {
		const r = await spawnCapture(["sh", "-c", "echo oops >&2; exit 3"], { cwd: process.cwd() });
		expect(r.exitCode).toBe(3);
		expect(r.timedOut).toBe(false);
		expect(r.stderr).toContain("oops");
	});

	test("kills and flags a process that exceeds the timeout, quickly", async () => {
		const start = Date.now();
		const r = await spawnCapture(["sleep", "5"], { cwd: process.cwd(), timeoutMs: 150 });
		expect(r.timedOut).toBe(true);
		// killed near the timeout, not after the full 5s sleep
		expect(Date.now() - start).toBeLessThan(2500);
	});
});
