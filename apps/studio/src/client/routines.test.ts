// Unit tests for the declared-routines client helpers.

import { describe, expect, test } from "bun:test";
import type { DeclaredRoutine, LiveActivity, RoutineParticipant } from "../server/types.ts";
import { participantRole, routineCanvas, routineKey, towerBody } from "./routines.ts";

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
				participants: [
					participant({ id: "impl", agentId: "claude", session: "per_scope", filesystem: "write" }),
					participant({
						id: "rev",
						agentId: "codex",
						session: "stateless",
						filesystem: "read_only",
					}),
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
				participants: [participant({ id: "p1", agentId: "claude" })],
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
		const blocks = routineCanvas(routine({ manifest: { participants: [], requiredChecks: [] } }));
		expect(blocks[2]).toMatchObject({
			role: "checks",
			present: false,
			agentId: "chit",
			detail: "no required checks",
		});
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
