// Unit tests for the NormalizedConfig -> DeclaredRoutinesView mapping: recipe
// identity reuse (same redaction + ordering as effectiveRecipeViews), best-effort
// manifest enrichment via an injected resolver, per-recipe error capture, and the
// no-resolver (standalone) degraded shape.

import { describe, expect, test } from "bun:test";
import { type ConfigLayer, parseConfig, parseConfigLayers } from "@chit-run/core";
import { declaredRoutinesView } from "./routines.ts";
import type { RoutineManifestSummary } from "./types.ts";

function layered(global?: unknown, repo?: unknown) {
	const layers: ConfigLayer[] = [];
	if (global !== undefined)
		layers.push({ raw: global, path: "/home/u/config.json", source: "global" });
	if (repo !== undefined)
		layers.push({ raw: repo, path: "/repo/chit.config.json", source: "repo" });
	const config = parseConfigLayers(layers);
	if (global !== undefined) config.configPath = "/home/u/config.json";
	if (repo !== undefined) config.repoConfigPath = "/repo/chit.config.json";
	return config;
}

const summary = (agentId: string): RoutineManifestSummary => ({
	manifestDigest: "sha256:abc",
	policy: { kind: "loop", implementStep: "implement", reviewStep: "review" },
	participants: [
		{ id: "impl", role: "implementer", agentId, session: "per_scope", filesystem: "write" },
	],
	steps: [
		{
			id: "implement",
			kind: "call",
			participantId: "impl",
			agentId,
			session: "per_scope",
			filesystem: "write",
		},
		{
			id: "review",
			kind: "call",
			participantId: "impl",
			agentId,
			session: "per_scope",
			filesystem: "write",
		},
		{ id: "out", kind: "format" },
	],
	requiredChecks: [{ name: "test", command: "bun", args: ["test"], timeoutMs: 60_000 }],
});

describe("declaredRoutinesView", () => {
	test("defaults-only config has no routines and no paths", () => {
		const view = declaredRoutinesView(parseConfig(undefined));
		expect(view.routines).toEqual([]);
		expect(view.configPath).toBeUndefined();
		expect(view.repoConfigPath).toBeUndefined();
	});

	test("lists recipes layer-then-id ordered with their identity and config paths", () => {
		const config = layered(
			{
				recipes: {
					"g-two": { mode: "converge", manifestPath: "/flows/two.json" },
					"g-one": { mode: "converge", manifestPath: "/flows/one.json", maxIterations: 4 },
				},
			},
			{ recipes: { "r-one": { mode: "converge", manifestPath: "flows/repo.json" } } },
		);
		const view = declaredRoutinesView(config);
		expect(view.routines.map((r) => `${r.origin}:${r.id}`)).toEqual([
			"global:g-one",
			"global:g-two",
			"repo:r-one",
		]);
		expect(view.configPath).toBe("/home/u/config.json");
		expect(view.repoConfigPath).toBe("/repo/chit.config.json");
		// Field-by-field rebuild: optionals present only when set, no manifest summary
		// without a resolver.
		const one = view.routines.find((r) => r.id === "g-one");
		expect(one).toEqual({
			id: "g-one",
			origin: "global",
			mode: "converge",
			manifestPath: "/flows/one.json",
			maxIterations: 4,
		});
	});

	test("lists one-shot recipes with their mode", () => {
		const config = layered({
			recipes: { grill: { mode: "one-shot", manifestPath: "/flows/grill.json" } },
		});
		expect(declaredRoutinesView(config).routines[0]).toEqual({
			id: "grill",
			origin: "global",
			mode: "one-shot",
			manifestPath: "/flows/grill.json",
		});
	});

	test("no resolver: routines carry recipe identity with neither manifest nor error", () => {
		const config = layered({
			recipes: { deep: { mode: "converge", manifestPath: "/flows/deep.json" } },
		});
		const routine = declaredRoutinesView(config).routines[0];
		expect(routine).not.toHaveProperty("manifest");
		expect(routine).not.toHaveProperty("error");
	});

	test("resolver enriches each routine with its manifest summary", () => {
		const config = layered({
			recipes: { deep: { mode: "converge", manifestPath: "/flows/deep.json" } },
		});
		const view = declaredRoutinesView(config, (id) => summary(`agent-for-${id}`));
		expect(view.routines[0]?.manifest).toEqual(summary("agent-for-deep"));
		expect(view.routines[0]?.error).toBeUndefined();
	});

	test("last-run resolver can attach a body-free receipt summary", () => {
		const config = layered({
			recipes: { deep: { mode: "converge", manifestPath: "/flows/deep.json" } },
		});
		const view = declaredRoutinesView(config, {
			resolveManifest: () => summary("claude"),
			resolveLastRun: (id, manifest) => {
				expect(id).toBe("deep");
				expect(manifest?.manifestDigest).toBe("sha256:abc");
				return {
					status: "converged",
					verdict: "proceed",
					statusLine: "iteration 2 · proceed · converged",
					iterationsCompleted: 2,
					elapsedMs: 65_000,
					ageMs: 12_000,
					estimatedCostUsd: 0.05,
					auditRef: "aud-2",
					traceRef: "run-2",
				};
			},
		});
		expect(view.routines[0]?.lastRun).toEqual({
			status: "converged",
			verdict: "proceed",
			statusLine: "iteration 2 · proceed · converged",
			iterationsCompleted: 2,
			elapsedMs: 65_000,
			ageMs: 12_000,
			estimatedCostUsd: 0.05,
			auditRef: "aud-2",
			traceRef: "run-2",
		});
	});

	test("last-run resolver absence or failure omits lastRun without marking routine unresolved", () => {
		const config = layered({
			recipes: { deep: { mode: "converge", manifestPath: "/flows/deep.json" } },
		});
		const absent = declaredRoutinesView(config, {
			resolveManifest: () => summary("claude"),
			resolveLastRun: () => undefined,
		});
		expect(absent.routines[0]).not.toHaveProperty("lastRun");
		expect(absent.routines[0]?.error).toBeUndefined();

		const failed = declaredRoutinesView(config, {
			resolveManifest: () => summary("claude"),
			resolveLastRun: () => {
				throw new Error("corrupt old loop log");
			},
		});
		expect(failed.routines[0]).not.toHaveProperty("lastRun");
		expect(failed.routines[0]?.error).toBeUndefined();
	});

	test("a throwing resolver degrades that one routine to a recoverable error string", () => {
		const config = layered({
			recipes: {
				ok: { mode: "converge", manifestPath: "flows/ok.json" },
				broken: { mode: "converge", manifestPath: "flows/missing.json" },
			},
		});
		const view = declaredRoutinesView(config, (id) => {
			if (id === "broken") throw new Error("no flows/missing.json in the git tree at HEAD");
			return summary("claude");
		});
		const ok = view.routines.find((r) => r.id === "ok");
		const broken = view.routines.find((r) => r.id === "broken");
		// One bad manifest never sinks the rest: the healthy routine still resolves.
		expect(ok?.manifest).toEqual(summary("claude"));
		expect(ok?.error).toBeUndefined();
		expect(broken?.manifest).toBeUndefined();
		expect(broken?.error).toContain("git tree at HEAD");
	});
});
