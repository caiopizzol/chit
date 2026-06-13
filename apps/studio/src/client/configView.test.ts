// Unit tests for the config panel's pure display helpers: origin grouping
// (layer order, no empty groups), the compact meta lines (defaults stay
// silent), and the instructions footnote.

import { describe, expect, test } from "bun:test";
import type {
	EffectiveAgentView,
	EffectiveRecipeView,
	EffectiveRoleView,
} from "../server/types.ts";
import {
	agentMeta,
	formatTimeout,
	groupByOrigin,
	instructionsNote,
	recipeMeta,
	roleMeta,
} from "./configView.ts";

function agent(over: Partial<EffectiveAgentView> & { id: string }): EffectiveAgentView {
	return { adapter: "codex-exec", origin: "builtin", ...over };
}

function recipe(over: Partial<EffectiveRecipeView> & { id: string }): EffectiveRecipeView {
	return { origin: "global", mode: "converge", manifestPath: "/flows/main.json", ...over };
}

function role(over: Partial<EffectiveRoleView> & { id: string }): EffectiveRoleView {
	return {
		origin: "global",
		session: "stateless",
		filesystem: "read_only",
		instructionsPreview: "Review the diff.",
		instructionsLength: 16,
		...over,
	};
}

describe("groupByOrigin", () => {
	test("orders groups builtin, global, repo and drops empty groups", () => {
		const groups = groupByOrigin([
			agent({ id: "r", origin: "repo" }),
			agent({ id: "b", origin: "builtin" }),
			agent({ id: "r2", origin: "repo" }),
		]);
		expect(groups.map((g) => g.origin)).toEqual(["builtin", "repo"]);
		expect(groups[1]?.items.map((i) => i.id)).toEqual(["r", "r2"]);
	});

	test("empty input yields no groups", () => {
		expect(groupByOrigin([])).toEqual([]);
	});
});

describe("agentMeta", () => {
	test("a builtin agent with no pins reads as just the default model", () => {
		// strictMcp true / passModelOnResume false are the defaults; the line
		// must not repeat them.
		expect(agentMeta(agent({ id: "claude", strictMcp: true, passModelOnResume: false }))).toBe(
			"default model",
		);
	});

	test("shows pinned settings and deviations only", () => {
		const meta = agentMeta(
			agent({
				id: "deep",
				model: "gpt-5.3-codex",
				reasoningEffort: "xhigh",
				callTimeoutMs: 1_200_000,
				noProgressTimeoutMs: 90_000,
				strictMcp: false,
				passModelOnResume: true,
				envKeys: ["API_KEY", "BASE_URL"],
			}),
		);
		expect(meta).toBe(
			"gpt-5.3-codex · effort xhigh · call 20m · no-progress 90s · strictMcp off · pass model on resume · env API_KEY, BASE_URL",
		);
	});
});

describe("formatTimeout", () => {
	test("whole minutes when even, seconds otherwise", () => {
		expect(formatTimeout(900_000)).toBe("15m");
		expect(formatTimeout(90_000)).toBe("90s");
	});
});

describe("roleMeta", () => {
	test("shows the default agent, session, and filesystem", () => {
		expect(roleMeta(role({ id: "reviewer", agent: "codex", session: "per_scope" }))).toBe(
			"codex · per_scope · read_only",
		);
	});

	test("a model-agnostic role reads as any agent", () => {
		expect(roleMeta(role({ id: "impl" }))).toBe("any agent · stateless · read_only");
	});
});

describe("recipeMeta", () => {
	test("a bare recipe reads as just mode and manifest path", () => {
		expect(recipeMeta(recipe({ id: "bare" }))).toBe("converge · /flows/main.json");
	});

	test("a one-shot recipe reads as mode and manifest path", () => {
		expect(recipeMeta(recipe({ id: "grill", mode: "one-shot" }))).toBe(
			"one-shot · /flows/main.json",
		);
	});

	test("appends max iterations and call timeout when set", () => {
		const meta = recipeMeta(recipe({ id: "deep", maxIterations: 5, callTimeoutMs: 1_200_000 }));
		expect(meta).toBe("converge · /flows/main.json · max 5 · call 20m");
	});
});

describe("instructionsNote", () => {
	test("a whole preview stands alone", () => {
		expect(instructionsNote(role({ id: "r" }))).toBe("Review the diff.");
	});

	test("a cut preview carries the full length", () => {
		const r = role({ id: "r", instructionsPreview: "Review...", instructionsLength: 2000 });
		expect(instructionsNote(r)).toBe("Review... (2000 chars)");
	});
});
