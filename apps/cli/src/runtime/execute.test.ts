import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NormalizedManifest } from "@chit/core";
import { parseManifest } from "@chit/core";
import { buildAgentInput, executeManifest } from "./execute.ts";
import { RuntimeError } from "./render.ts";
import type { AdapterCallRequest, RuntimeAdapter, TraceEvent } from "./types.ts";

const EXAMPLES = join(import.meta.dir, "..", "..", "..", "..", "examples");

function loadExample(name: string): NormalizedManifest {
	return parseManifest(JSON.parse(readFileSync(join(EXAMPLES, `${name}.json`), "utf8")));
}

function echoAdapter(label: string): RuntimeAdapter {
	return {
		call: (req: AdapterCallRequest) =>
			Promise.resolve({ output: `[${label}:${req.stepId}] ${req.input}` }),
	};
}

function recordingAdapter(): { adapter: RuntimeAdapter; calls: AdapterCallRequest[] } {
	const calls: AdapterCallRequest[] = [];
	const adapter: RuntimeAdapter = {
		call: (req) => {
			calls.push(req);
			return Promise.resolve({ output: `OK:${req.stepId}` });
		},
	};
	return { adapter, calls };
}

let TMPDIR: string;
const TMPFILES: string[] = [];

beforeAll(() => {
	TMPDIR = mkdtempSync(join(tmpdir(), "chit-test-"));
	for (const name of ["a.ts", "b.ts"]) {
		const p = join(TMPDIR, name);
		writeFileSync(p, `// ${name}\n`);
		TMPFILES.push(p);
	}
});

afterAll(() => {
	rmSync(TMPDIR, { recursive: true, force: true });
});

describe("buildAgentInput", () => {
	test("constructs Role/Task envelope", () => {
		expect(buildAgentInput("R", "T")).toBe("Role:\nR\n\nTask:\nT");
	});
});

describe("executeManifest: consult (parallel fan-out)", () => {
	test("runs both advisors and produces formatted output", async () => {
		const manifest = loadExample("consult");
		const result = await executeManifest(manifest, {
			inputs: { question: "what?" },
			adapters: { codex: echoAdapter("codex"), claude: echoAdapter("claude") },
			invocationCwd: TMPDIR,
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.output).toContain("## codex");
		expect(result.output).toContain("[codex:ask_codex]");
		expect(result.output).toContain("## claude");
		expect(result.output).toContain("[claude:ask_claude]");
		expect(result.outputs.ask_codex).toBeDefined();
		expect(result.outputs.ask_claude).toBeDefined();
		expect(result.outputs.out).toBe(result.output);
	});

	test("both parallel steps start before either completes", async () => {
		const manifest = loadExample("consult");
		const events: TraceEvent[] = [];
		await executeManifest(manifest, {
			inputs: { question: "x" },
			adapters: { codex: echoAdapter("c"), claude: echoAdapter("cl") },
			invocationCwd: TMPDIR,
			onTrace: (e) => events.push(e),
		});

		const startedIdx = (id: string) =>
			events.findIndex((e) => e.type === "step.started" && e.stepId === id);
		const completedIdx = (id: string) =>
			events.findIndex((e) => e.type === "step.completed" && e.stepId === id);

		const lastStart = Math.max(startedIdx("ask_codex"), startedIdx("ask_claude"));
		const firstCompletion = Math.min(completedIdx("ask_codex"), completedIdx("ask_claude"));
		expect(lastStart).toBeLessThan(firstCompletion);
	});

	test("adapter receives role envelope", async () => {
		const { adapter, calls } = recordingAdapter();
		const manifest = loadExample("consult");
		await executeManifest(manifest, {
			inputs: { question: "what?" },
			adapters: { codex: adapter, claude: adapter },
			invocationCwd: TMPDIR,
		});

		expect(calls.length).toBe(2);
		for (const c of calls) {
			expect(c.input.startsWith("Role:\nSecond opinion advisor.")).toBe(true);
			expect(c.input).toContain("\n\nTask:\nwhat?");
			expect(c.stepId).toMatch(/^(ask_codex|ask_claude)$/);
			expect(c.agentId).toMatch(/^(codex|claude)$/);
			expect(c.participantId).toMatch(/^(codex|claude)$/);
		}
	});
});

describe("executeManifest: investigate-bug (sequential with verification)", () => {
	test("pipes diagnose output into verify and produces formatted final output", async () => {
		const { adapter, calls } = recordingAdapter();
		const manifest = loadExample("investigate-bug");

		const result = await executeManifest(manifest, {
			inputs: { issue: "login hangs" },
			adapters: { codex: adapter, claude: adapter },
			invocationCwd: TMPDIR,
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;

		expect(calls.length).toBe(2);
		expect(calls[0]?.stepId).toBe("diagnose");
		expect(calls[1]?.stepId).toBe("verify");
		expect(calls[1]?.input).toContain("OK:diagnose");
		expect(calls[1]?.input).toContain("login hangs");

		expect(result.output).toContain("## Diagnosis");
		expect(result.output).toContain("OK:diagnose");
		expect(result.output).toContain("## Verification");
		expect(result.output).toContain("OK:verify");
	});

	test("file[] inputs render as newline-joined absolute paths", async () => {
		const { adapter, calls } = recordingAdapter();
		const manifest = loadExample("investigate-bug");

		await executeManifest(manifest, {
			inputs: { issue: "x", files: TMPFILES },
			adapters: { codex: adapter, claude: adapter },
			invocationCwd: TMPDIR,
		});

		const diagnoseCall = calls.find((c) => c.stepId === "diagnose");
		expect(diagnoseCall).toBeDefined();
		expect(diagnoseCall?.input).toContain(TMPFILES.join("\n"));
	});

	test("relative file paths resolve against invocationCwd", async () => {
		const { adapter, calls } = recordingAdapter();
		const manifest = loadExample("investigate-bug");

		await executeManifest(manifest, {
			inputs: { issue: "x", files: ["a.ts", "b.ts"] },
			adapters: { codex: adapter, claude: adapter },
			invocationCwd: TMPDIR,
		});

		const diagnoseCall = calls.find((c) => c.stepId === "diagnose");
		expect(diagnoseCall?.input).toContain(join(TMPDIR, "a.ts"));
		expect(diagnoseCall?.input).toContain(join(TMPDIR, "b.ts"));
	});

	test("absent optional file[] renders as empty string", async () => {
		const { adapter, calls } = recordingAdapter();
		const manifest = loadExample("investigate-bug");

		await executeManifest(manifest, {
			inputs: { issue: "x" },
			adapters: { codex: adapter, claude: adapter },
			invocationCwd: TMPDIR,
		});

		const diagnoseCall = calls.find((c) => c.stepId === "diagnose");
		expect(diagnoseCall?.input).toContain("Relevant files:\n");
		// the prompt template ends with "{{ inputs.files }}" so an absent value
		// leaves a trailing newline-bounded empty region rather than additional content
		expect(diagnoseCall?.input.endsWith("Relevant files:\n")).toBe(true);
	});
});

describe("executeManifest: failure modes", () => {
	test("step failure yields failure envelope with partial outputs", async () => {
		const manifest = loadExample("investigate-bug");
		const failing: RuntimeAdapter = {
			call: (req) => {
				if (req.stepId === "verify") return Promise.reject(new Error("verify exploded"));
				return Promise.resolve({ output: `OK:${req.stepId}` });
			},
		};
		const events: TraceEvent[] = [];

		const result = await executeManifest(manifest, {
			inputs: { issue: "x" },
			adapters: { codex: failing, claude: failing },
			invocationCwd: TMPDIR,
			onTrace: (e) => events.push(e),
		});

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.failedStep).toBe("verify");
		expect(result.error).toContain("verify exploded");
		expect(result.outputs.diagnose).toBe("OK:diagnose");
		expect(result.outputs.verify).toBeUndefined();
		expect(result.outputs.out).toBeUndefined();

		const failedEvent = events.find((e) => e.type === "step.failed");
		expect(failedEvent).toBeDefined();
		if (failedEvent?.type === "step.failed") {
			expect(failedEvent.stepId).toBe("verify");
			expect(failedEvent.error).toContain("verify exploded");
		}
	});

	test("missing required input rejects with RuntimeError", async () => {
		const manifest = loadExample("investigate-bug");
		await expect(
			executeManifest(manifest, {
				inputs: {},
				adapters: { codex: echoAdapter("c"), claude: echoAdapter("cl") },
				invocationCwd: TMPDIR,
			}),
		).rejects.toBeInstanceOf(RuntimeError);
	});

	test("unknown input rejects with RuntimeError", async () => {
		const manifest = loadExample("investigate-bug");
		await expect(
			executeManifest(manifest, {
				inputs: { issue: "x", bogus: 1 },
				adapters: { codex: echoAdapter("c"), claude: echoAdapter("cl") },
				invocationCwd: TMPDIR,
			}),
		).rejects.toBeInstanceOf(RuntimeError);
	});

	test("nonexistent file path rejects with RuntimeError", async () => {
		const manifest = loadExample("investigate-bug");
		await expect(
			executeManifest(manifest, {
				inputs: { issue: "x", files: ["does-not-exist.ts"] },
				adapters: { codex: echoAdapter("c"), claude: echoAdapter("cl") },
				invocationCwd: TMPDIR,
			}),
		).rejects.toBeInstanceOf(RuntimeError);
	});

	test("missing adapter rejected upfront", async () => {
		const manifest = loadExample("consult");
		await expect(
			executeManifest(manifest, {
				inputs: { question: "x" },
				adapters: { codex: echoAdapter("c") },
				invocationCwd: TMPDIR,
			}),
		).rejects.toThrow(/no adapter registered/);
	});

	test("wrong input type rejected", async () => {
		const manifest = loadExample("investigate-bug");
		await expect(
			executeManifest(manifest, {
				inputs: { issue: 123 },
				adapters: { codex: echoAdapter("c"), claude: echoAdapter("cl") },
				invocationCwd: TMPDIR,
			}),
		).rejects.toThrow(/must be a string/);
	});
});

describe("executeManifest: trace events", () => {
	test("trace is returned in result even without onTrace", async () => {
		const manifest = loadExample("investigate-bug");
		const result = await executeManifest(manifest, {
			inputs: { issue: "x" },
			adapters: { codex: echoAdapter("c"), claude: echoAdapter("cl") },
			invocationCwd: TMPDIR,
		});

		expect(result.ok).toBe(true);
		expect(result.trace.length).toBeGreaterThan(0);
		const startedIds = result.trace
			.filter((e) => e.type === "step.started")
			.map((e) => e.stepId)
			.sort();
		expect(startedIds).toEqual(["diagnose", "out", "verify"]);
	});

	test("onTrace receives the same events as result.trace", async () => {
		const manifest = loadExample("investigate-bug");
		const liveEvents: TraceEvent[] = [];
		const result = await executeManifest(manifest, {
			inputs: { issue: "x" },
			adapters: { codex: echoAdapter("c"), claude: echoAdapter("cl") },
			invocationCwd: TMPDIR,
			onTrace: (e) => liveEvents.push(e),
		});

		expect(liveEvents).toEqual(result.trace);
	});

	test("call step.completed carries adapter usage; format step does not", async () => {
		const manifest = loadExample("investigate-bug");
		const usageAdapter: RuntimeAdapter = {
			call: (req) =>
				Promise.resolve({
					output: `OK:${req.stepId}`,
					usage: { inputTokens: 10, outputTokens: 2, estimatedCostUsd: 0.001 },
				}),
		};
		const result = await executeManifest(manifest, {
			inputs: { issue: "x" },
			adapters: { codex: usageAdapter, claude: usageAdapter },
			invocationCwd: TMPDIR,
		});
		expect(result.ok).toBe(true);

		const completed = result.trace.filter((e) => e.type === "step.completed");
		// A call step (diagnose) carries the adapter's usage through the trace.
		const diagnose = completed.find((e) => e.stepId === "diagnose");
		expect(diagnose?.type === "step.completed" && diagnose.usage).toEqual({
			inputTokens: 10,
			outputTokens: 2,
			estimatedCostUsd: 0.001,
		});
		// The format step (out) has no adapter call, so no usage.
		const out = completed.find((e) => e.stepId === "out");
		expect(out?.type === "step.completed" && "usage" in out).toBe(false);
	});

	test("failure trace includes step.failed event", async () => {
		const manifest = loadExample("investigate-bug");
		const failing: RuntimeAdapter = {
			call: (req) =>
				req.stepId === "verify"
					? Promise.reject(new Error("boom"))
					: Promise.resolve({ output: `OK:${req.stepId}` }),
		};

		const result = await executeManifest(manifest, {
			inputs: { issue: "x" },
			adapters: { codex: failing, claude: failing },
			invocationCwd: TMPDIR,
		});

		expect(result.ok).toBe(false);
		const failed = result.trace.find((e) => e.type === "step.failed");
		expect(failed).toBeDefined();
		if (failed?.type === "step.failed") {
			expect(failed.stepId).toBe("verify");
			expect(failed.error).toContain("boom");
		}
		// No step.completed for verify
		expect(result.trace.some((e) => e.type === "step.completed" && e.stepId === "verify")).toBe(
			false,
		);
	});

	test("emits started+completed for each non-failed step", async () => {
		const manifest = loadExample("investigate-bug");
		const events: TraceEvent[] = [];
		await executeManifest(manifest, {
			inputs: { issue: "x" },
			adapters: { codex: echoAdapter("c"), claude: echoAdapter("cl") },
			invocationCwd: TMPDIR,
			onTrace: (e) => events.push(e),
		});

		const startedIds = events
			.filter((e) => e.type === "step.started")
			.map((e) => e.stepId)
			.sort();
		const completedIds = events
			.filter((e) => e.type === "step.completed")
			.map((e) => e.stepId)
			.sort();
		expect(startedIds).toEqual(["diagnose", "out", "verify"]);
		expect(completedIds).toEqual(["diagnose", "out", "verify"]);
		expect(events.some((e) => e.type === "step.failed")).toBe(false);
	});
});

describe("executeManifest: cancellation (signal)", () => {
	test("threads the run's signal to every adapter call", async () => {
		const manifest = loadExample("ask-codex");
		const { adapter, calls } = recordingAdapter();
		const controller = new AbortController();
		const result = await executeManifest(manifest, {
			inputs: { question: "x" },
			adapters: { codex: adapter },
			invocationCwd: TMPDIR,
			signal: controller.signal,
		});
		expect(result.ok).toBe(true);
		// The one call step (ask) received the exact signal the run was given.
		expect(calls.length).toBe(1);
		expect(calls[0]?.signal).toBe(controller.signal);
	});

	test("omitting the signal leaves adapter calls with no signal (CLI path unchanged)", async () => {
		const manifest = loadExample("ask-codex");
		const { adapter, calls } = recordingAdapter();
		const result = await executeManifest(manifest, {
			inputs: { question: "x" },
			adapters: { codex: adapter },
			invocationCwd: TMPDIR,
		});
		expect(result.ok).toBe(true);
		expect(calls[0]?.signal).toBeUndefined();
	});

	test("an already-aborted signal fails the step before the adapter is called", async () => {
		const manifest = loadExample("ask-codex");
		const { adapter, calls } = recordingAdapter();
		const controller = new AbortController();
		controller.abort();
		const result = await executeManifest(manifest, {
			inputs: { question: "x" },
			adapters: { codex: adapter },
			invocationCwd: TMPDIR,
			signal: controller.signal,
		});
		// The call step never reaches the adapter; the run fails at that step with
		// no partial output (a cancelled run is not a successful one).
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.failedStep).toBe("ask");
		expect(result.error).toMatch(/cancelled before start/);
		expect(calls.length).toBe(0);
	});

	test("an adapter that returns after the signal aborts does not commit a completed step", async () => {
		const manifest = loadExample("ask-codex");
		const controller = new AbortController();
		// An adapter that aborts mid-call (a late abort, or one that ignores the
		// signal) and still resolves successfully. The post-call guard must discard
		// that output rather than commit a cancelled call as a completed step --
		// otherwise a converge iteration cancelled in its last step would record a
		// fake-successful round.
		const ignoresAbort: RuntimeAdapter = {
			call: async () => {
				controller.abort();
				return { output: "late output after abort" };
			},
		};
		const events: TraceEvent[] = [];
		const result = await executeManifest(manifest, {
			inputs: { question: "x" },
			adapters: { codex: ignoresAbort },
			invocationCwd: TMPDIR,
			signal: controller.signal,
			onTrace: (e) => events.push(e),
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.failedStep).toBe("ask");
		expect(result.error).toMatch(/cancelled/);
		// The late output is never committed: no completed event, no output value.
		expect(result.outputs.ask).toBeUndefined();
		expect(events.some((e) => e.type === "step.completed" && e.stepId === "ask")).toBe(false);
	});
});
