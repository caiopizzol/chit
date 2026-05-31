import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AdapterCallCompletedEvent, type NormalizedRegistry, parseManifest } from "@chit/core";
import { loadRegistry } from "../../agents/parse.ts";
import { AuditRecorder } from "../../audit/recorder.ts";
import { AuditStore } from "../../audit/store.ts";
import { wrapAdaptersWithAudit } from "../../audit/wrap.ts";
import { prepareInputs } from "../../runtime/render.ts";
import type { AdapterCallResult, AdapterMap, RuntimeAdapter } from "../../runtime/types.ts";
import {
	cancelStep,
	controllerKey,
	isComplete,
	type Run,
	readySteps,
	runStep,
	type StepControllers,
	startRun,
} from "./engine.ts";

// A two-step chain: a (from input) -> b (from a's output). deps: a=[], b=[a].
const CHAIN = {
	schema: 1,
	id: "chain",
	description: "test chain",
	inputs: { x: { type: "string" } },
	participants: { p: { agent: "fake", role: "r", session: "stateless" } },
	steps: {
		a: { call: "p", prompt: "{{ inputs.x }}" },
		b: { call: "p", prompt: "{{ steps.a.output }}" },
	},
	output: "b",
};

// Build a Run with injected adapters, bypassing real adapter construction so
// tests can control timing/failure. Mirrors startRun's record init.
function makeRun(raw: unknown, inputs: Record<string, unknown>, adapters: AdapterMap): Run {
	const manifest = parseManifest(raw);
	const records: Run["records"] = {};
	for (const [stepId, step] of Object.entries(manifest.steps)) {
		records[stepId] =
			step.kind === "call"
				? {
						stepId,
						kind: "call",
						participantId: step.call,
						agentId: manifest.participants[step.call]?.agent,
						session: manifest.participants[step.call]?.session,
						status: "pending",
					}
				: { stepId, kind: "format", status: "pending" };
	}
	return {
		runId: "t",
		manifest,
		preparedInputs: prepareInputs(manifest.inputs, inputs, "/tmp"),
		adapters,
		invocationCwd: "/tmp",
		outputs: {},
		records,
		startedAtMs: 0,
	};
}

const immediate = (output: string): AdapterMap => ({
	fake: { call: async () => ({ output }) },
});

describe("mcp engine: ready order + DAG guardrail", () => {
	test("only the input-rooted step is ready at start", () => {
		const run = makeRun(CHAIN, { x: "hi" }, immediate("A"));
		expect(readySteps(run)).toEqual(["a"]);
	});

	test("running a step advances the ready set to its dependents", async () => {
		const run = makeRun(CHAIN, { x: "hi" }, immediate("A"));
		await runStep(run, "a", () => {});
		expect(run.records.a?.status).toBe("done");
		expect(run.outputs.a).toBe("A");
		expect(readySteps(run)).toEqual(["b"]);
		expect(isComplete(run)).toBe(false);
	});

	test("out-of-order step is rejected with its unmet deps", async () => {
		const run = makeRun(CHAIN, { x: "hi" }, immediate("A"));
		await expect(runStep(run, "b", () => {})).rejects.toThrow(/not ready; waiting on: a/);
	});

	test("propose-verify-revise: ready order matches the declared DAG", () => {
		const raw = {
			schema: 1,
			id: "pvr",
			description: "d",
			inputs: { task: { type: "string" } },
			participants: {
				proposer: { agent: "fake", role: "r", session: "stateless" },
				verifier: { agent: "fake", role: "r", session: "stateless" },
			},
			steps: {
				propose: { call: "proposer", prompt: "{{ inputs.task }}" },
				verify: { call: "verifier", prompt: "{{ steps.propose.output }}" },
				revise: { call: "proposer", prompt: "{{ steps.verify.output }}" },
				out: { format: "{{ steps.revise.output }}" },
			},
			output: "out",
		};
		const run = makeRun(raw, { task: "x" }, immediate("A"));
		expect(readySteps(run)).toEqual(["propose"]);
	});
});

describe("mcp engine: running-state lock", () => {
	test("a concurrent runStep on the same in-flight step is rejected", async () => {
		// Never-resolving adapter: the first call stays in flight so we can race a
		// second call against it.
		let release!: (r: AdapterCallResult) => void;
		const gate = new Promise<AdapterCallResult>((r) => {
			release = r;
		});
		const adapters: AdapterMap = { fake: { call: () => gate } };
		const run = makeRun(CHAIN, { x: "hi" }, adapters);

		const first = runStep(run, "a", () => {});
		// Synchronously after kicking off the first call, the record is "running".
		expect(run.records.a?.status).toBe("running");

		// A second call on the same step must be rejected, not spawn again.
		await expect(runStep(run, "a", () => {})).rejects.toThrow(/already running/);

		// Let the first finish; it still completes cleanly.
		release({ output: "A" });
		await first;
		expect(run.records.a?.status).toBe("done");
		expect(run.outputs.a).toBe("A");
	});
});

describe("mcp engine: cancellation", () => {
	test("aborting a running step marks it cancelled (not failed), blocks dependents, and is terminal", async () => {
		// Adapter that settles only when the signal aborts, mimicking a real
		// adapter that kills its child and rejects on abort.
		const adapters: AdapterMap = {
			fake: {
				call: (req) =>
					new Promise<AdapterCallResult>((_resolve, reject) => {
						req.signal?.addEventListener("abort", () => reject(new Error("aborted by client")), {
							once: true,
						});
					}),
			},
		};
		const run = makeRun(CHAIN, { x: "hi" }, adapters);
		const controller = new AbortController();

		const p = runStep(run, "a", () => {}, controller);
		expect(run.records.a?.status).toBe("running");

		controller.abort();
		await expect(p).rejects.toThrow();
		// Cancelled, not failed: the user stopped it.
		expect(run.records.a?.status).toBe("cancelled");
		// Blocks dependents and is terminal.
		expect(readySteps(run)).toEqual([]);
		await expect(runStep(run, "a", () => {})).rejects.toThrow(/was cancelled/);
	});
});

describe("mcp engine: chit_cancel via the controller registry", () => {
	test("cancelStep aborts an in-flight step -> rejects, marks cancelled, blocks dependents", async () => {
		// Adapter that settles only when its signal aborts (kills + rejects).
		const adapters: AdapterMap = {
			fake: {
				call: (req) =>
					new Promise<AdapterCallResult>((_resolve, reject) => {
						req.signal?.addEventListener("abort", () => reject(new Error("killed")), {
							once: true,
						});
					}),
			},
		};
		const run = makeRun(CHAIN, { x: "hi" }, adapters);
		const controllers: StepControllers = new Map();
		// runStep registers the controller in the map itself (after the lock).
		const controller = new AbortController();
		const p = runStep(run, "a", () => {}, controller, controllers);
		expect(run.records.a?.status).toBe("running");
		expect(controllers.get(controllerKey(run.runId, "a"))).toBe(controller);

		expect(cancelStep(run, "a", controllers)).toBe("cancelled");
		await expect(p).rejects.toThrow();
		expect(run.records.a?.status).toBe("cancelled");
		expect(readySteps(run)).toEqual([]);
	});

	test("cancelStep reports not_running / already_done / unknown_step", async () => {
		const run = makeRun(CHAIN, { x: "hi" }, immediate("A"));
		const controllers: StepControllers = new Map();
		expect(cancelStep(run, "a", controllers)).toBe("not_running"); // pending, no controller
		expect(cancelStep(run, "nope", controllers)).toBe("unknown_step");
		await runStep(run, "a", () => {});
		expect(cancelStep(run, "a", controllers)).toBe("already_done");
	});

	test("a rejected duplicate runStep does not clobber the in-flight controller", async () => {
		// Adapter settles only on abort, so the first call stays in flight.
		const adapters: AdapterMap = {
			fake: {
				call: (req) =>
					new Promise<AdapterCallResult>((_resolve, reject) => {
						req.signal?.addEventListener("abort", () => reject(new Error("killed")), {
							once: true,
						});
					}),
			},
		};
		const run = makeRun(CHAIN, { x: "hi" }, adapters);
		const controllers: StepControllers = new Map();
		const key = controllerKey(run.runId, "a");

		const owner = new AbortController();
		const first = runStep(run, "a", () => {}, owner, controllers);
		expect(run.records.a?.status).toBe("running");
		expect(controllers.get(key)).toBe(owner);

		// A concurrent duplicate with its own controller is rejected by the lock
		// and must NOT overwrite or delete the owner's registered controller.
		const dup = new AbortController();
		await expect(runStep(run, "a", () => {}, dup, controllers)).rejects.toThrow(/already running/);
		expect(controllers.get(key)).toBe(owner);

		// So chit_cancel still reaches the real in-flight step.
		expect(cancelStep(run, "a", controllers)).toBe("cancelled");
		await expect(first).rejects.toThrow();
		expect(run.records.a?.status).toBe("cancelled");
		// And the slot is freed once the owner settles.
		expect(controllers.get(key)).toBeUndefined();
	});
});

describe("mcp engine: abort-window checks", () => {
	test("a signal aborted before start cancels without invoking the adapter", async () => {
		let called = false;
		const adapters: AdapterMap = {
			fake: {
				call: async () => {
					called = true;
					return { output: "A" };
				},
			},
		};
		const run = makeRun(CHAIN, { x: "hi" }, adapters);
		const controller = new AbortController();
		controller.abort();
		await expect(runStep(run, "a", () => {}, controller)).rejects.toThrow();
		expect(run.records.a?.status).toBe("cancelled");
		expect(called).toBe(false);
		expect(run.outputs.a).toBeUndefined();
	});

	test("an abort landing as the adapter returns is not committed as done", async () => {
		const controller = new AbortController();
		const adapters: AdapterMap = {
			fake: {
				call: async () => {
					controller.abort(); // abort lands during the call; adapter returns anyway
					return { output: "A" };
				},
			},
		};
		const run = makeRun(CHAIN, { x: "hi" }, adapters);
		await expect(runStep(run, "a", () => {}, controller)).rejects.toThrow();
		expect(run.records.a?.status).toBe("cancelled");
		expect(run.outputs.a).toBeUndefined();
	});
});

describe("mcp engine: startRun rejects per_scope without a scope", () => {
	const SCOPED = {
		schema: 1,
		id: "sc",
		description: "d",
		inputs: { q: { type: "string" } },
		// codex enforces read_only (no gap), so this isolates the scope check.
		participants: { a: { agent: "codex", role: "r", session: "per_scope" } },
		steps: { s: { call: "a", prompt: "{{ inputs.q }}" } },
		output: "s",
	};
	const opts = { inputs: { q: "x" }, registry: loadRegistry(), invocationCwd: "/tmp" as string };

	test("rejects when no scope is supplied", () => {
		expect(() =>
			startRun("t", { rawManifest: SCOPED, ...opts, allowUnenforcedPermissions: true }),
		).toThrow(/scope is required/);
	});

	test("accepts when a scope is supplied", () => {
		expect(() =>
			startRun("t", {
				rawManifest: SCOPED,
				...opts,
				scope: "s1",
				allowUnenforcedPermissions: true,
			}),
		).not.toThrow();
	});
});

describe("mcp engine: isComplete requires every step done", () => {
	const TWO_BRANCH = {
		schema: 1,
		id: "tb",
		description: "d",
		inputs: { x: { type: "string" } },
		participants: { p: { agent: "fake", role: "r", session: "stateless" } },
		steps: {
			main: { format: "{{ inputs.x }}" },
			extra: { call: "p", prompt: "{{ inputs.x }}" }, // independent, not the output
		},
		output: "main",
	};

	test("an independent pending branch keeps the run incomplete", async () => {
		const run = makeRun(TWO_BRANCH, { x: "hi" }, immediate("E"));
		await runStep(run, "main", () => {});
		expect(run.records.main?.status).toBe("done");
		// Old behavior (output-step-only) would call this complete; it is not.
		expect(isComplete(run)).toBe(false);
		await runStep(run, "extra", () => {});
		expect(isComplete(run)).toBe(true);
	});
});

describe("mcp engine: failure is terminal", () => {
	test("a failed step stays failed, blocks dependents, and refuses re-run", async () => {
		const adapters: AdapterMap = {
			fake: {
				call: async () => {
					throw new Error("boom");
				},
			} satisfies RuntimeAdapter,
		};
		const run = makeRun(CHAIN, { x: "hi" }, adapters);

		await expect(runStep(run, "a", () => {})).rejects.toThrow(/boom/);
		expect(run.records.a?.status).toBe("failed");
		// Not advertised as ready (only pending steps are), and dependents stay blocked.
		expect(readySteps(run)).toEqual([]);
		// Terminal: an explicit re-run is refused rather than spawning again.
		await expect(runStep(run, "a", () => {})).rejects.toThrow(/previously failed/);
	});
});

describe("mcp engine: audit", () => {
	let auditDir: string;
	let store: AuditStore;

	beforeEach(() => {
		auditDir = mkdtempSync(join(tmpdir(), "chit-mcp-audit-"));
		store = new AuditStore(auditDir);
	});
	afterEach(() => {
		rmSync(auditDir, { recursive: true, force: true });
	});

	// Build a Run audited by `store`, mirroring startRun's audit wiring (recorder +
	// run.started + audit-wrapped adapters), so runStep's step.* / run.completed and
	// the adapter.call.* from the wrapper can be asserted with a fake adapter.
	function auditedRun(
		raw: unknown,
		inputs: Record<string, unknown>,
		baseAdapters: AdapterMap,
		runId = "AR",
		auditStore: AuditStore = store,
	): Run {
		const manifest = parseManifest(raw);
		const recorder = new AuditRecorder(
			auditStore,
			runId,
			{ manifestId: manifest.id, cwd: "/tmp", surface: "mcp" },
			() => 1_700_000_000_000,
		);
		recorder.runStarted();
		const run = makeRun(raw, inputs, wrapAdaptersWithAudit(baseAdapters, recorder));
		run.runId = runId;
		run.recorder = recorder;
		return run;
	}

	// A registry whose "fake" agent builds a (codex) adapter without spawning, so
	// startRun can wire audit without the run actually calling out.
	const fakeRegistry = {
		agents: {
			fake: {
				id: "fake",
				adapter: "codex-exec",
				model: "m",
				passModelOnResume: false,
				builtIn: false,
			},
		},
	} as unknown as NormalizedRegistry;

	test("startRun with audit creates a recorder, reuses the run id, and writes run.started", () => {
		const run = startRun("RUN-1", {
			rawManifest: CHAIN,
			inputs: { x: "hi" },
			registry: fakeRegistry,
			invocationCwd: "/tmp",
			allowUnenforcedPermissions: true,
			audit: true,
			auditStore: store,
			now: () => 1_700_000_000_000,
		});
		expect(run.recorder).toBeDefined();
		expect(run.runId).toBe("RUN-1"); // audit runId == MCP run_id
		expect(store.readEvents("RUN-1")[0]).toMatchObject({
			type: "run.started",
			surface: "mcp",
			manifestId: "chain",
		});
	});

	test("audit defaults off: startRun without audit makes no recorder and writes nothing", () => {
		const run = startRun("RUN-2", {
			rawManifest: CHAIN,
			inputs: { x: "hi" },
			registry: fakeRegistry,
			invocationCwd: "/tmp",
			allowUnenforcedPermissions: true,
			auditStore: store,
		});
		expect(run.recorder).toBeUndefined();
		expect(store.listRuns()).toEqual([]);
	});

	test("success: a full audited run records run/step/adapter-call events ending in run.completed", async () => {
		const run = auditedRun(CHAIN, { x: "hi" }, immediate("OUT"));
		await runStep(run, "a", () => {});
		await runStep(run, "b", () => {});
		const events = store.readEvents("AR");
		expect(events[0]?.type).toBe("run.started");
		expect(events.at(-1)?.type).toBe("run.completed");
		expect(events.filter((e) => e.type === "adapter.call.completed").length).toBe(2);
		expect(events.filter((e) => e.type === "step.completed").length).toBe(2);
		expect(run.recorder?.lastError).toBeUndefined();
	});

	test("failed step: records step.failed and adapter error, and NO run.completed", async () => {
		const failing: AdapterMap = {
			fake: {
				call: async () => {
					throw new Error("kaboom");
				},
			},
		};
		const run = auditedRun(CHAIN, { x: "hi" }, failing);
		await expect(runStep(run, "a", () => {})).rejects.toThrow("kaboom");
		const events = store.readEvents("AR");
		expect(events.some((e) => e.type === "step.failed")).toBe(true);
		const call = events.find(
			(e): e is AdapterCallCompletedEvent => e.type === "adapter.call.completed",
		);
		expect(call?.status).toBe("error");
		expect(events.some((e) => e.type === "run.completed")).toBe(false);
	});

	test("cancelled step: adapter call is recorded cancelled and the step is recorded failed", async () => {
		const blockUntilAbort: AdapterMap = {
			fake: {
				call: (req) =>
					new Promise<AdapterCallResult>((_resolve, reject) => {
						req.signal?.addEventListener("abort", () => reject(new Error("aborted by client")), {
							once: true,
						});
					}),
			},
		};
		const run = auditedRun(CHAIN, { x: "hi" }, blockUntilAbort);
		const controller = new AbortController();
		const controllers: StepControllers = new Map();
		const p = runStep(run, "a", () => {}, controller, controllers);
		controller.abort(); // lands while the adapter call is in flight
		await expect(p).rejects.toThrow();
		const events = store.readEvents("AR");
		const call = events.find(
			(e): e is AdapterCallCompletedEvent => e.type === "adapter.call.completed",
		);
		expect(call?.status).toBe("cancelled");
		expect(events.some((e) => e.type === "step.failed")).toBe(true);
		expect(events.some((e) => e.type === "run.completed")).toBe(false);
	});

	test("a call that RETURNS after the abort is recorded cancelled, not ok", async () => {
		// An adapter that ignores the signal and returns normally. The signal is
		// aborted while the call is in flight, so the run discards the output and
		// the audit must mark the call cancelled, not ok.
		const returnsAfterAbort: AdapterMap = {
			fake: { call: async () => ({ output: "late" }) },
		};
		const run = auditedRun(CHAIN, { x: "hi" }, returnsAfterAbort);
		const controller = new AbortController();
		const controllers: StepControllers = new Map();
		const p = runStep(run, "a", () => {}, controller, controllers);
		controller.abort(); // lands before the (already in-flight) call resolves
		await expect(p).rejects.toThrow();
		const call = store
			.readEvents("AR")
			.find((e): e is AdapterCallCompletedEvent => e.type === "adapter.call.completed");
		expect(call?.status).toBe("cancelled");
		expect(run.records.a?.status).toBe("cancelled");
		expect(store.readEvents("AR").some((e) => e.type === "run.completed")).toBe(false);
	});

	test("a chit_start that fails input validation writes NO audit run", () => {
		expect(() =>
			startRun("RUN-3", {
				rawManifest: CHAIN,
				inputs: {}, // missing required input "x"
				registry: fakeRegistry,
				invocationCwd: "/tmp",
				allowUnenforcedPermissions: true,
				audit: true,
				auditStore: store,
			}),
		).toThrow(/required input/);
		expect(store.listRuns()).toEqual([]); // no orphan run.started
	});

	test("duplicate run_step rejection does not corrupt the audit log", async () => {
		const run = auditedRun(CHAIN, { x: "hi" }, immediate("OUT"));
		await runStep(run, "a", () => {});
		const before = store.readEvents("AR").length;
		// Re-running a done step is rejected BEFORE any audit event is emitted.
		await expect(runStep(run, "a", () => {})).rejects.toThrow(/already ran/);
		expect(store.readEvents("AR").length).toBe(before);
	});

	test("a broken audit store never breaks the run (best-effort)", async () => {
		const broken = {
			openRun() {
				throw new Error("disk full");
			},
			writeBlob() {
				throw new Error("disk full");
			},
			appendEvent() {
				throw new Error("disk full");
			},
		} as unknown as AuditStore;
		const run = auditedRun(CHAIN, { x: "hi" }, immediate("OUT"), "AR2", broken);
		await runStep(run, "a", () => {});
		await runStep(run, "b", () => {});
		expect(run.records.b?.status).toBe("done"); // run succeeded
		expect(run.outputs.b).toBe("OUT");
		expect(run.recorder?.lastError?.message).toMatch(/disk full/);
	});
});
