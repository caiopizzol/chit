import { describe, expect, test } from "bun:test";
import { fakeAdapter } from "./adapter.ts";
import { parseManifest } from "./manifest.ts";
import type { ResolvedRoutine } from "./routine.ts";
import { type RunDeps, runOneShot } from "./run.ts";

function routineFrom(raw: unknown): ResolvedRoutine {
	const manifest = parseManifest(raw, "m.json");
	return { id: (raw as { id: string }).id, manifestPath: "m.json", manifestAbs: "/m.json", manifest, digest: "sha256:test" };
}

const GRILLER = {
	id: "griller",
	inputs: { idea: { type: "string" } },
	participants: { griller: { agent: "claude", instructions: "Read-only.", filesystem: "read-only" } },
	steps: [
		{ id: "grill", call: "griller", prompt: "Idea: {{ inputs.idea }}" },
		{ id: "out", format: "REPORT:\n{{ steps.grill.output }}" },
	],
	output: "out",
};

function deps(adapter: RunDeps["adapter"]): RunDeps {
	let t = 0;
	return { adapter, cwd: "/work", now: () => (t += 10), newRunId: () => "run-1" };
}

describe("runOneShot", () => {
	test("runs call then format and returns a completed receipt", async () => {
		const adapter = fakeAdapter((req) => `GRILLED(${req.prompt})`);
		const r = await runOneShot(routineFrom(GRILLER), { idea: "dark mode" }, deps(adapter));

		expect(r.status).toBe("completed");
		expect(r.runId).toBe("run-1");
		expect(r.policy).toBe("one-shot");
		expect(r.output).toBe("REPORT:\nGRILLED(Idea: dark mode)");
		expect(r.steps.map((s) => [s.id, s.kind, s.status])).toEqual([
			["grill", "call", "ok"],
			["out", "format", "ok"],
		]);
		expect(r.steps[0]).toMatchObject({ participant: "griller", agent: "claude" });
		expect(r.finishedAt).toBeGreaterThan(r.startedAt);
	});

	test("passes the participant's instructions, filesystem, and cwd to the adapter", async () => {
		const adapter = fakeAdapter();
		await runOneShot(routineFrom(GRILLER), { idea: "x" }, deps(adapter));
		expect(adapter.calls[0]).toMatchObject({
			agent: "claude",
			instructions: "Read-only.",
			prompt: "Idea: x",
			filesystem: "read-only",
			cwd: "/work",
		});
	});

	test("carries scope onto the receipt when given", async () => {
		const r = await runOneShot(routineFrom(GRILLER), { idea: "x" }, deps(fakeAdapter()), { scope: "feat-x" });
		expect(r.scope).toBe("feat-x");
	});

	test("derives the per-call timeout from the routine's limits and passes it to the adapter", async () => {
		// default: no limits -> the built-in 30-minute per-call bound
		const def = fakeAdapter();
		await runOneShot(routineFrom(GRILLER), { idea: "x" }, deps(def));
		expect(def.calls[0]?.timeoutMs).toBe(30 * 60_000);

		// numeric override flows straight through
		const limited = fakeAdapter();
		await runOneShot(routineFrom({ ...GRILLER, limits: { callTimeoutMinutes: 5 } }), { idea: "x" }, deps(limited));
		expect(limited.calls[0]?.timeoutMs).toBe(5 * 60_000);

		// "none" means no bound: the adapter is called without a timeout
		const unbounded = fakeAdapter();
		await runOneShot(routineFrom({ ...GRILLER, limits: { callTimeoutMinutes: "none" } }), { idea: "x" }, deps(unbounded));
		expect(unbounded.calls[0]?.timeoutMs).toBeUndefined();
	});

	test("a failing adapter fails the run and stops before later steps", async () => {
		const adapter: RunDeps["adapter"] = {
			async call() {
				throw new Error("model unavailable");
			},
		};
		const r = await runOneShot(routineFrom(GRILLER), { idea: "x" }, deps(adapter));
		expect(r.status).toBe("failed");
		expect(r.error).toMatch(/model unavailable/);
		expect(r.output).toBeUndefined();
		// only the failed call step is recorded; the format step never ran
		expect(r.steps.map((s) => s.id)).toEqual(["grill"]);
		expect(r.steps[0]?.status).toBe("failed");
	});

	test("enforces runTimeoutMinutes as a whole-run wall-time bound", async () => {
		const limited = routineFrom({ ...GRILLER, limits: { runTimeoutMinutes: 1 } });
		// clock advances 20s per read; by the 2nd step the 1-minute budget is blown
		let i = 0;
		const clock = () => (i += 20_000);
		const r = await runOneShot(limited, { idea: "x" }, { adapter: fakeAdapter(), cwd: "/work", now: clock, newRunId: () => "run-1" });
		expect(r.status).toBe("failed");
		expect(r.error).toMatch(/wall-time/);
		expect(r.steps.map((s) => s.id)).toEqual(["grill"]); // the format step never ran
	});

	test("a pre-aborted signal cancels the run before any step runs", async () => {
		const controller = new AbortController();
		controller.abort();
		const adapter = fakeAdapter();
		const r = await runOneShot(routineFrom(GRILLER), { idea: "x" }, { ...deps(adapter), signal: controller.signal });
		expect(r.status).toBe("cancelled");
		expect(r.steps).toHaveLength(0);
		expect(adapter.calls).toHaveLength(0);
		expect(r.error).toBe("cancelled by operator");
		expect(r.output).toBeUndefined();
	});

	test("a call interrupted by the signal cancels the run (not fails it)", async () => {
		const controller = new AbortController();
		const adapter: RunDeps["adapter"] = {
			async call() {
				controller.abort(); // mimic spawnCapture killing the child mid-call
				throw new Error("claude call cancelled");
			},
		};
		const r = await runOneShot(routineFrom(GRILLER), { idea: "x" }, { ...deps(adapter), signal: controller.signal });
		expect(r.status).toBe("cancelled");
		expect(r.error).toBe("cancelled by operator");
	});

	test("a template error in a format step fails the run", async () => {
		const bad = {
			...GRILLER,
			steps: [
				{ id: "grill", call: "griller", prompt: "p" },
				{ id: "out", format: "{{ steps.ghost.output }}" },
			],
		};
		const r = await runOneShot(routineFrom(bad), { idea: "x" }, deps(fakeAdapter()));
		expect(r.status).toBe("failed");
		expect(r.steps.map((s) => [s.id, s.status])).toEqual([
			["grill", "ok"],
			["out", "failed"],
		]);
	});
});
