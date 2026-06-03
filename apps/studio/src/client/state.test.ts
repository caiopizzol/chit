// initClientState maps each Bootstrap variant to the ClientState shape the
// App switches on. Slice 1 keeps draft immutable; slice 2 makes it the edit
// target.

import { describe, expect, test } from "bun:test";
import { buildGraphModel, parseManifest, parseRegistry, resolveManifest } from "@chit-run/core";

// buildGraphModel consumes a ResolvedManifest now; inline fixtures resolve (no roles).
function resolved(raw: unknown) {
	return resolveManifest(parseManifest(raw), { roles: {} });
}

import { initClientState } from "./state.ts";

const REGISTRY = parseRegistry(undefined);

function chit(id: string): string {
	return JSON.stringify({
		schema: 1,
		id,
		description: `t ${id}`,
		inputs: { q: { type: "string" } },
		requires: {},
		participants: { a: { agent: "claude", instructions: "r", session: "stateless" } },
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

	test("open + parsed bootstrap → open mode with raw, draftSource, graphModel", () => {
		const raw = chit("consult");
		const manifest = resolved(JSON.parse(raw));
		const graphModel = buildGraphModel(manifest, REGISTRY);
		const state = initClientState({
			mode: "open",
			docId: "current",
			document: { id: "current", relPath: "consult.json", raw, status: "parsed", manifest },
			graphModel,
			hash: "a".repeat(64),
		});
		expect(state.mode).toBe("open");
		if (state.mode === "open") {
			expect(state.docId).toBe("current");
			expect(state.relPath).toBe("consult.json");
			expect(state.raw).toBe(raw);
			// hash flows through from bootstrap so the client has a baseHash
			// available for the first PUT without an extra round trip.
			expect(state.hash).toBe("a".repeat(64));
			// draftSource is the file-shape JSON, not the NormalizedManifest.
			expect(state.draftSource.id).toBe("consult");
			expect(state.draftSource.schema).toBe(1);
			// derived fields from NormalizedManifest must NOT be on draftSource
			expect("dependencies" in state.draftSource).toBe(false);
			expect("executionOrder" in state.draftSource).toBe(false);
			expect(state.graphModel.manifest.id).toBe("consult");
			expect(state.dirty).toBe(false);
			expect(state.previewPending).toBe(false);
			expect(state.previewError).toBeNull();
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
			hash: "b".repeat(64),
		});
		expect(state.mode).toBe("open-error");
		if (state.mode === "open-error") {
			expect(state.relPath).toBe("broken.json");
			expect(state.parseError).toContain("not valid JSON");
		}
	});
});
