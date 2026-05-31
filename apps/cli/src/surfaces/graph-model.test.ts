import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	buildGraphModel,
	parseManifest,
	parseRegistry,
	resolveParticipantSnapshots,
	validationSeverity,
} from "@chit/core";

const EXAMPLES = join(import.meta.dir, "..", "..", "examples");
const CONSULT = JSON.parse(readFileSync(join(EXAMPLES, "consult.json"), "utf-8"));
const ASK_CODEX = JSON.parse(readFileSync(join(EXAMPLES, "ask-codex.json"), "utf-8"));
const INVESTIGATE_BUG = JSON.parse(readFileSync(join(EXAMPLES, "investigate-bug.json"), "utf-8"));

const REGISTRY = parseRegistry(undefined);

describe("buildGraphModel: structural fields", () => {
	test("consult.json produces parallel-fan-out node structure", () => {
		const model = buildGraphModel(parseManifest(CONSULT), REGISTRY);
		expect(model.manifest.id).toBe("consult");
		expect(model.manifest.output).toBe("out");

		// Three steps + one input → four nodes total
		expect(model.nodes.length).toBe(4);
		const byKind: Record<string, number> = { input: 0, call: 0, format: 0 };
		for (const n of model.nodes) byKind[n.kind] = (byKind[n.kind] ?? 0) + 1;
		expect(byKind).toEqual({ input: 1, call: 2, format: 1 });

		const inputNode = model.nodes.find((n) => n.kind === "input");
		expect(inputNode?.id).toBe("input:question");
		if (inputNode?.kind === "input") {
			expect(inputNode.inputName).toBe("question");
		}

		const out = model.nodes.find((n) => n.id === "out");
		if (out?.kind === "format") {
			expect(out.isOutput).toBe(true);
		}
	});

	test("execution levels match the manifest's topological order", () => {
		const model = buildGraphModel(parseManifest(CONSULT), REGISTRY);
		const askCodex = model.nodes.find((n) => n.id === "ask_codex");
		const askClaude = model.nodes.find((n) => n.id === "ask_claude");
		const out = model.nodes.find((n) => n.id === "out");
		if (askCodex?.kind !== "input")
			expect(askCodex && "executionLevel" in askCodex && askCodex.executionLevel).toBe(0);
		if (askClaude?.kind !== "input")
			expect(askClaude && "executionLevel" in askClaude && askClaude.executionLevel).toBe(0);
		if (out?.kind !== "input") expect(out && "executionLevel" in out && out.executionLevel).toBe(1);
		// The manifest parser's Kahn sort produces deterministic alphabetical
		// ordering at each level; ask_claude sorts before ask_codex.
		expect(model.executionOrder).toEqual([["ask_claude", "ask_codex"], ["out"]]);
	});

	test("edges connect each step to its referenced sources", () => {
		const model = buildGraphModel(parseManifest(CONSULT), REGISTRY);
		const edge = (from: string, to: string) =>
			model.edges.find((e) => e.from === from && e.to === to);
		expect(edge("input:question", "ask_codex")?.kind).toBe("input-ref");
		expect(edge("input:question", "ask_claude")?.kind).toBe("input-ref");
		expect(edge("ask_codex", "out")?.kind).toBe("step-ref");
		expect(edge("ask_claude", "out")?.kind).toBe("step-ref");
	});

	test("participants denormalize adapter + enforcesReadOnly from registry", () => {
		const model = buildGraphModel(parseManifest(CONSULT), REGISTRY);
		expect(model.participants.codex?.adapter).toBe("codex-exec");
		expect(model.participants.codex?.enforcesReadOnly).toBe(true);
		expect(model.participants.claude?.adapter).toBe("claude-cli");
		expect(model.participants.claude?.enforcesReadOnly).toBe(false);
	});

	test("requires.effective is declared ∪ inferred", () => {
		const model = buildGraphModel(parseManifest(CONSULT), REGISTRY);
		expect(model.requires.declared).toEqual({ can_show_markdown: true });
		expect(model.requires.inferred).toEqual({ can_provide_stable_scope: true });
		expect(model.requires.effective).toEqual({
			can_show_markdown: true,
			can_provide_stable_scope: true,
		});
	});
});

describe("buildGraphModel: effective participant config", () => {
	const CUSTOM_REGISTRY = parseRegistry({
		agents: {
			"codex-deep": {
				adapter: "codex-exec",
				model: "gpt-5.5",
				reasoningEffort: "xhigh",
				callTimeoutMs: 600000,
				noProgressTimeoutMs: 120000,
				env: { OPENAI_BASE_URL: "https://example.test" },
			},
			"claude-opus": {
				adapter: "claude-cli",
				model: "opus",
				strictMcp: false,
				passModelOnResume: true,
			},
		},
	});
	const CFG_MANIFEST = parseManifest({
		...CONSULT,
		participants: {
			reviewer: {
				agent: "codex-deep",
				role: "review",
				session: "per_scope",
				permissions: { filesystem: "read_only" },
			},
			implementer: {
				agent: "claude-opus",
				role: "implement",
				session: "per_scope",
				permissions: { filesystem: "read_only" },
			},
		},
		steps: {
			ask_codex: { call: "reviewer", prompt: "{{ inputs.question }}" },
			ask_claude: { call: "implementer", prompt: "{{ inputs.question }}" },
			out: { format: "{{ steps.ask_codex.output }} {{ steps.ask_claude.output }}" },
		},
	});

	test("codex agent resolves model/effort/timeouts and redacts env to key names", () => {
		const c = buildGraphModel(CFG_MANIFEST, CUSTOM_REGISTRY).participants.reviewer?.config;
		expect(c?.model).toBe("gpt-5.5");
		expect(c?.reasoningEffort).toBe("xhigh");
		expect(c?.callTimeoutMs).toBe(600000);
		expect(c?.noProgressTimeoutMs).toBe(120000);
		// env is redacted: key names only, never the value.
		expect(c?.envKeys).toEqual(["OPENAI_BASE_URL"]);
		expect(JSON.stringify(c)).not.toContain("example.test");
		// strictMcp / passModelOnResume apply only to claude-cli.
		expect(c?.strictMcp).toBeUndefined();
		expect(c?.passModelOnResume).toBeUndefined();
	});

	test("claude agent resolves model plus claude-only strictMcp/passModelOnResume", () => {
		const c = buildGraphModel(CFG_MANIFEST, CUSTOM_REGISTRY).participants.implementer?.config;
		expect(c?.model).toBe("opus");
		expect(c?.reasoningEffort).toBeUndefined(); // CLI default
		expect(c?.strictMcp).toBe(false); // explicit opt-out
		expect(c?.passModelOnResume).toBe(true);
		expect(c?.noProgressTimeoutMs).toBeUndefined(); // watchdog off
	});

	test("built-in agents resolve to defaults; claude strict-MCP is effectively on", () => {
		const model = buildGraphModel(parseManifest(CONSULT), REGISTRY);
		expect(model.participants.codex?.config.model).toBeUndefined(); // CLI default
		expect(model.participants.codex?.config.strictMcp).toBeUndefined(); // not claude-cli
		expect(model.participants.claude?.config.model).toBeUndefined();
		expect(model.participants.claude?.config.strictMcp).toBe(true); // default-on
		expect(model.participants.claude?.config.passModelOnResume).toBe(false);
	});

	test("an unknown agent yields an empty config", () => {
		const manifestWithGhost = parseManifest({
			...CONSULT,
			participants: {
				...CONSULT.participants,
				ghost: { agent: "does-not-exist", role: "test", session: "stateless" },
			},
			steps: {
				...CONSULT.steps,
				ask_ghost: { call: "ghost", prompt: "{{ inputs.question }}" },
				out: { format: "{{ steps.ask_ghost.output }}" },
			},
		});
		expect(buildGraphModel(manifestWithGhost, REGISTRY).participants.ghost?.config).toEqual({});
	});

	test("resolveParticipantSnapshots returns the config snapshot, without role", () => {
		const snaps = resolveParticipantSnapshots(CFG_MANIFEST, CUSTOM_REGISTRY);
		expect(snaps.reviewer).toEqual({
			agentId: "codex-deep",
			adapter: "codex-exec",
			session: "per_scope",
			permissions: { filesystem: "read_only" },
			enforcesReadOnly: true,
			config: {
				model: "gpt-5.5",
				reasoningEffort: "xhigh",
				callTimeoutMs: 600000,
				noProgressTimeoutMs: 120000,
				envKeys: ["OPENAI_BASE_URL"],
			},
		});
		// role is deliberately omitted from the snapshot (it lives in prompt blobs).
		expect(snaps.reviewer && "role" in snaps.reviewer).toBe(false);
	});
});

describe("buildGraphModel: surface and validation", () => {
	test("without surface, surface and validation are null", () => {
		const model = buildGraphModel(parseManifest(CONSULT), REGISTRY);
		expect(model.surface).toBeNull();
		expect(model.validation).toBeNull();
	});

	test("claude-skill surface: consult is capability-compatible but needs override", () => {
		const model = buildGraphModel(parseManifest(CONSULT), REGISTRY, "claude-skill");
		expect(model.surface?.kind).toBe("claude-skill");
		expect(model.validation?.capabilities.compatible).toBe(true);
		expect(model.validation?.capabilities.missing).toEqual([]);
		expect(model.validation?.permissions.status).toBe("needs_override");
		expect(model.validation?.permissions.gaps.length).toBe(1);
		expect(model.validation?.permissions.gaps[0]?.participantId).toBe("claude");
	});

	test("claude-skill surface: ask-codex has no gaps (codex-exec enforces)", () => {
		const model = buildGraphModel(parseManifest(ASK_CODEX), REGISTRY, "claude-skill");
		expect(model.validation?.capabilities.compatible).toBe(true);
		expect(model.validation?.permissions.status).toBe("ok");
		expect(model.validation?.permissions.gaps).toEqual([]);
	});

	test("claude-skill surface: investigate-bug missing can_pass_files", () => {
		const model = buildGraphModel(parseManifest(INVESTIGATE_BUG), REGISTRY, "claude-skill");
		expect(model.validation?.capabilities.compatible).toBe(false);
		expect(model.validation?.capabilities.missing).toContain("can_pass_files");
	});

	test("unknown surface throws", () => {
		expect(() => buildGraphModel(parseManifest(CONSULT), REGISTRY, "imaginary-surface")).toThrow(
			/unknown surface/,
		);
	});

	test("unknown agents are surfaced as a blocking validation issue", () => {
		const manifestWithGhost = parseManifest({
			...CONSULT,
			participants: {
				...CONSULT.participants,
				ghost: { agent: "does-not-exist", role: "test", session: "stateless" },
			},
			steps: {
				...CONSULT.steps,
				ask_codex: { call: "codex", prompt: "{{ inputs.question }}" },
				ask_ghost: { call: "ghost", prompt: "{{ inputs.question }}" },
				out: {
					format: "## codex\n{{ steps.ask_codex.output }}\n## ghost\n{{ steps.ask_ghost.output }}",
				},
			},
		});
		const model = buildGraphModel(manifestWithGhost, REGISTRY, "claude-skill");
		expect(model.validation?.agents.resolved).toBe(false);
		expect(model.validation?.agents.unknown.length).toBe(1);
		expect(model.validation?.agents.unknown[0]?.participantId).toBe("ghost");
		expect(model.validation?.agents.unknown[0]?.agentId).toBe("does-not-exist");
	});

	test("CLI surface carries the --scope caveat when manifest needs stable scope", () => {
		const model = buildGraphModel(parseManifest(CONSULT), REGISTRY, "cli");
		expect(model.surface?.notes).toContain("can_provide_stable_scope requires --scope at run time");
	});

	test("CLI surface omits the --scope caveat for stateless manifests", () => {
		// ask-codex is stateless: no per_scope participants, no can_provide_stable_scope
		// in requires. The --scope note should not appear.
		const model = buildGraphModel(parseManifest(ASK_CODEX), REGISTRY, "cli");
		expect(model.surface?.notes).toEqual([]);
	});

	test("claude-skill surface has no run-time notes", () => {
		const model = buildGraphModel(parseManifest(CONSULT), REGISTRY, "claude-skill");
		expect(model.surface?.notes).toEqual([]);
	});
});

describe("validationSeverity", () => {
	test("null validation → ok", () => {
		expect(validationSeverity(null)).toBe("ok");
	});

	test("missing capability → error (install-blocking)", () => {
		const model = buildGraphModel(parseManifest(INVESTIGATE_BUG), REGISTRY, "claude-skill");
		expect(validationSeverity(model.validation)).toBe("error");
	});

	test("permission needs override only → warn (overridable)", () => {
		const model = buildGraphModel(parseManifest(CONSULT), REGISTRY, "claude-skill");
		expect(validationSeverity(model.validation)).toBe("warn");
	});

	test("codex-only manifest → ok", () => {
		const model = buildGraphModel(parseManifest(ASK_CODEX), REGISTRY, "claude-skill");
		expect(validationSeverity(model.validation)).toBe("ok");
	});

	test("permission blocked → error (no override path)", () => {
		// The current code paths don't produce "blocked", but the severity
		// contract says they should hard-fail. Construct one synthetically
		// to verify the mapping.
		const model = buildGraphModel(parseManifest(CONSULT), REGISTRY, "claude-skill");
		const blocked = {
			capabilities: { compatible: true, missing: [] },
			permissions: { status: "blocked" as const, gaps: [] },
			agents: { resolved: true, unknown: [] },
		};
		expect(validationSeverity({ ...model.validation, ...blocked })).toBe("error");
	});

	test("unknown agent → error (install-blocking)", () => {
		const manifestWithGhost = parseManifest({
			...CONSULT,
			participants: {
				codex: { agent: "missing", role: "x", session: "stateless" },
			},
			steps: {
				s: { call: "codex", prompt: "{{ inputs.question }}" },
				out: { format: "{{ steps.s.output }}" },
			},
		});
		const model = buildGraphModel(manifestWithGhost, REGISTRY, "claude-skill");
		expect(validationSeverity(model.validation)).toBe("error");
	});
});
