import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	buildGraphModel,
	type GraphModel,
	parseManifest,
	parseRegistry,
	renderShow,
} from "@chit/core";

const EXAMPLES = join(import.meta.dir, "..", "..", "examples");
const CONSULT = JSON.parse(readFileSync(join(EXAMPLES, "consult.json"), "utf-8"));
const ASK_CODEX = JSON.parse(readFileSync(join(EXAMPLES, "ask-codex.json"), "utf-8"));
const REGISTRY = parseRegistry(undefined);

function buildConsult(surface?: string): GraphModel {
	return buildGraphModel(parseManifest(CONSULT), REGISTRY, surface);
}

describe("renderShow: json", () => {
	test("emits parseable JSON matching the graph model", () => {
		const out = renderShow(buildConsult("claude-skill"), "json");
		const parsed = JSON.parse(out);
		expect(parsed.manifest.id).toBe("consult");
		expect(parsed.surface.kind).toBe("claude-skill");
		expect(parsed.validation.permissions.status).toBe("needs_override");
	});
});

describe("renderShow: ascii", () => {
	test("contains manifest id, participants, execution levels", () => {
		const out = renderShow(buildConsult("claude-skill"), "ascii");
		expect(out).toContain("manifest: consult");
		expect(out).toContain("surface: claude-skill");
		expect(out).toContain("NEEDS OVERRIDE");
		expect(out).toContain("participants:");
		expect(out).toContain("codex");
		expect(out).toContain("claude");
		expect(out).toContain("level 0");
		expect(out).toContain("[parallel]");
		expect(out).toContain("level 1");
		expect(out).toContain("[final]");
		expect(out).toContain("(output)");
	});

	test("omits surface block when no surface provided", () => {
		const out = renderShow(buildConsult(), "ascii");
		expect(out).not.toContain("surface:");
		expect(out).not.toContain("validation");
	});

	test("codex-only manifest shows permissions OK", () => {
		const m = buildGraphModel(parseManifest(ASK_CODEX), REGISTRY, "claude-skill");
		const out = renderShow(m, "ascii");
		expect(out).toContain("OK");
		expect(out).not.toContain("NEEDS OVERRIDE");
	});
});

describe("renderShow: mermaid", () => {
	test("emits valid-looking graph LR with node ids", () => {
		const out = renderShow(buildConsult(), "mermaid");
		expect(out.startsWith("graph LR")).toBe(true);
		// Mermaid sanitizes node ids: input:question → input_question
		expect(out).toContain("input_question");
		expect(out).toContain("ask_codex");
		expect(out).toContain("ask_claude");
		expect(out).toContain("out");
		// Edges
		expect(out).toContain("input_question --> ask_codex");
		expect(out).toContain("input_question --> ask_claude");
		expect(out).toContain("ask_codex --> out");
		expect(out).toContain("ask_claude --> out");
	});
});

describe("renderShow: html", () => {
	test("emits valid HTML5 document with manifest content", () => {
		const out = renderShow(buildConsult("claude-skill"), "html");
		expect(out.trim().startsWith("<!DOCTYPE html>")).toBe(true);
		expect(out).toContain("<title>chit: consult</title>");
		expect(out).toContain(">consult<");
		expect(out).toContain("ask_codex");
		expect(out).toContain("ask_claude");
	});

	test("shows validation block when surface provided and gaps exist", () => {
		const out = renderShow(buildConsult("claude-skill"), "html");
		expect(out).toContain("Permissions: needs_override");
		expect(out).toContain("claude");
		expect(out).toContain("cannot enforce");
	});

	test("permission-only gap renders as warn (yellow), not error (red)", () => {
		const out = renderShow(buildConsult("claude-skill"), "html");
		expect(out).toContain('<section class="validation warn">');
		expect(out).not.toContain('<section class="validation error">');
	});

	test("missing-capability renders as error (red)", () => {
		const investigate = JSON.parse(readFileSync(join(EXAMPLES, "investigate-bug.json"), "utf-8"));
		const m = buildGraphModel(parseManifest(investigate), REGISTRY, "claude-skill");
		const out = renderShow(m, "html");
		expect(out).toContain('<section class="validation error">');
		expect(out).toContain("Missing capabilities");
	});

	test("CLI surface note appears in HTML header", () => {
		const out = renderShow(buildConsult("cli"), "html");
		expect(out).toContain("can_provide_stable_scope requires --scope at run time");
	});

	test("omits validation block when no surface", () => {
		const out = renderShow(buildConsult(), "html");
		expect(out).not.toContain("Permissions:");
		expect(out).toContain("no surface selected");
	});

	test("escapes user content (description, role) to prevent injection", () => {
		const malicious = {
			...CONSULT,
			description: 'Consult <script>alert("xss")</script>',
		};
		const m = buildGraphModel(parseManifest(malicious), REGISTRY, "claude-skill");
		const out = renderShow(m, "html");
		expect(out).not.toContain("<script>alert");
		expect(out).toContain("&lt;script&gt;");
	});
});
