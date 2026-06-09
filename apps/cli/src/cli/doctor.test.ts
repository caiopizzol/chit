import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, type NormalizedConfig, RegistryError } from "@chit-run/core";
import {
	type Check,
	type DoctorDeps,
	makeDefaultProbe,
	type Probe,
	runChecks,
	runDoctor,
} from "./doctor.ts";

let auditDir: string;

beforeEach(() => {
	auditDir = mkdtempSync(join(tmpdir(), "chit-doctor-audit-"));
});
afterEach(() => {
	rmSync(auditDir, { recursive: true, force: true });
});

// A probe that succeeds for the given command prefixes (joined by space), fails
// otherwise. Lets each test say which binaries/commands are "present".
function probeWith(okPrefixes: string[]): Probe {
	return (cmd) => ({ ok: okPrefixes.some((p) => cmd.join(" ").startsWith(p)), output: "" });
}

const CONFIG = {
	registry: { agents: { claude: {}, codex: {} } },
	roles: {},
} as unknown as NormalizedConfig;

function deps(over: Partial<DoctorDeps> = {}): DoctorDeps {
	return {
		probe: probeWith([
			"which chit",
			"git rev-parse",
			"codex --version",
			"claude --version",
			"claude mcp get chit",
		]),
		cwd: "/tmp/work",
		auditDir,
		loadReg: () => CONFIG,
		bunVersion: "1.3.12",
		readCodexConfig: () => undefined,
		...over,
	};
}

function byName(checks: Check[], name: string): Check {
	const c = checks.find((x) => x.name === name);
	if (!c) throw new Error(`no check named ${name}`);
	return c;
}

describe("runChecks", () => {
	test("all green when every probe passes and the audit dir is writable", () => {
		const checks = runChecks(deps());
		expect(checks.every((c) => c.status === "pass")).toBe(true);
		expect(byName(checks, "agents").detail).toContain("claude, codex");
		expect(byName(checks, "agents").detail).toContain("built-in defaults");
	});

	test("agents detail tags layered agents with their origin and names the repo config", () => {
		const layered = {
			registry: { agents: { claude: {}, codex: {}, "codex-deep": {} } },
			roles: {},
			configPath: "/home/u/.config/chit/config.json",
			repoConfigPath: "/repo/chit.config.json",
			provenance: {
				agents: {
					claude: { source: "builtin" },
					codex: { source: "builtin" },
					"codex-deep": { source: "repo", path: "/repo/chit.config.json" },
				},
				roles: {},
			},
		} as unknown as NormalizedConfig;
		const detail = byName(runChecks(deps({ loadReg: () => layered })), "agents").detail;
		expect(detail).toContain("codex-deep (repo)");
		expect(detail).toContain("from /home/u/.config/chit/config.json");
		expect(detail).toContain("+ repo /repo/chit.config.json");
	});

	test("bun missing is a hard failure", () => {
		expect(byName(runChecks(deps({ bunVersion: undefined })), "bun").status).toBe("fail");
	});

	test("chit not on PATH is a warning", () => {
		const checks = runChecks(deps({ probe: probeWith(["git rev-parse", "codex", "claude"]) }));
		expect(byName(checks, "chit").status).toBe("warn");
	});

	test("a missing agent CLI is a warning, not a failure", () => {
		// codex absent: only claude/which/git/mcp succeed.
		const checks = runChecks(deps({ probe: probeWith(["which chit", "git rev-parse", "claude"]) }));
		expect(byName(checks, "codex").status).toBe("warn");
		expect(byName(checks, "claude").status).toBe("pass");
	});

	test("cwd not a git repo is a warning", () => {
		const checks = runChecks(
			deps({ probe: probeWith(["which chit", "codex", "claude"]) }), // git rev-parse fails
		);
		expect(byName(checks, "git repo").status).toBe("warn");
	});

	test("invalid config is a hard failure", () => {
		const checks = runChecks(
			deps({
				loadReg: () => {
					throw new ConfigError("/x/config.json", "invalid JSON");
				},
			}),
		);
		expect(byName(checks, "agents").status).toBe("fail");
		expect(byName(checks, "agents").detail).toContain("invalid config");
	});

	test("a bad agents section (RegistryError) is a hard failure, not a crash", () => {
		// parseConfig delegates the agents section to parseRegistry, which throws
		// RegistryError (a sibling of ConfigError, not a subclass). checkRegistry must
		// catch it too, or a bad agents entry escapes runChecks and crashes doctor.
		const checks = runChecks(
			deps({
				loadReg: () => {
					throw new RegistryError(
						"/x/config.json: agents.codex",
						"built-in agent id cannot be redefined by user config",
					);
				},
			}),
		);
		expect(byName(checks, "agents").status).toBe("fail");
		expect(byName(checks, "agents").detail).toContain("invalid config");
	});

	test("audit dir not writable is a hard failure", () => {
		// Point the audit dir under a regular file so mkdir fails (ENOTDIR).
		const file = join(auditDir, "not-a-dir");
		writeFileSync(file, "x");
		const checks = runChecks(deps({ auditDir: join(file, "audit") }));
		expect(byName(checks, "audit dir").status).toBe("fail");
	});

	test("chit not registered as MCP is a warning (claude present, get fails)", () => {
		const checks = runChecks(
			deps({ probe: probeWith(["which chit", "git rev-parse", "codex", "claude --version"]) }),
		);
		expect(byName(checks, "mcp register").status).toBe("warn");
		expect(byName(checks, "mcp register").detail).toContain("not registered");
	});

	test("mcp check is skipped (warn) when claude is absent", () => {
		const checks = runChecks(deps({ probe: probeWith(["which chit", "git rev-parse", "codex"]) }));
		expect(byName(checks, "mcp register").detail).toContain("skipped");
	});
});

describe("codex tool timeout check", () => {
	const CHIT_SECTION = `[mcp_servers.chit]
command = "/Users/me/.bun/bin/chit"
args = ["mcp"]
`;

	function find(checks: Check[]): Check | undefined {
		return checks.find((c) => c.name === "codex tool timeout");
	}

	test("no row when the Codex config file is absent", () => {
		const checks = runChecks(deps({ readCodexConfig: () => undefined }));
		expect(find(checks)).toBeUndefined();
	});

	test("no row when chit is not configured for Codex", () => {
		const toml = `[mcp_servers.other]
command = "other"
tool_timeout_sec = 30
`;
		expect(find(runChecks(deps({ readCodexConfig: () => toml })))).toBeUndefined();
	});

	test("warns when chit is configured but tool_timeout_sec is missing", () => {
		const c = find(runChecks(deps({ readCodexConfig: () => CHIT_SECTION })));
		expect(c?.status).toBe("warn");
		expect(c?.detail).toContain("not set");
		expect(c?.hint).toContain("1800");
	});

	test("warns when tool_timeout_sec is below the floor", () => {
		const toml = `${CHIT_SECTION}tool_timeout_sec = 120
`;
		const c = find(runChecks(deps({ readCodexConfig: () => toml })));
		expect(c?.status).toBe("warn");
		expect(c?.detail).toContain("120s");
		expect(c?.detail).toContain("below 900s");
	});

	test("passes when tool_timeout_sec is sufficient", () => {
		const toml = `${CHIT_SECTION}tool_timeout_sec = 1800
`;
		const c = find(runChecks(deps({ readCodexConfig: () => toml })));
		expect(c?.status).toBe("pass");
		expect(c?.detail).toContain("1800s");
	});

	test("a comment after the value does not break parsing", () => {
		const toml = `${CHIT_SECTION}tool_timeout_sec = 1800  # raised for long chit_wait
`;
		expect(find(runChecks(deps({ readCodexConfig: () => toml })))?.status).toBe("pass");
	});
});

describe("runDoctor exit code", () => {
	function capture() {
		const lines: string[] = [];
		const io = { out: (s: string) => lines.push(s), err: (s: string) => lines.push(s) };
		return { io, text: () => lines.join("") };
	}

	test("exit 0 when only passes and warnings", () => {
		const { io } = capture();
		// codex absent -> a warning, not a failure.
		expect(
			runDoctor([], io, deps({ probe: probeWith(["which chit", "git rev-parse", "claude"]) })),
		).toBe(0);
	});

	test("exit 1 when any check fails", () => {
		const { io } = capture();
		expect(runDoctor([], io, deps({ bunVersion: undefined }))).toBe(1);
	});

	test("renders shapes and a summary line", () => {
		const { io, text } = capture();
		runDoctor([], io, deps());
		const out = text();
		expect(out).toContain("chit doctor");
		expect(out).toContain("●");
		expect(out).toMatch(/0 failures, 0 warnings/);
		expect(out).toContain("authentication is verified on the first real run");
	});

	test("--help prints help and runs NO checks", () => {
		const { io, text } = capture();
		// A probe that throws if called: --help must short-circuit before any probe.
		const throwingProbe: Probe = () => {
			throw new Error("probe must not run for --help");
		};
		const code = runDoctor(["--help"], io, deps({ probe: throwingProbe }));
		expect(code).toBe(0);
		expect(text()).toContain("Preflight check");
	});

	test("rejects an unexpected argument with exit 2", () => {
		const { io } = capture();
		expect(runDoctor(["--bogus"], io, deps())).toBe(2);
	});
});

describe("makeDefaultProbe", () => {
	test("a command that exceeds the timeout is reported not-ok (doctor cannot hang)", () => {
		const r = makeDefaultProbe(150)(["sleep", "3"]);
		expect(r.ok).toBe(false);
	});

	test("a fast successful command is ok", () => {
		expect(makeDefaultProbe(5000)(["git", "--version"]).ok).toBe(true);
	});
});
