// `chit doctor` - a preflight check for first-time setup. It answers the
// question a stranger has after `bun install -g @chit-run/cli`: "is my machine
// ready to run a chit, and if not, what do I fix?". It checks what can be
// checked locally and cheaply: Bun, the chit binary on PATH, the agent CLIs
// (codex, claude), the agent registry, the audit directory, whether chit is
// registered as an MCP server, and whether the cwd is a git repo.
//
// It deliberately does NOT verify that codex/claude are AUTHENTICATED: that needs
// a real model call (network + tokens), and there is no documented offline auth
// probe. Doctor reports the CLIs as present/absent and says plainly that auth is
// confirmed on the first real run. Honest about being early beats a green check
// that lies.
//
// Status uses shape, not color (brand): pass (filled), warn (hollow), fail
// (diamond). A failure is a hard blocker (exit 1); a warning is advisory (exit 0).

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ConfigError, type NormalizedConfig, RegistryError } from "@chit-run/core";
import { defaultAuditDir } from "../audit/store.ts";
import { loadConfig } from "../config/load.ts";

export interface DoctorIO {
	out: (s: string) => void;
	err: (s: string) => void;
}

const defaultIO: DoctorIO = {
	out: (s) => process.stdout.write(s),
	err: (s) => process.stderr.write(s),
};

export type CheckStatus = "pass" | "warn" | "fail";

export interface Check {
	name: string;
	status: CheckStatus;
	detail: string;
	hint?: string;
}

// Run a command and report whether it succeeded plus its combined output. A
// missing binary (ENOENT) is a clean { ok: false }, not a throw, so a check can
// treat "absent" and "errored" the same way.
export type Probe = (cmd: string[], cwd?: string) => { ok: boolean; output: string };

// Each probe is hard-bounded by a timeout: doctor exists to UNSTICK a first-time
// user, so it must never itself wedge on a hung agent CLI. A timed-out spawn
// returns a null exitCode (Bun kills it), so it reads as { ok: false }, the same
// as a missing binary.
const PROBE_TIMEOUT_MS = 5000;

export function makeDefaultProbe(timeoutMs: number): Probe {
	return (cmd, cwd) => {
		try {
			const r = Bun.spawnSync(cmd, {
				cwd,
				stdout: "pipe",
				stderr: "pipe",
				stdin: "ignore",
				timeout: timeoutMs,
			});
			const output = `${r.stdout?.toString() ?? ""}${r.stderr?.toString() ?? ""}`.trim();
			return { ok: r.exitCode === 0, output };
		} catch {
			return { ok: false, output: "" };
		}
	};
}

const defaultProbe: Probe = makeDefaultProbe(PROBE_TIMEOUT_MS);

export interface DoctorDeps {
	probe: Probe;
	cwd: string;
	auditDir: string;
	// Load the full config (agents + roles + recipes). Returns NormalizedConfig so
	// the check can report the resolved config path (registry.configPath is not set
	// by the config parser; the path lives on the config).
	loadReg: () => NormalizedConfig;
	bunVersion: string | undefined;
	// Read the Codex config.toml as text, or undefined when the file is absent.
	// Injected so the Codex tool-timeout check is testable without touching $HOME.
	readCodexConfig: () => string | undefined;
}

// Codex's host-side deadline for a single MCP tool call. Below this, a long
// chit_wait can be cut by Codex before chit's own timeout_ms returns.
const CODEX_MIN_TOOL_TIMEOUT_SEC = 900;
const CODEX_RECOMMENDED_TOOL_TIMEOUT_SEC = 1800;

function defaultReadCodexConfig(): string | undefined {
	try {
		return readFileSync(join(homedir(), ".codex", "config.toml"), "utf8");
	} catch {
		return undefined;
	}
}

function defaultDeps(): DoctorDeps {
	return {
		probe: defaultProbe,
		cwd: process.cwd(),
		auditDir: defaultAuditDir(),
		loadReg: () => loadConfig(),
		bunVersion: process.versions.bun,
		readCodexConfig: defaultReadCodexConfig,
	};
}

function checkBun(deps: DoctorDeps): Check {
	if (deps.bunVersion) {
		return { name: "bun", status: "pass", detail: `Bun ${deps.bunVersion}` };
	}
	return {
		name: "bun",
		status: "fail",
		detail: "not running under Bun",
		hint: "chit is Bun-native; install Bun from https://bun.sh and run chit under bun",
	};
}

// `chit` resolvable on PATH matters because the recommended MCP registration is
// `claude mcp add chit -- chit mcp`: if `chit` is not on PATH (e.g. run via bunx),
// that registration would not resolve.
function checkChitOnPath(deps: DoctorDeps): Check {
	if (deps.probe(["which", "chit"]).ok) {
		return { name: "chit", status: "pass", detail: "on PATH" };
	}
	return {
		name: "chit",
		status: "warn",
		detail: "not on PATH (running locally or via bunx)",
		hint: "install globally so `chit mcp` resolves: bun install -g @chit-run/cli",
	};
}

function checkGitRepo(deps: DoctorDeps): Check {
	if (deps.probe(["git", "rev-parse", "--is-inside-work-tree"], deps.cwd).ok) {
		return { name: "git repo", status: "pass", detail: `cwd is a git repo (${deps.cwd})` };
	}
	return {
		name: "git repo",
		status: "warn",
		detail: `cwd is not a git repo (${deps.cwd})`,
		hint: "converge and worktree-based flows expect a git repo; cd into one or git init",
	};
}

function checkAuditDir(deps: DoctorDeps): Check {
	try {
		mkdirSync(deps.auditDir, { recursive: true });
		const probeFile = join(deps.auditDir, `.doctor-${randomUUID()}`);
		writeFileSync(probeFile, "ok");
		rmSync(probeFile);
		return { name: "audit dir", status: "pass", detail: `writable (${deps.auditDir})` };
	} catch (e) {
		return {
			name: "audit dir",
			status: "fail",
			detail: `not writable (${deps.auditDir}): ${(e as Error).message}`,
			hint: "audited runs need this dir; fix its permissions or set XDG_STATE_HOME",
		};
	}
}

function checkRegistry(deps: DoctorDeps): Check {
	let config: NormalizedConfig;
	try {
		config = deps.loadReg();
	} catch (e) {
		// Both are config-file problems: ConfigError for a malformed top level or
		// roles section, RegistryError for a bad agents section (parseConfig delegates
		// agents to parseRegistry, which throws its own type). Catch both, or a bad
		// agents entry escapes and crashes doctor instead of reporting a failed row.
		if (e instanceof ConfigError || e instanceof RegistryError) {
			return {
				name: "agents",
				status: "fail",
				detail: `invalid config: ${e.message}`,
				hint: "fix or remove ~/.config/chit/config.json (or the repo's chit.config.json)",
			};
		}
		throw e;
	}
	// Each non-built-in agent is tagged with the layer that defined it (global or
	// repo), so the operator can answer "where did this agent come from" here.
	const ids = Object.keys(config.registry.agents)
		.sort()
		.map((id) => {
			const origin = config.provenance?.agents[id];
			return origin && origin.source !== "builtin" ? `${id} (${origin.source})` : id;
		})
		.join(", ");
	let source = config.configPath
		? `from ${config.configPath}`
		: "built-in defaults (no config.json)";
	if (config.repoConfigPath) source += ` + repo ${config.repoConfigPath}`;
	return { name: "agents", status: "pass", detail: `${ids || "none"} (${source})` };
}

// Recipes row: shown only when the config defines at least one recipe (most
// setups have none, and a permanent "none" row is noise - same treatment as the
// codex tool timeout check). A config that fails to load is already reported as
// a failure by the agents row, so this check stays silent instead of duplicating.
function checkRecipes(deps: DoctorDeps): Check | null {
	let config: NormalizedConfig;
	try {
		config = deps.loadReg();
	} catch {
		return null;
	}
	const ids = Object.keys(config.recipes ?? {}).sort();
	if (ids.length === 0) return null;
	const detail = ids
		.map((id) => {
			const origin = config.provenance?.recipes[id];
			return origin ? `${id} (${origin.source})` : id;
		})
		.join(", ");
	return { name: "recipes", status: "pass", detail };
}

// A given agent CLI: present on PATH (we can check) vs authenticated (we cannot,
// cheaply). Absence is a warning, not a failure: a user may only use one agent.
function checkAgentCli(deps: DoctorDeps, bin: string): Check {
	if (deps.probe([bin, "--version"]).ok) {
		return { name: bin, status: "pass", detail: "available (auth confirmed on first run)" };
	}
	return {
		name: bin,
		status: "warn",
		detail: `not found on PATH`,
		hint: `install ${bin} and authenticate it; chit calls it as an agent`,
	};
}

// Best-effort MCP-registration check via the claude CLI. Skipped (not failed)
// when claude is absent, since the check itself depends on it.
function checkMcpRegistration(deps: DoctorDeps): Check {
	if (!deps.probe(["claude", "--version"]).ok) {
		return {
			name: "mcp register",
			status: "warn",
			detail: "skipped (claude CLI not found)",
			hint: "with claude installed: claude mcp add chit --scope local -- chit mcp",
		};
	}
	if (deps.probe(["claude", "mcp", "get", "chit"]).ok) {
		return { name: "mcp register", status: "pass", detail: "chit registered as an MCP server" };
	}
	return {
		name: "mcp register",
		status: "warn",
		detail: "chit not registered as an MCP server",
		hint: "register it: claude mcp add chit --scope local -- chit mcp",
	};
}

// Pull the [mcp_servers.chit] table's tool_timeout_sec out of a Codex config.toml.
// Deliberately a small, targeted reader rather than a full TOML parser: doctor only
// needs to know whether chit is registered with Codex and what its tool timeout is.
// Tracks the active table by header line and reads the first tool_timeout_sec under
// [mcp_servers.chit]. `configured` is true once that header appears.
function parseCodexChitTimeout(toml: string): { configured: boolean; timeoutSec?: number } {
	let inSection = false;
	let configured = false;
	let timeoutSec: number | undefined;
	for (const raw of toml.split(/\r?\n/)) {
		const line = raw.replace(/#.*$/, "").trim();
		if (line === "") continue;
		const header = line.match(/^\[(.+)\]$/);
		if (header) {
			inSection = header[1].trim() === "mcp_servers.chit";
			if (inSection) configured = true;
			continue;
		}
		if (inSection && timeoutSec === undefined) {
			const m = line.match(/^tool_timeout_sec\s*=\s*(\d+)/);
			if (m) timeoutSec = Number(m[1]);
		}
	}
	return { configured, timeoutSec };
}

// Codex applies its own per-tool call deadline on top of chit's long MCP calls.
// A long chit_wait or inline chit_orchestrate planner run can be cut by the host
// before chit returns. This is advisory only (warn, never fail): we skip the row
// entirely when Codex has no config or chit is not registered there, since neither
// case is the user's problem to fix.
function checkCodexToolTimeout(deps: DoctorDeps): Check | null {
	const toml = deps.readCodexConfig();
	if (toml === undefined) return null;
	const { configured, timeoutSec } = parseCodexChitTimeout(toml);
	if (!configured) return null;
	if (timeoutSec === undefined) {
		return {
			name: "codex tool timeout",
			status: "warn",
			detail: "chit is configured for Codex but tool_timeout_sec is not set",
			hint: `long chit_wait or chit_orchestrate calls may be interrupted by Codex; set tool_timeout_sec = ${CODEX_RECOMMENDED_TOOL_TIMEOUT_SEC} under [mcp_servers.chit] and reconnect Codex`,
		};
	}
	if (timeoutSec < CODEX_MIN_TOOL_TIMEOUT_SEC) {
		return {
			name: "codex tool timeout",
			status: "warn",
			detail: `chit tool_timeout_sec is ${timeoutSec}s, below ${CODEX_MIN_TOOL_TIMEOUT_SEC}s`,
			hint: `long chit_wait or chit_orchestrate calls may be interrupted by Codex; raise tool_timeout_sec to ${CODEX_RECOMMENDED_TOOL_TIMEOUT_SEC} under [mcp_servers.chit] and reconnect Codex`,
		};
	}
	return {
		name: "codex tool timeout",
		status: "pass",
		detail: `chit tool_timeout_sec is ${timeoutSec}s`,
	};
}

export function runChecks(deps: DoctorDeps): Check[] {
	const checks: Check[] = [
		checkBun(deps),
		checkChitOnPath(deps),
		checkAgentCli(deps, "codex"),
		checkAgentCli(deps, "claude"),
		checkRegistry(deps),
		checkMcpRegistration(deps),
		checkAuditDir(deps),
		checkGitRepo(deps),
	];
	const recipes = checkRecipes(deps);
	if (recipes) checks.push(recipes);
	const codex = checkCodexToolTimeout(deps);
	if (codex) checks.push(codex);
	return checks;
}

const SHAPE: Record<CheckStatus, string> = { pass: "●", warn: "○", fail: "◆" };

function render(checks: Check[], io: DoctorIO): void {
	io.out("chit doctor\n\n");
	const width = Math.max(...checks.map((c) => c.name.length));
	for (const c of checks) {
		io.out(`${SHAPE[c.status]} ${c.name.padEnd(width)}  ${c.detail}\n`);
		if (c.hint && c.status !== "pass") io.out(`${" ".repeat(width + 4)}↳ ${c.hint}\n`);
	}
	const fails = checks.filter((c) => c.status === "fail").length;
	const warns = checks.filter((c) => c.status === "warn").length;
	io.out(
		`\n${fails} failure${fails === 1 ? "" : "s"}, ${warns} warning${warns === 1 ? "" : "s"}. Agent authentication is verified on the first real run.\n`,
	);
}

const DOCTOR_HELP = `chit doctor

Preflight check for first-time setup. Runs no agents and changes nothing (it only
writes and removes a probe file in the audit dir to confirm it is writable).

Checks: Bun, the chit binary on PATH, the codex and claude CLIs, the agent
registry, MCP registration, the audit dir, whether the cwd is a git repo, and the
Codex per-tool call timeout for long chit_wait / chit_orchestrate calls when chit
is registered with Codex. Agent authentication is not checked here; it is
confirmed on the first real run.
`;

export function runDoctor(
	argv: string[],
	io: DoctorIO = defaultIO,
	deps: DoctorDeps = defaultDeps(),
): number {
	// doctor takes no arguments. Handle help and reject unknown args BEFORE running
	// any probe or touching the audit dir, since it is dispatched ahead of the
	// shared --help handling.
	if (argv[0] === "-h" || argv[0] === "--help") {
		io.out(DOCTOR_HELP);
		return 0;
	}
	if (argv.length > 0) {
		io.err(`chit doctor: unexpected argument ${JSON.stringify(argv[0])}\n\n${DOCTOR_HELP}`);
		return 2;
	}
	const checks = runChecks(deps);
	render(checks, io);
	return checks.some((c) => c.status === "fail") ? 1 : 0;
}
