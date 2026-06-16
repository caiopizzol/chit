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
	agents: { griller: { profile: "claude", instructions: "Read-only.", filesystem: "read-only" } },
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
		// timeline: each step carries an absolute startedAt within the run's window, in order
		expect(r.steps[0]?.startedAt).toBeGreaterThanOrEqual(r.startedAt);
		expect(r.steps[1]?.startedAt ?? 0).toBeGreaterThan(r.steps[0]?.startedAt ?? 0);
	});

	test("passes the agent's instructions, filesystem, and cwd to the adapter", async () => {
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
		// the active step is recorded so the timeline shows what was interrupted
		expect(r.steps.at(-1)).toMatchObject({ id: "grill", status: "cancelled" });
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

describe("runOneShot -- ask steps", () => {
	// grill -> ask the operator -> format the answer in. The ask question itself templates
	// in grill's output, so the operator decides with context.
	const ASK = {
		id: "clarify",
		inputs: { idea: { type: "string" } },
		agents: { griller: { profile: "claude", instructions: "Grill.", filesystem: "read-only" } },
		steps: [
			{ id: "grill", call: "griller", prompt: "Idea: {{ inputs.idea }}" },
			{ id: "decide", ask: "Refine?\n{{ steps.grill.output }}" },
			{ id: "out", format: "FINAL: {{ steps.decide.output }}" },
		],
		output: "out",
	};

	test("captures the operator answer and feeds it forward; the question renders with prior output", async () => {
		const adapter = fakeAdapter((req) => `GRILLED(${req.prompt})`);
		const asked: string[] = [];
		const askUser = async (q: string) => {
			asked.push(q);
			return "make it dark";
		};
		const r = await runOneShot(routineFrom(ASK), { idea: "x" }, { ...deps(adapter), askUser });
		expect(r.status).toBe("completed");
		expect(asked).toEqual(["Refine?\nGRILLED(Idea: x)"]);
		expect(r.output).toBe("FINAL: make it dark");
		expect(r.steps.map((s) => [s.id, s.kind, s.status])).toEqual([
			["grill", "call", "ok"],
			["decide", "ask", "ok"],
			["out", "format", "ok"],
		]);
	});

	test("the ask STEP receipt carries no answer body -- only status + timing", async () => {
		const r = await runOneShot(routineFrom(ASK), { idea: "x" }, { ...deps(fakeAdapter()), askUser: async () => "SENSITIVE-ANSWER" });
		const ask = r.steps.find((s) => s.id === "decide");
		// the receipt records exactly id/kind/status/startedAt/elapsedMs -- no answer field
		expect(Object.keys(ask ?? {}).sort()).toEqual(["elapsedMs", "id", "kind", "startedAt", "status"]);
		// (the answer does reach r.output here, but only because this routine formats it into
		// its `out` step -- that is the operator's explicit choice, not the ask step leaking.)
	});

	test("an ask step with no input handler wired fails the run", async () => {
		const r = await runOneShot(routineFrom(ASK), { idea: "x" }, deps(fakeAdapter()));
		expect(r.status).toBe("failed");
		expect(r.error).toMatch(/no input handler is wired/);
		expect(r.steps.map((s) => [s.id, s.status])).toEqual([
			["grill", "ok"],
			["decide", "failed"],
		]);
	});

	test("the implicit output skips a trailing ask step (the answer is not the run's product)", async () => {
		const trailing = {
			id: "trailing",
			inputs: { idea: { type: "string" } },
			agents: { griller: { profile: "claude", instructions: "Grill.", filesystem: "read-only" } },
			steps: [
				{ id: "grill", call: "griller", prompt: "Idea: {{ inputs.idea }}" },
				{ id: "decide", ask: "any notes?" },
			],
		};
		const r = await runOneShot(routineFrom(trailing), { idea: "x" }, { ...deps(fakeAdapter((req) => `G(${req.prompt})`)), askUser: async () => "PRIVATE" });
		expect(r.status).toBe("completed");
		expect(r.output).toBe("G(Idea: x)"); // grill, not the answer
		expect(JSON.stringify(r)).not.toContain("PRIVATE");
	});

	test("a Ctrl-C during an ask cancels the run (records the ask as cancelled)", async () => {
		const controller = new AbortController();
		const askUser = async () => {
			controller.abort(); // mimic the bin rejecting the pending prompt on SIGINT
			throw new Error("cancelled");
		};
		const r = await runOneShot(routineFrom(ASK), { idea: "x" }, { ...deps(fakeAdapter((req) => `G(${req.prompt})`)), signal: controller.signal, askUser });
		expect(r.status).toBe("cancelled");
		expect(r.error).toBe("cancelled by operator");
		expect(r.steps.at(-1)).toMatchObject({ id: "decide", kind: "ask", status: "cancelled" });
	});
});

describe("runOneShot -- structured call output", () => {
	const EXTRACT = {
		id: "extract",
		inputs: { text: { type: "string" } },
		agents: { reader: { profile: "claude", instructions: "Extract.", filesystem: "read-only" } },
		steps: [
			{
				id: "fields",
				call: "reader",
				prompt: "Extract from {{ inputs.text }}",
				json: { schema: { type: "object", required: ["title"], properties: { title: { type: "string" } } } },
			},
		],
		output: "fields",
	};

	test("normalizes valid JSON output", async () => {
		const adapter = fakeAdapter(() => '{"title":"Hi"}');
		const r = await runOneShot(routineFrom(EXTRACT), { text: "x" }, deps(adapter));
		expect(r.status).toBe("completed");
		expect(r.output).toBe('{\n  "title": "Hi"\n}');
	});

	test("fails the run when output does not match the schema (no retry loop)", async () => {
		const adapter = fakeAdapter(() => "not json at all");
		const r = await runOneShot(routineFrom(EXTRACT), { text: "x" }, deps(adapter));
		expect(r.status).toBe("failed");
		expect(r.error).toMatch(/not valid JSON/);
		expect(r.steps[0]?.status).toBe("failed");
		expect(r.output).toBeUndefined();
	});
});
