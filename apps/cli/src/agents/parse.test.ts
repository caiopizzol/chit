import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAdapterDescriptor, isBuiltInAgent, parseRegistry, RegistryError } from "@chit-run/core";
import { loadRegistry } from "./parse.ts";

function expectRegistryError(
	raw: unknown,
	pathFragment: string,
	msgFragment?: string,
	configPath = "<inline>",
): void {
	let caught: unknown;
	try {
		parseRegistry(raw, configPath);
	} catch (e) {
		caught = e;
	}
	if (!(caught instanceof RegistryError)) {
		throw new Error(
			`expected RegistryError; got ${caught === undefined ? "no error" : String(caught)}`,
		);
	}
	expect(caught.path).toContain(pathFragment);
	if (msgFragment) expect(caught.message).toContain(msgFragment);
}

describe("built-in agents and adapter descriptors", () => {
	test("codex is a built-in agent backed by codex-exec", () => {
		const reg = parseRegistry(undefined);
		expect(reg.agents.codex).toBeDefined();
		expect(reg.agents.codex?.adapter).toBe("codex-exec");
		expect(reg.agents.codex?.builtIn).toBe(true);
	});

	test("claude is a built-in agent backed by claude-cli", () => {
		const reg = parseRegistry(undefined);
		expect(reg.agents.claude).toBeDefined();
		expect(reg.agents.claude?.adapter).toBe("claude-cli");
		expect(reg.agents.claude?.builtIn).toBe(true);
	});

	test("getAdapterDescriptor returns capabilities", () => {
		const codexExec = getAdapterDescriptor("codex-exec");
		expect(codexExec).toBeDefined();
		expect(codexExec?.capabilities.enforces_filesystem_read_only).toBe(true);

		// claude-cli enforces read_only via `--permission-mode plan` (a Claude
		// plan-mode permission, not an OS sandbox), so it declares true too.
		const claudeCli = getAdapterDescriptor("claude-cli");
		expect(claudeCli).toBeDefined();
		expect(claudeCli?.capabilities.enforces_filesystem_read_only).toBe(true);
	});

	test("getAdapterDescriptor returns undefined for unknown kinds", () => {
		expect(getAdapterDescriptor("subprocess")).toBeUndefined();
		expect(getAdapterDescriptor("openai-responses")).toBeUndefined();
	});

	test("isBuiltInAgent identifies the built-in pair", () => {
		expect(isBuiltInAgent("codex")).toBe(true);
		expect(isBuiltInAgent("claude")).toBe(true);
		expect(isBuiltInAgent("kimi")).toBe(false);
	});
});

describe("parseRegistry", () => {
	test("undefined raw yields only built-ins", () => {
		const reg = parseRegistry(undefined);
		expect(Object.keys(reg.agents).sort()).toEqual(["claude", "codex"]);
	});

	test("empty object yields only built-ins", () => {
		const reg = parseRegistry({});
		expect(Object.keys(reg.agents).sort()).toEqual(["claude", "codex"]);
	});

	test("empty agents object yields only built-ins", () => {
		const reg = parseRegistry({ agents: {} });
		expect(Object.keys(reg.agents).sort()).toEqual(["claude", "codex"]);
	});

	test("user agent is merged with built-ins", () => {
		const reg = parseRegistry({
			agents: {
				kimi: {
					adapter: "claude-cli",
					model: "kimi-k2.6:cloud",
					passModelOnResume: true,
					env: {
						ANTHROPIC_BASE_URL: "http://localhost:11434",
						ANTHROPIC_AUTH_TOKEN: "ollama",
					},
				},
			},
		});

		expect(Object.keys(reg.agents).sort()).toEqual(["claude", "codex", "kimi"]);
		const kimi = reg.agents.kimi;
		expect(kimi).toBeDefined();
		expect(kimi?.adapter).toBe("claude-cli");
		expect(kimi?.model).toBe("kimi-k2.6:cloud");
		expect(kimi?.passModelOnResume).toBe(true);
		expect(kimi?.env).toEqual({
			ANTHROPIC_BASE_URL: "http://localhost:11434",
			ANTHROPIC_AUTH_TOKEN: "ollama",
		});
		expect(kimi?.builtIn).toBe(false);
	});

	test("passModelOnResume defaults to false when omitted", () => {
		const reg = parseRegistry({
			agents: { fast: { adapter: "codex-exec" } },
		});
		expect(reg.agents.fast?.passModelOnResume).toBe(false);
	});

	test("a user claude-cli agent can opt out of strict MCP", () => {
		const reg = parseRegistry({
			agents: { "needs-mcp": { adapter: "claude-cli", strictMcp: false } },
		});
		expect(reg.agents["needs-mcp"]?.strictMcp).toBe(false);
	});

	test("strictMcp is undefined when omitted (adapter default applies)", () => {
		const reg = parseRegistry({
			agents: { plain: { adapter: "claude-cli" } },
		});
		expect(reg.agents.plain?.strictMcp).toBeUndefined();
	});

	test("a valid positive-integer callTimeoutMs is accepted", () => {
		const reg = parseRegistry({
			agents: { slow: { adapter: "codex-exec", callTimeoutMs: 600000 } },
		});
		expect(reg.agents.slow?.callTimeoutMs).toBe(600000);
	});

	test("callTimeoutMs is undefined when omitted (adapter default applies)", () => {
		const reg = parseRegistry({
			agents: { plain: { adapter: "codex-exec" } },
		});
		expect(reg.agents.plain?.callTimeoutMs).toBeUndefined();
	});

	test("a valid positive-integer noProgressTimeoutMs is accepted", () => {
		const reg = parseRegistry({
			agents: { watched: { adapter: "codex-exec", noProgressTimeoutMs: 120000 } },
		});
		expect(reg.agents.watched?.noProgressTimeoutMs).toBe(120000);
	});

	test("noProgressTimeoutMs is undefined when omitted (watchdog off)", () => {
		const reg = parseRegistry({
			agents: { plain: { adapter: "codex-exec" } },
		});
		expect(reg.agents.plain?.noProgressTimeoutMs).toBeUndefined();
	});
});

describe("parseRegistry: invalid configs", () => {
	test("non-object top-level", () => {
		expectRegistryError([], "<inline>", "must be a JSON object");
	});

	test("unknown top-level field", () => {
		expectRegistryError({ defaultAdvisors: ["codex"] }, "<inline>", "unknown top-level field");
	});

	test("agents not an object", () => {
		expectRegistryError({ agents: ["codex"] }, "agents", "must be a JSON object");
	});

	test("built-in id cannot be redefined", () => {
		expectRegistryError(
			{ agents: { codex: { adapter: "codex-exec" } } },
			"agents.codex",
			"built-in agent id cannot be redefined",
		);
	});

	test("agent id must be kebab-case", () => {
		expectRegistryError(
			{ agents: { Bad_Name: { adapter: "codex-exec" } } },
			"agents.Bad_Name",
			"kebab-case",
		);
	});

	test("missing adapter", () => {
		expectRegistryError(
			{ agents: { x: { model: "gpt-5" } } },
			"agents.x.adapter",
			"must be one of",
		);
	});

	test("unknown adapter kind", () => {
		expectRegistryError(
			{ agents: { x: { adapter: "subprocess" } } },
			"agents.x.adapter",
			"must be one of",
		);
	});

	test("unknown field on agent entry", () => {
		expectRegistryError(
			{ agents: { x: { adapter: "codex-exec", provider: "codex-exec" } } },
			"agents.x",
			'unknown field "provider"',
		);
	});

	test("model must be string", () => {
		expectRegistryError(
			{ agents: { x: { adapter: "codex-exec", model: 5 } } },
			"agents.x.model",
			"non-empty string",
		);
	});

	test("passModelOnResume must be boolean", () => {
		expectRegistryError(
			{ agents: { x: { adapter: "claude-cli", passModelOnResume: "yes" } } },
			"agents.x.passModelOnResume",
			"must be a boolean",
		);
	});

	test("strictMcp must be boolean", () => {
		expectRegistryError(
			{ agents: { x: { adapter: "claude-cli", strictMcp: "no" } } },
			"agents.x.strictMcp",
			"must be a boolean",
		);
	});

	test("callTimeoutMs must be a positive integer (rejects zero/negative)", () => {
		expectRegistryError(
			{ agents: { x: { adapter: "codex-exec", callTimeoutMs: 0 } } },
			"agents.x.callTimeoutMs",
			"must be a positive integer",
		);
	});

	test("callTimeoutMs must be an integer (rejects non-integer)", () => {
		expectRegistryError(
			{ agents: { x: { adapter: "codex-exec", callTimeoutMs: 1.5 } } },
			"agents.x.callTimeoutMs",
			"must be a positive integer",
		);
	});

	test("noProgressTimeoutMs must be a positive integer (rejects zero/negative)", () => {
		expectRegistryError(
			{ agents: { x: { adapter: "codex-exec", noProgressTimeoutMs: 0 } } },
			"agents.x.noProgressTimeoutMs",
			"must be a positive integer",
		);
	});

	test("noProgressTimeoutMs must be an integer (rejects non-integer)", () => {
		expectRegistryError(
			{ agents: { x: { adapter: "codex-exec", noProgressTimeoutMs: 2.5 } } },
			"agents.x.noProgressTimeoutMs",
			"must be a positive integer",
		);
	});

	test("env must be object", () => {
		expectRegistryError(
			{ agents: { x: { adapter: "claude-cli", env: "FOO=bar" } } },
			"agents.x.env",
			"must be a JSON object",
		);
	});

	test("env value must be string", () => {
		expectRegistryError(
			{ agents: { x: { adapter: "claude-cli", env: { FOO: 1 } } } },
			"agents.x.env.FOO",
			"must be a string",
		);
	});
});

describe("loadRegistry", () => {
	let TMPDIR: string;
	let CONFIG: string;

	beforeEach(() => {
		TMPDIR = mkdtempSync(join(tmpdir(), "chit-registry-"));
		CONFIG = join(TMPDIR, "agents.json");
	});

	afterEach(() => {
		rmSync(TMPDIR, { recursive: true, force: true });
	});

	test("returns built-ins only when file does not exist", () => {
		const reg = loadRegistry(join(TMPDIR, "missing.json"));
		expect(Object.keys(reg.agents).sort()).toEqual(["claude", "codex"]);
		expect(reg.configPath).toBeUndefined();
	});

	test("loads user agents from a file and records configPath", () => {
		writeFileSync(
			CONFIG,
			JSON.stringify({
				agents: {
					"kimi-cloud": {
						adapter: "claude-cli",
						model: "kimi-k2.6:cloud",
						passModelOnResume: true,
					},
				},
			}),
		);
		const reg = loadRegistry(CONFIG);
		expect(Object.keys(reg.agents).sort()).toEqual(["claude", "codex", "kimi-cloud"]);
		expect(reg.configPath).toBe(CONFIG);
	});

	test("rejects invalid JSON with the file path in the error", () => {
		writeFileSync(CONFIG, "{ not: json");
		expect(() => loadRegistry(CONFIG)).toThrow(RegistryError);
		try {
			loadRegistry(CONFIG);
		} catch (e) {
			if (e instanceof RegistryError) {
				expect(e.path).toBe(CONFIG);
				expect(e.message).toContain("invalid JSON");
			}
		}
	});

	test("validation errors include the file path", () => {
		writeFileSync(CONFIG, JSON.stringify({ agents: { codex: { adapter: "codex-exec" } } }));
		try {
			loadRegistry(CONFIG);
			throw new Error("expected error");
		} catch (e) {
			if (e instanceof RegistryError) {
				expect(e.path).toContain(CONFIG);
				expect(e.path).toContain("agents.codex");
				expect(e.message).toContain("built-in agent id cannot be redefined");
			} else {
				throw e;
			}
		}
	});
});

describe("loadRegistry: chit default-path resolution", () => {
	let XDG: string;
	let prevXdg: string | undefined;
	const agentsJson = (id: string) =>
		JSON.stringify({ agents: { [id]: { adapter: "codex-exec" } } });

	beforeEach(() => {
		XDG = mkdtempSync(join(tmpdir(), "chit-cfg-"));
		prevXdg = process.env.XDG_CONFIG_HOME;
		process.env.XDG_CONFIG_HOME = XDG;
	});
	afterEach(() => {
		if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
		else process.env.XDG_CONFIG_HOME = prevXdg;
		rmSync(XDG, { recursive: true, force: true });
	});

	test("reads ~/.config/chit/agents.json", () => {
		mkdirSync(join(XDG, "chit"), { recursive: true });
		writeFileSync(join(XDG, "chit", "agents.json"), agentsJson("new-one"));
		expect(loadRegistry().agents["new-one"]).toBeDefined();
	});

	test("falls back to built-ins when ~/.config/chit/agents.json is absent", () => {
		const reg = loadRegistry();
		expect(reg.agents.codex).toBeDefined();
	});

	test("ignores ~/.config/handoff/agents.json (no legacy fallback)", () => {
		mkdirSync(join(XDG, "handoff"), { recursive: true });
		writeFileSync(join(XDG, "handoff", "agents.json"), agentsJson("legacy-only"));
		expect(loadRegistry().agents["legacy-only"]).toBeUndefined();
	});
});
