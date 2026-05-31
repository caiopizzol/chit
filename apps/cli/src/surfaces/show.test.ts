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

	test("includes resolved per-participant config", () => {
		const parsed = JSON.parse(renderShow(buildConsult(), "json"));
		// claude-cli surfaces its effective strict-MCP (default-on) and passModelOnResume.
		expect(parsed.participants.claude.config.strictMcp).toBe(true);
		expect(parsed.participants.claude.config.passModelOnResume).toBe(false);
		// codex (no claude-only fields, no pinned model) resolves to an empty config.
		expect(parsed.participants.codex.config).toEqual({});
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

	test("renders effective participant config, with defaults and claude strict-MCP", () => {
		const out = renderShow(buildConsult("claude-skill"), "ascii");
		// Every participant gets a config line; an unset model/effort shows as default
		// and the no-progress watchdog shows as off.
		expect(out).toMatch(
			/config\s+model=default\s+effort=default\s+callTimeout=default\s+noProgress=off/,
		);
		// claude-cli surfaces its strict-MCP effective value and passModelOnResume.
		expect(out).toContain("strictMcp=on");
		expect(out).toContain("passModelOnResume=no");
	});

	test("renders an unknown agent's config as unresolved, not defaults", () => {
		const ghost = buildGraphModel(
			parseManifest({
				...CONSULT,
				participants: {
					...CONSULT.participants,
					ghost: { agent: "does-not-exist", role: "test", session: "stateless" },
				},
				steps: {
					...CONSULT.steps,
					ask_ghost: { call: "ghost", prompt: "{{ inputs.question }}" },
					out: { format: "## ghost\n{{ steps.ask_ghost.output }}" },
				},
			}),
			REGISTRY,
		);
		const ascii = renderShow(ghost, "ascii");
		expect(ascii).toContain("unresolved (unknown agent)");
		// HTML shows the same as a warn badge, not default config badges.
		expect(renderShow(ghost, "html")).toContain("config: unresolved (unknown agent)");
		// JSON keeps {} since adapter=unknown plus validation carry the structure.
		const json = JSON.parse(renderShow(ghost, "json"));
		expect(json.participants.ghost.config).toEqual({});
		expect(json.participants.ghost.adapter).toBe("unknown");
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

	test("renders participant config as badges", () => {
		const out = renderShow(buildConsult("claude-skill"), "html");
		expect(out).toContain('class="participant-config"');
		expect(out).toContain("model: default");
		expect(out).toContain("strictMcp: on");
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
