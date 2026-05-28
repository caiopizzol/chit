// DocStore + buildBootstrap. The store maps docId to absolutePath internally
// and produces DocumentDetail / Bootstrap shapes for the wire.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRegistry } from "@chit/core";
import { buildBootstrap, DocStore } from "./docs.ts";

const REGISTRY = parseRegistry(undefined);

function tempCwd(): string {
	return mkdtempSync(join(tmpdir(), "chit-studio-docs-"));
}

function chit(id: string): string {
	return JSON.stringify({
		schema: 1,
		id,
		description: `test chit ${id}`,
		inputs: { q: { type: "string" } },
		requires: {},
		participants: {
			a: { agent: "claude", role: "r", session: "stateless" },
		},
		steps: {
			s: { call: "a", prompt: "{{ inputs.q }}" },
		},
		output: "s",
	});
}

describe("DocStore.get", () => {
	test("returns null for an unknown docId", () => {
		const cwd = tempCwd();
		try {
			const store = new DocStore(cwd, REGISTRY);
			expect(store.get("nope")).toBeNull();
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("returns parsed document + graphModel for a valid chit", () => {
		const cwd = tempCwd();
		try {
			const path = join(cwd, "consult.json");
			writeFileSync(path, chit("consult"));
			const store = new DocStore(cwd, REGISTRY);
			store.add("current", path);
			const detail = store.get("current");
			expect(detail).not.toBeNull();
			expect(detail?.document.status).toBe("parsed");
			if (detail && "graphModel" in detail) {
				expect(detail.document.id).toBe("current");
				expect(detail.document.relPath).toBe("consult.json");
				expect(detail.document.manifest.id).toBe("consult");
				expect(detail.graphModel.manifest.id).toBe("consult");
			}
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("returns error document for non-JSON content", () => {
		const cwd = tempCwd();
		try {
			const path = join(cwd, "broken.json");
			writeFileSync(path, "not json");
			const store = new DocStore(cwd, REGISTRY);
			store.add("current", path);
			const detail = store.get("current");
			expect(detail?.document.status).toBe("error");
			if (detail && detail.document.status === "error") {
				expect(detail.document.parseError).toContain("not valid JSON");
			}
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("returns error document for valid JSON that is not a chit", () => {
		const cwd = tempCwd();
		try {
			const path = join(cwd, "package.json");
			writeFileSync(path, JSON.stringify({ name: "x" }));
			const store = new DocStore(cwd, REGISTRY);
			store.add("current", path);
			const detail = store.get("current");
			expect(detail?.document.status).toBe("error");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("absolutePath is NOT exposed on the document wire shape", () => {
		const cwd = tempCwd();
		try {
			const path = join(cwd, "consult.json");
			writeFileSync(path, chit("consult"));
			const store = new DocStore(cwd, REGISTRY);
			store.add("current", path);
			const detail = store.get("current");
			expect(
				(detail?.document as unknown as { absolutePath?: string }).absolutePath,
			).toBeUndefined();
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

describe("DocStore.get with surface", () => {
	test("default (no surface) yields graphModel with validation null", () => {
		const cwd = tempCwd();
		try {
			const path = join(cwd, "consult.json");
			writeFileSync(path, chit("consult"));
			const store = new DocStore(cwd, REGISTRY);
			store.add("current", path);
			const detail = store.get("current");
			if (detail && "graphModel" in detail) {
				expect(detail.graphModel.validation).toBeNull();
				expect(detail.graphModel.surface).toBeNull();
			} else {
				throw new Error("expected parsed detail");
			}
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("surface=claude-skill yields graphModel with validation populated", () => {
		const cwd = tempCwd();
		try {
			const path = join(cwd, "consult.json");
			writeFileSync(path, chit("consult"));
			const store = new DocStore(cwd, REGISTRY);
			store.add("current", path);
			const detail = store.get("current", "claude-skill");
			if (detail && "graphModel" in detail) {
				expect(detail.graphModel.validation).not.toBeNull();
				expect(detail.graphModel.surface?.kind).toBe("claude-skill");
			} else {
				throw new Error("expected parsed detail");
			}
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("surface=cli also yields populated validation", () => {
		const cwd = tempCwd();
		try {
			const path = join(cwd, "consult.json");
			writeFileSync(path, chit("consult"));
			const store = new DocStore(cwd, REGISTRY);
			store.add("current", path);
			const detail = store.get("current", "cli");
			if (detail && "graphModel" in detail) {
				expect(detail.graphModel.validation).not.toBeNull();
				expect(detail.graphModel.surface?.kind).toBe("cli");
			} else {
				throw new Error("expected parsed detail");
			}
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

describe("buildBootstrap", () => {
	test("empty discovery yields { mode: empty }", () => {
		const cwd = tempCwd();
		try {
			const store = new DocStore(cwd, REGISTRY);
			const boot = buildBootstrap({ kind: "empty" }, store);
			expect(boot.mode).toBe("empty");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("open discovery yields open mode with parsed document + graphModel", () => {
		const cwd = tempCwd();
		try {
			const path = join(cwd, "consult.json");
			writeFileSync(path, chit("consult"));
			const store = new DocStore(cwd, REGISTRY);
			const boot = buildBootstrap(
				{ kind: "open", absolutePath: path, relPath: "consult.json" },
				store,
			);
			expect(boot.mode).toBe("open");
			if (boot.mode === "open") {
				expect(boot.docId).toBe("current");
				expect(boot.document.status).toBe("parsed");
				if (boot.document.status === "parsed") {
					expect("graphModel" in boot).toBe(true);
				}
			}
			// And the store has the docId so subsequent /api/documents/current works.
			expect(store.has("current")).toBe(true);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("picker discovery yields picker mode with stable docIds", () => {
		const cwd = tempCwd();
		try {
			const a = join(cwd, "a.json");
			const b = join(cwd, "b.json");
			writeFileSync(a, chit("a"));
			writeFileSync(b, chit("b"));
			const store = new DocStore(cwd, REGISTRY);
			const boot = buildBootstrap(
				{
					kind: "picker",
					candidates: [
						{ absolutePath: a, relPath: "a.json" },
						{ absolutePath: b, relPath: "b.json" },
					],
				},
				store,
			);
			expect(boot.mode).toBe("picker");
			if (boot.mode === "picker") {
				expect(boot.candidates.map((c) => c.docId)).toEqual(["c0", "c1"]);
				expect(boot.candidates.map((c) => c.relPath)).toEqual(["a.json", "b.json"]);
				expect(boot.candidates.every((c) => c.status === "parsed")).toBe(true);
			}
			expect(store.has("c0")).toBe(true);
			expect(store.has("c1")).toBe(true);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});
