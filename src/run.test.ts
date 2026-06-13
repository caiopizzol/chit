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
