// initClientState maps each Bootstrap variant to the ClientState shape the
// App switches on. Slice 1 keeps draft immutable; slice 2 makes it the edit
// target.

import { describe, expect, test } from "bun:test";
import { buildGraphModel, parseManifest, parseRegistry } from "@chit/core";
import { initClientState } from "./state.ts";

const REGISTRY = parseRegistry(undefined);

function chit(id: string): string {
	return JSON.stringify({
		schema: 1,
		id,
		description: `t ${id}`,
		inputs: { q: { type: "string" } },
		requires: {},
		participants: { a: { agent: "claude", role: "r", session: "stateless" } },
		steps: { s: { call: "a", prompt: "{{ inputs.q }}" } },
		output: "s",
	});
}

describe("initClientState", () => {
	test("empty bootstrap → empty mode", () => {
		const state = initClientState({ mode: "empty" });
		expect(state.mode).toBe("empty");
	});

	test("picker bootstrap → picker mode with candidates passed through", () => {
		const state = initClientState({
			mode: "picker",
			candidates: [
				{ docId: "c0", relPath: "a.json", status: "parsed" },
				{ docId: "c1", relPath: "b.json", status: "error" },
			],
		});
		expect(state.mode).toBe("picker");
		if (state.mode === "picker") {
			expect(state.candidates).toHaveLength(2);
			expect(state.candidates[0]?.relPath).toBe("a.json");
		}
	});

	test("open + parsed bootstrap → open mode with raw, draft, graphModel", () => {
		const raw = chit("consult");
		const manifest = parseManifest(JSON.parse(raw));
		const graphModel = buildGraphModel(manifest, REGISTRY);
		const state = initClientState({
			mode: "open",
			docId: "current",
			document: { id: "current", relPath: "consult.json", raw, status: "parsed", manifest },
			graphModel,
		});
		expect(state.mode).toBe("open");
		if (state.mode === "open") {
			expect(state.docId).toBe("current");
			expect(state.relPath).toBe("consult.json");
			expect(state.raw).toBe(raw);
			expect(state.draft.id).toBe("consult");
			expect(state.graphModel.manifest.id).toBe("consult");
		}
	});

	test("open + error bootstrap → open-error mode with the parse error", () => {
		const state = initClientState({
			mode: "open",
			docId: "current",
			document: {
				id: "current",
				relPath: "broken.json",
				raw: "not json",
				status: "error",
				parseError: "not valid JSON: Unexpected token o in JSON at position 1",
			},
		});
		expect(state.mode).toBe("open-error");
		if (state.mode === "open-error") {
			expect(state.relPath).toBe("broken.json");
			expect(state.parseError).toContain("not valid JSON");
		}
	});
});
