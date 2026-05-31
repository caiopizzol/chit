import { describe, expect, test } from "bun:test";
import {
	type AdapterCallCompletedEvent,
	type AdapterCallStartedEvent,
	type AdapterEventEvent,
	type AuditEvent,
	AuditEventError,
	formatAdapterUsage,
	type LoopIterationRecordedEvent,
	parseAuditLog,
	type RunCompletedEvent,
	type RunStartedEvent,
	type StepCompletedEvent,
	type StepFailedEvent,
	type StepStartedEvent,
	serializeAuditEvent,
	validateAuditEvent,
} from "./events.ts";

describe("formatAdapterUsage", () => {
	test("renders all token fields and the reported cost", () => {
		expect(
			formatAdapterUsage({
				inputTokens: 6590,
				outputTokens: 40,
				cachedInputTokens: 800,
				reasoningTokens: 19,
				estimatedCostUsd: 0.0658,
			}),
		).toBe("tokens: in 6590, out 40, cached 800, reasoning 19; reported cost: $0.0658");
	});

	test("renders a totalTokens-only block (the only signal a provider may give)", () => {
		expect(formatAdapterUsage({ totalTokens: 1234 })).toBe("tokens: total 1234");
	});

	test("renders tokens with no cost (Codex reports none)", () => {
		expect(formatAdapterUsage({ inputTokens: 10, outputTokens: 2 })).toBe("tokens: in 10, out 2");
	});

	test("reports nothing for undefined or an empty block", () => {
		expect(formatAdapterUsage(undefined)).toBe("usage: none reported");
		expect(formatAdapterUsage({})).toBe("usage: none reported");
	});
});

const runStarted: RunStartedEvent = {
	type: "run.started",
	runId: "R1",
	ts: "2026-05-30T10:00:00.000Z",
	manifestId: "m-abc",
	manifestPath: "/abs/chit/manifest.toml",
	scope: "audit-substrate",
	cwd: "/abs/chit",
	surface: "converge",
	loopId: "L1",
	iteration: 1,
	commandArgs: ["chit", "converge", "--scope", "audit"],
};

const stepStarted: StepStartedEvent = {
	type: "step.started",
	runId: "R1",
	ts: "2026-05-30T10:00:01.000Z",
	stepId: "s1",
	kind: "call",
	participantId: "advisor",
	agentId: "claude-cli",
	session: "sess-1",
};

const adapterCallStarted: AdapterCallStartedEvent = {
	type: "adapter.call.started",
	runId: "R1",
	ts: "2026-05-30T10:00:02.000Z",
	stepId: "s1",
	participantId: "advisor",
	agentId: "claude-cli",
	cwd: "/abs/chit",
	priorSessionRef: "sess-0",
	inputBlob: "a".repeat(64),
};

const adapterEvent: AdapterEventEvent = {
	type: "adapter.event",
	runId: "R1",
	ts: "2026-05-30T10:00:03.000Z",
	stepId: "s1",
	eventType: "assistant.message",
	rawBlob: "b".repeat(64),
	note: "first token",
};

const adapterCallCompleted: AdapterCallCompletedEvent = {
	type: "adapter.call.completed",
	runId: "R1",
	ts: "2026-05-30T10:00:10.000Z",
	stepId: "s1",
	outputBlob: "c".repeat(64),
	newSessionRef: "sess-2",
	durationMs: 8000,
	status: "ok",
	exitCode: 0,
};

const stepCompleted: StepCompletedEvent = {
	type: "step.completed",
	runId: "R1",
	ts: "2026-05-30T10:00:11.000Z",
	stepId: "s1",
	durationMs: 10000,
};

const stepFailed: StepFailedEvent = {
	type: "step.failed",
	runId: "R1",
	ts: "2026-05-30T10:00:12.000Z",
	stepId: "s2",
	error: "adapter timed out",
	durationMs: 30000,
};

const loopIteration: LoopIterationRecordedEvent = {
	type: "loop.iteration.recorded",
	runId: "R1",
	ts: "2026-05-30T10:00:13.000Z",
	loopId: "L1",
	n: 1,
	verdict: "revise",
	decision: "revise",
	findingCount: 2,
	changedFiles: ["packages/core/src/audit/events.ts"],
	checksRun: "core tests + typecheck",
	checkDurationMs: 42000,
};

const runCompleted: RunCompletedEvent = {
	type: "run.completed",
	runId: "R1",
	ts: "2026-05-30T10:05:00.000Z",
	status: "ok",
	durationMs: 300000,
};

const allEvents: AuditEvent[] = [
	runStarted,
	stepStarted,
	adapterCallStarted,
	adapterEvent,
	adapterCallCompleted,
	stepCompleted,
	stepFailed,
	loopIteration,
	runCompleted,
];

describe("audit events: serialize/validate round-trip", () => {
	test("each event kind round-trips through serialize -> parse", () => {
		const body = allEvents.map(serializeAuditEvent).join("\n");
		expect(parseAuditLog(body)).toEqual(allEvents);
	});

	test("a trailing newline and blank lines are skipped", () => {
		const body = `${serializeAuditEvent(runStarted)}\n\n${serializeAuditEvent(runCompleted)}\n`;
		expect(parseAuditLog(body)).toEqual([runStarted, runCompleted]);
	});

	test("optional fields survive the round-trip", () => {
		const rt = validateAuditEvent(JSON.parse(serializeAuditEvent(adapterEvent)));
		expect(rt).toEqual(adapterEvent);
	});

	test("an absent optional field is omitted, not set to undefined", () => {
		// note-only: rawBlob is absent and must not be materialized as undefined.
		const noteOnly: AuditEvent = {
			type: "adapter.event",
			runId: "R1",
			ts: "2026-05-30T10:00:03.000Z",
			stepId: "s1",
			eventType: "assistant.message",
			note: "first token",
		};
		const rt = validateAuditEvent(JSON.parse(serializeAuditEvent(noteOnly)));
		expect("rawBlob" in rt).toBe(false);
		expect(rt).toEqual(noteOnly);
	});
});

describe("audit events: validation", () => {
	test("rejects an unknown event type", () => {
		expect(() => validateAuditEvent({ type: "bogus", runId: "R1", ts: "t" })).toThrow(
			AuditEventError,
		);
	});

	test("rejects a bad status enum", () => {
		expect(() => validateAuditEvent({ ...adapterCallCompleted, status: "boom" })).toThrow(/status/);
	});

	test("rejects a bad verdict enum", () => {
		expect(() => validateAuditEvent({ ...loopIteration, verdict: "maybe" })).toThrow(/verdict/);
	});

	test("rejects a bad surface enum", () => {
		expect(() => validateAuditEvent({ ...runStarted, surface: "desktop" })).toThrow(/surface/);
	});

	test("rejects iteration 0 (iteration is 1-based; omit when not in a loop)", () => {
		expect(() => validateAuditEvent({ ...runStarted, iteration: 0 })).toThrow(/iteration/);
	});

	test("rejects a missing required envelope field (runId)", () => {
		const { runId: _drop, ...missing } = runCompleted;
		expect(() => validateAuditEvent(missing)).toThrow(/runId/);
	});

	test("rejects a missing required per-kind field", () => {
		const { inputBlob: _drop, ...missing } = adapterCallStarted;
		expect(() => validateAuditEvent(missing)).toThrow(/inputBlob/);
	});

	test("rejects an adapter.event with neither rawBlob nor note", () => {
		const neither = {
			type: "adapter.event",
			runId: "R1",
			ts: "2026-05-30T10:00:03.000Z",
			stepId: "s1",
			eventType: "assistant.message",
		};
		expect(() => validateAuditEvent(neither)).toThrow(/rawBlob.*note|note.*rawBlob/);
	});

	test("rejects an empty BlobRef", () => {
		expect(() => validateAuditEvent({ ...adapterCallStarted, inputBlob: "" })).toThrow(/inputBlob/);
	});

	test("rejects a negative or fractional duration", () => {
		expect(() => validateAuditEvent({ ...stepCompleted, durationMs: -1 })).toThrow(/durationMs/);
		expect(() => validateAuditEvent({ ...stepCompleted, durationMs: 1.5 })).toThrow(/durationMs/);
	});

	test("step.completed: optional outputBlob round-trips, is omitted when absent, rejects empty", () => {
		const withBlob: StepCompletedEvent = { ...stepCompleted, outputBlob: "d".repeat(64) };
		expect(validateAuditEvent(JSON.parse(serializeAuditEvent(withBlob)))).toEqual(withBlob);
		const rt = validateAuditEvent(JSON.parse(serializeAuditEvent(stepCompleted)));
		expect("outputBlob" in rt).toBe(false);
		expect(() => validateAuditEvent({ ...stepCompleted, outputBlob: "" })).toThrow(/outputBlob/);
	});

	test("rejects changedFiles that is not a string array", () => {
		expect(() => validateAuditEvent({ ...loopIteration, changedFiles: [1, 2] })).toThrow(
			/changedFiles/,
		);
	});

	test("serializeAuditEvent refuses to emit an invalid event", () => {
		expect(() => serializeAuditEvent({ ...runCompleted, status: "nope" } as never)).toThrow(
			AuditEventError,
		);
	});

	test("accepts a zero findingCount (a clean iteration)", () => {
		expect(validateAuditEvent({ ...loopIteration, findingCount: 0 })).toMatchObject({
			findingCount: 0,
		});
	});
});

describe("audit events: adapter usage", () => {
	const withUsage: AdapterCallCompletedEvent = {
		...adapterCallCompleted,
		usage: {
			inputTokens: 1200,
			outputTokens: 340,
			totalTokens: 1540,
			cachedInputTokens: 800,
			reasoningTokens: 64,
			estimatedCostUsd: 0.0123,
		},
	};

	test("a full usage block round-trips", () => {
		const rt = validateAuditEvent(JSON.parse(serializeAuditEvent(withUsage)));
		expect(rt).toEqual(withUsage);
	});

	test("a partial usage block round-trips (adapters report different subsets)", () => {
		const partial: AdapterCallCompletedEvent = {
			...adapterCallCompleted,
			usage: { inputTokens: 10 },
		};
		expect(validateAuditEvent(JSON.parse(serializeAuditEvent(partial)))).toEqual(partial);
	});

	test("absent usage is omitted, not materialized as undefined", () => {
		const rt = validateAuditEvent(JSON.parse(serializeAuditEvent(adapterCallCompleted)));
		expect("usage" in rt).toBe(false);
	});

	test("rejects an empty usage block", () => {
		expect(() => validateAuditEvent({ ...adapterCallCompleted, usage: {} })).toThrow(/usage/);
	});

	test("rejects a negative token count", () => {
		expect(() =>
			validateAuditEvent({ ...adapterCallCompleted, usage: { inputTokens: -1 } }),
		).toThrow(/inputTokens/);
	});

	test("rejects a fractional token count", () => {
		expect(() =>
			validateAuditEvent({ ...adapterCallCompleted, usage: { outputTokens: 1.5 } }),
		).toThrow(/outputTokens/);
	});

	test("rejects a negative cost", () => {
		expect(() =>
			validateAuditEvent({ ...adapterCallCompleted, usage: { estimatedCostUsd: -0.01 } }),
		).toThrow(/estimatedCostUsd/);
	});

	test("rejects a non-finite cost", () => {
		expect(() =>
			validateAuditEvent({ ...adapterCallCompleted, usage: { estimatedCostUsd: Infinity } }),
		).toThrow(/estimatedCostUsd/);
	});

	test("accepts a fractional cost (cost is not an integer)", () => {
		expect(
			validateAuditEvent({ ...adapterCallCompleted, usage: { estimatedCostUsd: 0.0042 } }),
		).toMatchObject({ usage: { estimatedCostUsd: 0.0042 } });
	});
});

describe("audit events: loop iteration checkDurationMs", () => {
	test("rejects a missing checkDurationMs", () => {
		const { checkDurationMs: _drop, ...missing } = loopIteration;
		expect(() => validateAuditEvent(missing)).toThrow(/checkDurationMs/);
	});

	test("rejects a negative or fractional checkDurationMs", () => {
		expect(() => validateAuditEvent({ ...loopIteration, checkDurationMs: -1 })).toThrow(
			/checkDurationMs/,
		);
		expect(() => validateAuditEvent({ ...loopIteration, checkDurationMs: 1.5 })).toThrow(
			/checkDurationMs/,
		);
	});
});

describe("audit events: parse errors name the line", () => {
	test("a malformed JSON line throws with its 1-based line number", () => {
		const body = `${serializeAuditEvent(runStarted)}\nnot json`;
		expect(() => parseAuditLog(body)).toThrow(/line 2: invalid JSON/);
	});

	test("a structurally invalid event throws with its line number", () => {
		const body = `${serializeAuditEvent(runStarted)}\n${JSON.stringify({
			type: "step.completed",
			runId: "R1",
			ts: "t",
		})}`;
		expect(() => parseAuditLog(body)).toThrow(/line 2:/);
	});
});

describe("run.started participant config snapshot", () => {
	const withSnapshot: RunStartedEvent = {
		...runStarted,
		participants: {
			reviewer: {
				agentId: "codex-deep",
				adapter: "codex-exec",
				session: "per_scope",
				permissions: { filesystem: "read_only" },
				enforcesReadOnly: true,
				config: { model: "gpt-5.5", reasoningEffort: "xhigh", envKeys: ["OPENAI_BASE_URL"] },
			},
			implementer: {
				agentId: "claude-opus",
				adapter: "claude-cli",
				session: "per_scope",
				permissions: { filesystem: "write" },
				enforcesReadOnly: false,
				config: { model: "opus", strictMcp: false, passModelOnResume: true },
			},
		},
	};

	test("a run.started with a participant snapshot round-trips", () => {
		const rt = validateAuditEvent(JSON.parse(serializeAuditEvent(withSnapshot)));
		expect(rt).toEqual(withSnapshot);
	});

	test("the snapshot is optional (backward-compatible with older runs)", () => {
		// runStarted has no participants; it must validate and stay absent.
		const rt = validateAuditEvent(JSON.parse(serializeAuditEvent(runStarted)));
		expect((rt as RunStartedEvent).participants).toBeUndefined();
	});

	test("rejects a bad session enum in a snapshot", () => {
		const bad = {
			...runStarted,
			participants: { p: { ...withSnapshot.participants?.reviewer, session: "forever" } },
		};
		expect(() => validateAuditEvent(bad)).toThrow(/session/);
	});

	test("rejects a non-boolean enforcesReadOnly in a snapshot", () => {
		const bad = {
			...runStarted,
			participants: { p: { ...withSnapshot.participants?.reviewer, enforcesReadOnly: "yes" } },
		};
		expect(() => validateAuditEvent(bad)).toThrow(/enforcesReadOnly/);
	});

	test("rejects a snapshot entry missing config (config is required, not defaulted)", () => {
		const { config: _drop, ...noConfig } = withSnapshot.participants?.reviewer ?? {
			config: {},
		};
		const bad = { ...runStarted, participants: { p: noConfig } };
		expect(() => validateAuditEvent(bad)).toThrow(/config/);
	});

	test("accepts an empty config object (a default agent records config: {})", () => {
		const rt = validateAuditEvent({
			...runStarted,
			participants: {
				p: {
					agentId: "codex",
					adapter: "codex-exec",
					session: "stateless",
					permissions: { filesystem: "read_only" },
					enforcesReadOnly: true,
					config: {},
				},
			},
		}) as RunStartedEvent;
		expect(rt.participants?.p?.config).toEqual({});
	});
});
