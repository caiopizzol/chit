// Discovery: explicit path > one cwd chit > picker > empty. No recursion.

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discover } from "./discovery.ts";

function tempCwd(): string {
	return mkdtempSync(join(tmpdir(), "chit-studio-discovery-"));
}

// Minimal valid chit shape. Mirrors apps/cli/examples but tiny so the tests
// stay self-contained.
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

describe("discover", () => {
	test("empty cwd returns empty", () => {
		const cwd = tempCwd();
		try {
			expect(discover({ cwd }).kind).toBe("empty");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("single chit-shaped json returns open", () => {
		const cwd = tempCwd();
		try {
			writeFileSync(join(cwd, "consult.json"), chit("consult"));
			const r = discover({ cwd });
			expect(r.kind).toBe("open");
			if (r.kind === "open") {
				expect(r.relPath).toBe("consult.json");
				expect(r.absolutePath).toBe(join(cwd, "consult.json"));
			}
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("multiple chits return picker, sorted by relPath", () => {
		const cwd = tempCwd();
		try {
			writeFileSync(join(cwd, "b.json"), chit("b"));
			writeFileSync(join(cwd, "a.json"), chit("a"));
			const r = discover({ cwd });
			expect(r.kind).toBe("picker");
			if (r.kind === "picker") {
				expect(r.candidates.map((c) => c.relPath)).toEqual(["a.json", "b.json"]);
			}
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("non-chit json files are silently dropped", () => {
		const cwd = tempCwd();
		try {
			writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "x" }));
			writeFileSync(join(cwd, "tsconfig.json"), JSON.stringify({ extends: "y" }));
			writeFileSync(join(cwd, "consult.json"), chit("consult"));
			const r = discover({ cwd });
			expect(r.kind).toBe("open");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("invalid JSON is silently dropped", () => {
		const cwd = tempCwd();
		try {
			writeFileSync(join(cwd, "broken.json"), "not json");
			writeFileSync(join(cwd, "consult.json"), chit("consult"));
			const r = discover({ cwd });
			expect(r.kind).toBe("open");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("does NOT recurse into subdirectories", () => {
		const cwd = tempCwd();
		try {
			mkdirSync(join(cwd, "nested"));
			writeFileSync(join(cwd, "nested", "consult.json"), chit("consult"));
			expect(discover({ cwd }).kind).toBe("empty");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("explicit path wins over cwd scan", () => {
		const cwd = tempCwd();
		try {
			writeFileSync(join(cwd, "a.json"), chit("a"));
			writeFileSync(join(cwd, "b.json"), chit("b"));
			const r = discover({ cwd, explicitPath: "a.json" });
			expect(r.kind).toBe("open");
			if (r.kind === "open") expect(r.relPath).toBe("a.json");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("explicit path may live outside cwd", () => {
		const parent = tempCwd();
		const cwd = join(parent, "child");
		mkdirSync(cwd);
		writeFileSync(join(parent, "sibling.json"), chit("sibling"));
		try {
			const r = discover({ cwd, explicitPath: "../sibling.json" });
			expect(r.kind).toBe("open");
			if (r.kind === "open") {
				expect(r.absolutePath).toBe(join(parent, "sibling.json"));
				// relPath falls back to basename when the path escapes cwd.
				expect(r.relPath).toBe("sibling.json");
			}
		} finally {
			rmSync(parent, { recursive: true, force: true });
		}
	});
});
