import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseConfig } from "./config.ts";
import { resolveFlow } from "./flow.ts";
import { isComposition, isSandboxed, kindLabel } from "./manifest.ts";
import { type ResolvedRoutine, resolveRoutine } from "./routine.ts";

const scenariosDir = join(process.cwd(), "scenarios");

function readJson(path: string): unknown {
	return JSON.parse(readFileSync(path, "utf-8"));
}

function loadScenario(name: string): {
	cwd: string;
	routines: Record<string, ResolvedRoutine>;
	resolve: (id: string) => ResolvedRoutine;
} {
	const cwd = join(scenariosDir, name);
	const config = parseConfig(readJson(join(cwd, "chit.config.json")), `${name}/chit.config.json`);
	const resolve = (id: string): ResolvedRoutine => resolveRoutine(config, id, cwd);
	const routines = Object.fromEntries(Object.keys(config.routines).map((id) => [id, resolve(id)]));
	return { cwd, routines, resolve };
}

function routine(name: string, id: string): ResolvedRoutine {
	const r = loadScenario(name).routines[id];
	if (r === undefined) throw new Error(`missing routine ${name}/${id}`);
	return r;
}

describe("scenario matrix", () => {
	test("contains the intended scenario set", () => {
		const dirs = readdirSync(scenariosDir, { withFileTypes: true })
			.filter((d) => d.isDirectory())
			.map((d) => d.name)
			.sort();
		expect(dirs).toEqual([
			"01-clarify",
			"02-grill",
			"03-plan",
			"04-panel-review",
			"05-refine-loop",
			"06-implementation-loop",
			"07-feature-flow",
			"08-review-blocks-loop",
			"09-check-fails-then-recovers",
			"10-cross-run-handoff",
		]);
	});

	test("every scenario config resolves every routine", () => {
		for (const scenario of readdirSync(scenariosDir, { withFileTypes: true }).filter((d) => d.isDirectory())) {
			const { routines } = loadScenario(scenario.name);
			for (const [id, resolved] of Object.entries(routines)) {
				expect(resolved.manifest.id).toBe(id);
				expect(resolved.digest).toStartWith("sha256:");
			}
		}
	});

	test("basic scenarios cover clarify, grill, plan, and panel review", () => {
		expect(kindLabel(routine("01-clarify", "clarify").manifest)).toBe("text");
		expect(kindLabel(routine("02-grill", "grill").manifest)).toBe("text");
		expect(routine("02-grill", "grill").agents).toEqual({ griller: { adapter: "claude", model: "default" } });
		expect(kindLabel(routine("03-plan", "plan").manifest)).toBe("text");

		const panel = routine("04-panel-review", "panel-review");
		expect(kindLabel(panel.manifest)).toBe("text");
		expect(Object.keys(panel.manifest.participants)).toEqual(["explorer", "critic", "judge"]);
		expect(panel.agents).toEqual({
			fast: { adapter: "gemini", model: "default" },
			critic: { adapter: "claude", model: "haiku" },
			judge: { adapter: "claude", model: "sonnet" },
		});
	});

	test("loop scenarios cover judged, check-gated, and compound exits", () => {
		const refine = routine("05-refine-loop", "refine").manifest;
		expect(kindLabel(refine)).toBe("loop");
		expect(isSandboxed(refine)).toBe(false);
		expect(refine.repeat?.until).toEqual({ step: "verdict", equals: "ship" });

		const implementation = routine("06-implementation-loop", "implement").manifest;
		expect(kindLabel(implementation)).toBe("loop");
		expect(isSandboxed(implementation)).toBe(true);
		expect(implementation.repeat?.until).toBe("checks-pass");

		// 08 is the one advanced scenario that blocks on a model verdict. It uses the robust
		// SPLIT form: a free-form `review` (feedback for the builder) + a constrained `verdict`
		// (the "pass"/"revise" signal the loop gates on). Even so it is fragile vs a check.
		const blockingReview = routine("08-review-blocks-loop", "implement").manifest;
		expect(blockingReview.repeat?.until).toEqual({ all: ["checks-pass", { step: "verdict", equals: "pass" }] });

		const forcedRevise = routine("09-check-fails-then-recovers", "forced-revise").manifest;
		expect(kindLabel(forcedRevise)).toBe("loop");
		expect(isSandboxed(forcedRevise)).toBe(true);
		expect(forcedRevise.steps.find((s) => s.id === "verify")).toEqual({
			id: "verify",
			kind: "check",
			checks: [{ command: "grep", args: ["-qxF", "open-sesame-42", "src/secret.txt"] }],
		});
	});

	test("feature flow resolves grill, plan, human gate, and terminal implementation", () => {
		const { routines, resolve } = loadScenario("07-feature-flow");
		const flow = routines["feature-flow"];
		if (flow === undefined) throw new Error("missing feature-flow");

		expect(isComposition(flow.manifest)).toBe(true);
		const resolved = resolveFlow(flow, resolve);
		expect(resolved.steps.map((s) => [s.id, s.kind])).toEqual([
			["grill", "routine"],
			["plan", "routine"],
			["approve", "ask"],
			["impl", "routine"],
		]);
		const terminal = resolved.steps.at(-1);
		expect(terminal?.kind).toBe("routine");
		if (terminal?.kind === "routine") {
			expect(terminal.routine.id).toBe("implement");
			expect(isSandboxed(terminal.routine.manifest)).toBe(true);
		}
	});

	test("cross-run handoff is explicit: produce context, then paste it into implementation", () => {
		const { routines } = loadScenario("10-cross-run-handoff");
		const panel = routines["panel-review"];
		if (panel === undefined) throw new Error("missing panel-review");
		expect(kindLabel(panel.manifest)).toBe("text");

		const impl = routines["implement-with-context"];
		if (impl === undefined) throw new Error("missing implement-with-context");
		expect(kindLabel(impl.manifest)).toBe("loop");
		expect(impl.manifest.inputs.context).toEqual({
			type: "string",
			required: true,
			description: "manual output from a prior run",
		});
		// checks-first default: the critic is advisory feedback, the deterministic check is the gate
		// (the cross-run handoff is the focus here, not a fragile blocking verdict).
		expect(impl.manifest.repeat?.until).toBe("checks-pass");
	});
});
