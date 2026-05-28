// graphAdapter takes any GraphModel and produces React Flow nodes/edges
// without baking in chit-specific assumptions. Verified against real
// manifests built with parseManifest + buildGraphModel.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildGraphModel, parseManifest, parseRegistry } from "@chit/core";
import { adaptGraphModel } from "./graphAdapter.ts";

const REGISTRY = parseRegistry(undefined);
const EXAMPLES_DIR = join(import.meta.dir, "..", "..", "..", "cli", "examples");

function loadGraphModel(filename: string) {
	const raw = JSON.parse(readFileSync(join(EXAMPLES_DIR, filename), "utf-8"));
	const manifest = parseManifest(raw);
	return buildGraphModel(manifest, REGISTRY);
}

describe("adaptGraphModel", () => {
	test("consult.json yields input + two calls + one format", () => {
		const model = loadGraphModel("consult.json");
		const adapted = adaptGraphModel(model);
		const byType = {
			input: adapted.nodes.filter((n) => n.type === "input"),
			call: adapted.nodes.filter((n) => n.type === "call"),
			format: adapted.nodes.filter((n) => n.type === "format"),
		};
		expect(byType.input).toHaveLength(1);
		expect(byType.call).toHaveLength(2);
		expect(byType.format).toHaveLength(1);
	});

	test("input node carries name + type + required from the manifest's inputs map", () => {
		const model = loadGraphModel("consult.json");
		const adapted = adaptGraphModel(model);
		const input = adapted.nodes.find((n) => n.type === "input");
		expect(input).toBeDefined();
		expect(input?.data).toMatchObject({
			name: "question",
			type: "string",
			required: true,
		});
	});

	test("call node carries agent + session + filesystem from the matching participant", () => {
		const model = loadGraphModel("consult.json");
		const adapted = adaptGraphModel(model);
		const codexCall = adapted.nodes.find((n) => n.id === "ask_codex");
		expect(codexCall).toBeDefined();
		expect(codexCall?.data).toMatchObject({
			id: "ask_codex",
			agent: "codex",
			session: "per_scope",
			filesystem: "read_only",
		});
		// sub-unit 1.2 leaves warn undefined; lands in 1.3
		expect((codexCall?.data as { warn?: unknown }).warn).toBeUndefined();
	});

	test("format node carries isOutput true for the chit's canonical output step", () => {
		const model = loadGraphModel("consult.json");
		const adapted = adaptGraphModel(model);
		const out = adapted.nodes.find((n) => n.id === "out");
		expect(out).toBeDefined();
		expect(out?.data).toMatchObject({
			id: "out",
			isOutput: true,
		});
		expect((out?.data as { refsCount: number }).refsCount).toBeGreaterThan(0);
	});

	test("edges are derived from GraphEdge with deterministic ids", () => {
		const model = loadGraphModel("consult.json");
		const adapted = adaptGraphModel(model);
		expect(adapted.edges.length).toBe(model.edges.length);
		for (const e of adapted.edges) {
			expect(e.id).toBe(`${e.source}->${e.target}`);
		}
	});

	test("size map contains an entry for every node", () => {
		const model = loadGraphModel("consult.json");
		const adapted = adaptGraphModel(model);
		for (const n of adapted.nodes) {
			expect(adapted.sizes[n.id]).toBeDefined();
		}
	});

	test("investigate-bug.json (sequential with verification) adapts without throwing", () => {
		const model = loadGraphModel("investigate-bug.json");
		const adapted = adaptGraphModel(model);
		expect(adapted.nodes.length).toBeGreaterThan(0);
		expect(adapted.edges.length).toBeGreaterThan(0);
	});

	test("validation=null leaves every call node without warn", () => {
		const model = loadGraphModel("consult.json");
		// no surface passed → validation is null
		expect(model.validation).toBeNull();
		const adapted = adaptGraphModel(model);
		for (const n of adapted.nodes.filter((x) => x.type === "call")) {
			expect((n.data as { warn?: unknown }).warn).toBeUndefined();
		}
	});

	test("consult + claude-skill: ask_claude gets warn (gap), ask_codex does not", () => {
		const raw = JSON.parse(readFileSync(join(EXAMPLES_DIR, "consult.json"), "utf-8"));
		const manifest = parseManifest(raw);
		const model = buildGraphModel(manifest, REGISTRY, "claude-skill");
		expect(model.validation).not.toBeNull();
		// Sanity: at least one gap exists on the claude participant.
		const gappedParticipants = new Set(
			model.validation?.permissions.gaps.map((g) => g.participantId),
		);
		expect(gappedParticipants.has("claude")).toBe(true);
		expect(gappedParticipants.has("codex")).toBe(false);

		const adapted = adaptGraphModel(model);
		const askClaude = adapted.nodes.find((n) => n.id === "ask_claude");
		const askCodex = adapted.nodes.find((n) => n.id === "ask_codex");
		expect((askClaude?.data as { warn?: { tag: string } }).warn?.tag).toBe("needs check");
		expect((askCodex?.data as { warn?: unknown }).warn).toBeUndefined();
	});
});
