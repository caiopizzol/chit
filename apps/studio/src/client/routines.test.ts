// Unit tests for the declared-routines client helpers.

import { describe, expect, test } from "bun:test";
import type { DeclaredRoutine, LiveActivity, RoutineParticipant } from "../server/types.ts";
import {
	participantRole,
	routineCanvas,
	routineKey,
	routineTicker,
	towerBody,
} from "./routines.ts";

const EMPTY: LiveActivity = { foreground: [], background: [] };

const participant = (over: Partial<RoutineParticipant>): RoutineParticipant => ({
	id: "impl",
	agentId: "claude",
	session: "per_scope",
	filesystem: "write",
	...over,
});

const routine = (over: Partial<DeclaredRoutine>): DeclaredRoutine => ({
	id: "deep",
	origin: "repo",
	mode: "converge",
	manifestPath: "flows/deep.json",
	...over,
});

describe("routineKey", () => {
	test("namespaces routine ids so they never collide with live row keys", () => {
		// live.ts rowKey uses `<source>:<runId>`; routineKey must live in a distinct
		// space so a routine and a run sharing an id are still separable selections.
		expect(routineKey({ id: "deep" })).toBe("routine:deep");
	});
});

describe("participantRole", () => {
	test("classifies by abbreviated key", () => {
		expect(participantRole(participant({ id: "impl" }))).toBe("implementer");
		expect(participantRole(participant({ id: "rev" }))).toBe("reviewer");
		expect(participantRole(participant({ id: "checker" }))).toBe("checks");
		expect(participantRole(participant({ id: "p1" }))).toBe("other");
	});

	test("reads the resolved role name when the key is opaque", () => {
		expect(participantRole(participant({ id: "p1", role: "reviewer" }))).toBe("reviewer");
		expect(participantRole(participant({ id: "p2", role: "implementer" }))).toBe("implementer");
	});
});

describe("routineCanvas", () => {
	test("maps participants to the implementer/reviewer blocks with governance detail", () => {
		const r = routine({
			manifest: {
				manifestDigest: "sha256:abc",
				policy: { kind: "loop", implementStep: "do", reviewStep: "check" },
				participants: [
					participant({ id: "impl", agentId: "claude", session: "per_scope", filesystem: "write" }),
					participant({
						id: "rev",
						agentId: "codex",
						session: "stateless",
						filesystem: "read_only",
					}),
				],
				steps: [
					{
						id: "do",
						kind: "call",
						participantId: "impl",
						agentId: "claude",
						session: "per_scope",
						filesystem: "write",
					},
					{
						id: "check",
						kind: "call",
						participantId: "rev",
						agentId: "codex",
						session: "stateless",
						filesystem: "read_only",
					},
					{ id: "out", kind: "format" },
				],
				requiredChecks: [{ name: "test", command: "bun", args: ["test"] }],
			},
		});
		const blocks = routineCanvas(r);
		expect(blocks.map((b) => b.role)).toEqual(["implementer", "reviewer", "checks", "you"]);
		const impl = blocks[0];
		expect(impl).toMatchObject({ present: true, agentId: "claude", detail: "per_scope / write" });
		const rev = blocks[1];
		expect(rev).toMatchObject({
			present: true,
			agentId: "codex",
			detail: "stateless / read_only",
		});
		const checks = blocks[2];
		expect(checks).toMatchObject({ present: true, agentId: "chit", detail: "1 required / test" });
		const you = blocks[3];
		expect(you).toMatchObject({
			present: true,
			agentId: "operator",
			detail: "approves and monitors",
		});
	});

	test("falls back to the first participant for the implementer when none classifies", () => {
		const r = routine({
			manifest: {
				policy: { kind: "loop", implementStep: "implement", reviewStep: "review" },
				participants: [participant({ id: "p1", agentId: "claude" })],
				steps: [],
				requiredChecks: [],
			},
		});
		const blocks = routineCanvas(r);
		expect(blocks[0]).toMatchObject({ role: "implementer", present: true, agentId: "claude" });
		// No reviewer participant: the block is a calm placeholder, not a fabricated agent.
		expect(blocks[1]).toMatchObject({ role: "reviewer", present: false, detail: "not declared" });
	});

	test("no manifest summary still yields the four-block skeleton, blocks not present", () => {
		const blocks = routineCanvas(routine({ error: "no flows/deep.json in the git tree at HEAD" }));
		expect(blocks.map((b) => b.role)).toEqual(["implementer", "reviewer", "checks", "you"]);
		expect(blocks[0]?.present).toBe(false);
		expect(blocks[2]).toMatchObject({ role: "checks", present: false, detail: "unknown" });
		// The human-in-the-loop block is present even with no resolved manifest.
		expect(blocks[3]).toMatchObject({ role: "you", present: true });
	});

	test("a resolved manifest with zero checks reads as 'no required checks'", () => {
		const blocks = routineCanvas(
			routine({
				manifest: {
					policy: { kind: "loop", implementStep: "implement", reviewStep: "review" },
					participants: [],
					steps: [],
					requiredChecks: [],
				},
			}),
		);
		expect(blocks[2]).toMatchObject({
			role: "checks",
			present: false,
			agentId: "chit",
			detail: "no required checks",
		});
	});

	test("one-shot routines render their declared steps instead of the converge skeleton", () => {
		const blocks = routineCanvas(
			routine({
				mode: "one-shot",
				manifest: {
					policy: { kind: "one-shot" },
					participants: [
						participant({ id: "griller", agentId: "claude", filesystem: "read_only" }),
					],
					steps: [
						{
							id: "grill",
							kind: "call",
							participantId: "griller",
							agentId: "claude",
							session: "per_scope",
							filesystem: "read_only",
						},
						{ id: "out", kind: "format" },
					],
					requiredChecks: [],
				},
			}),
		);
		expect(blocks.map((b) => b.role)).toEqual(["grill", "out", "you"]);
		expect(blocks[0]).toMatchObject({
			label: "grill",
			agentId: "claude",
			detail: "call griller / per_scope / read_only",
		});
		expect(blocks[1]).toMatchObject({ label: "out", agentId: "chit", detail: "formats output" });
	});
});

describe("towerBody", () => {
	test("renders the grid when routines exist even with no live rows", () => {
		expect(towerBody(EMPTY, 2, 0)).toBe("grid");
	});

	test("renders the grid when runs are live regardless of routines", () => {
		const live: LiveActivity = {
			foreground: [
				{ source: "foreground", runId: "r1", scope: "s", task: "t", phase: "p", statusLine: "x" },
			],
			background: [],
		};
		expect(towerBody(live, 0, 0)).toBe("grid");
	});

	test("falls back to console-only / empty when nothing is live and no routines", () => {
		expect(towerBody(EMPTY, 0, 3)).toBe("empty-with-console");
		expect(towerBody(EMPTY, 0, 0)).toBe("empty");
	});
});

describe("routineTicker", () => {
	test("uses a last-run receipt summary when one is present", () => {
		const view = routineTicker(
			routine({
				lastRun: {
					status: "converged",
					verdict: "proceed",
					statusLine: "iteration 2 · proceed · converged",
					iterationsCompleted: 2,
					elapsedMs: 65_000,
					ageMs: 12_000,
					estimatedCostUsd: 0.05,
					auditRef: "aud-2",
					traceRef: "run-2",
				},
			}),
		);
		expect(view).toEqual({
			key: "last run",
			text: "converged / proceed / 2 iters / 12s ago / elapsed 1m 5s / $0.0500",
			tail: "audit aud-2",
		});
	});

	test("falls back to the declared manifest line when there is no strong last-run match", () => {
		const view = routineTicker(
			routine({
				manifest: {
					manifestDigest: "sha256:0123456789abcdef",
					policy: { kind: "loop", implementStep: "implement", reviewStep: "review" },
					participants: [],
					steps: [],
					requiredChecks: [],
				},
			}),
		);
		expect(view).toEqual({
			key: "declared",
			text: "converge / flows/deep.json / sha256:0123456789…",
			tail: "ready",
		});
	});

	test("uses trace handle when an audit ref is absent", () => {
		const view = routineTicker(
			routine({
				lastRun: {
					status: "blocked",
					verdict: "block",
					iterationsCompleted: 1,
					ageMs: 5000,
					traceRef: "run-1",
				},
			}),
		);
		expect(view).toEqual({
			key: "last run",
			text: "blocked / block / 1 iter / 5s ago",
			tail: "trace run-1",
		});
	});
});
