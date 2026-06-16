import { describe, expect, test } from "bun:test";
import { withHeartbeat } from "./heartbeat.ts";

describe("withHeartbeat", () => {
	test("returns the work's result and emits no heartbeat for fast work", async () => {
		const lines: string[] = [];
		const r = await withHeartbeat(async () => 42, {
			label: "call x",
			now: () => 0,
			onProgress: (l) => lines.push(l),
			intervalMs: 10,
		});
		expect(r).toBe(42);
		expect(lines).toEqual([]); // resolved well before the first tick
	});

	test("runs untouched when no progress sink is wired", async () => {
		const r = await withHeartbeat(async () => "ok", { label: "call x", now: () => 0 });
		expect(r).toBe("ok");
	});

	test("emits a periodic heartbeat while slow work is in flight", async () => {
		const lines: string[] = [];
		let t = 0;
		const r = await withHeartbeat(() => new Promise<string>((res) => setTimeout(() => res("done"), 80)), {
			label: "call critic",
			now: () => (t += 1000), // each read advances the displayed elapsed deterministically
			onProgress: (l) => lines.push(l),
			intervalMs: 15,
		});
		expect(r).toBe("done");
		expect(lines.length).toBeGreaterThanOrEqual(1);
		expect(lines.every((l) => l.includes("call critic still running..."))).toBe(true);
	});

	test("clears the timer and propagates errors", async () => {
		const lines: string[] = [];
		await expect(
			withHeartbeat(
				async () => {
					throw new Error("boom");
				},
				{ label: "call x", now: () => 0, onProgress: (l) => lines.push(l), intervalMs: 10 },
			),
		).rejects.toThrow("boom");
		expect(lines).toEqual([]); // threw before the first tick; timer cleared in finally
	});
});
