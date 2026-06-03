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
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigError, type NormalizedConfig } from "@chit-run/core";
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
	// Load the full config (agents + roles). Returns NormalizedConfig so the check
	// can report the resolved config path (registry.configPath is not set by the
	// config parser; the path lives on the config).
	loadReg: () => NormalizedConfig;
	bunVersion: string | undefined;
}

function defaultDeps(): DoctorDeps {
	return {
		probe: defaultProbe,
		cwd: process.cwd(),
		auditDir: defaultAuditDir(),
		loadReg: () => loadConfig(),
		bunVersion: process.versions.bun,
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
		if (e instanceof ConfigError) {
			return {
				name: "agents",
				status: "fail",
				detail: `invalid config: ${e.message}`,
				hint: "fix or remove ~/.config/chit/config.json",
			};
		}
		throw e;
	}
	const ids = Object.keys(config.registry.agents).sort().join(", ");
	const source = config.configPath
		? `from ${config.configPath}`
		: "built-in defaults (no config.json)";
	return { name: "agents", status: "pass", detail: `${ids || "none"} (${source})` };
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

export function runChecks(deps: DoctorDeps): Check[] {
	return [
		checkBun(deps),
		checkChitOnPath(deps),
		checkAgentCli(deps, "codex"),
		checkAgentCli(deps, "claude"),
		checkRegistry(deps),
		checkMcpRegistration(deps),
		checkAuditDir(deps),
		checkGitRepo(deps),
	];
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
registry, MCP registration, the audit dir, and whether the cwd is a git repo.
Agent authentication is not checked here; it is confirmed on the first real run.
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
