import { type Dirent, existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { NormalizedConfig } from "@chit-run/core";
import {
	buildGraphModel,
	buildLoopReceipt,
	collectInvocationWarnings,
	findEnforcementGaps,
	findMissingCapabilities,
	findUnknownAgents,
	type LoopHeaderRecord,
	type LoopIterationRecord,
	type LoopRecord,
	parseLoopLog,
	parseManifest,
	type ResolvedManifest,
	renderShow,
	resolveManifest,
	resolveParticipantSnapshots,
	type ShowFormat,
	validateLoopLog,
} from "@chit-run/core";
import { AdapterError, buildAdapter } from "../adapters/factory.ts";
import { AuditRecorder } from "../audit/recorder.ts";
import { AuditStore } from "../audit/store.ts";
import { wrapAdaptersWithAudit } from "../audit/wrap.ts";
import { realGit, repoToplevel, resolveBaseSha } from "../batches/worktree.ts";
import { loadConfig } from "../config/load.ts";
import { requestJobCancel } from "../jobs/cancel.ts";
import { isStale, jobTiming } from "../jobs/health.ts";
import { JobStore } from "../jobs/store.ts";
import type { JobRecord, LoopJobRecord } from "../jobs/types.ts";
import { runJobWorker } from "../jobs/worker.ts";
import { loopLogDir, repoKey } from "../loops/location.ts";
import { readLoop } from "../loops/log-store.ts";
import {
	digestManifestText,
	normalizeManifestReference,
	readBoundManifestText,
} from "../manifest/binding.ts";
import { executeManifest } from "../runtime/execute.ts";
import { type LiveEventSummary, sanitizeLiveEvents } from "../runtime/live-events.ts";
import { RuntimeError } from "../runtime/render.ts";
import type { AdapterMap, RunResult, TraceEvent } from "../runtime/types.ts";
import { wrapAdaptersWithSessions } from "../sessions/coordinator.ts";
import { defaultSessionDir, FileSessionStore } from "../sessions/store.ts";
import { installClaudeSkill, SurfaceInstallError } from "../surfaces/claude-skill.ts";
import {
	defaultSkillsDir,
	LifecycleError,
	listInstalled,
	uninstall,
} from "../surfaces/lifecycle.ts";
import {
	compactTask,
	type ForegroundActivitySummary,
	ForegroundRegistry,
	type ForegroundSnapshot,
	summarizeForegroundForStatus,
} from "../surfaces/mcp/foreground-registry.ts";
import { startMcpServer } from "../surfaces/mcp/server.ts";
import { runAudit } from "./audit.ts";
import { runConverge } from "./converge.ts";
import { runDoctor } from "./doctor.ts";
import { runLoopLog } from "./loop-log.ts";

const BASE_CLI_CAPABILITIES: ReadonlySet<string> = new Set(["can_show_markdown"]);

function cliCapabilities(scope: string | undefined): Set<string> {
	const caps = new Set(BASE_CLI_CAPABILITIES);
	if (scope !== undefined) caps.add("can_provide_stable_scope");
	return caps;
}

interface ParsedArgs {
	command: "run" | "install" | "show" | "list" | "uninstall" | "studio" | "mcp" | "help";
	manifestPath?: string;
	// `run`-specific fields.
	inputs: Record<string, string>;
	// If set, runMain reads all of stdin (until EOF) and assigns it as the
	// value for this input. Used by the claude-skill surface to pass user
	// arguments through a single-quoted heredoc, bypassing shell interpolation.
	inputStdinKey?: string;
	invocationCwd?: string;
	scope?: string;
	// `install`-specific fields.
	installAs?: string;
	outputDir?: string;
	runtimePath?: string;
	overrideName?: string;
	force: boolean;
	// `show`-specific fields.
	showSurface?: string;
	showFormat?: ShowFormat;
	// `list` / `uninstall`-specific fields.
	uninstallName?: string;
	listJson: boolean;
	// Shared.
	allowUnenforcedPermissions: boolean;
	// `run`: render a step transcript to stderr. `install`: bake --trace into
	// the generated skill so it shows its work.
	trace: boolean;
	// `run`: persist a full audit run (prompts/outputs/usage as blobs) to the
	// audit store. Opt-in: prompt/output blobs can contain secrets, so plain
	// `chit run` does NOT audit unless --audit is passed.
	audit: boolean;
}

function emptyArgs(command: ParsedArgs["command"]): ParsedArgs {
	return {
		command,
		inputs: {},
		allowUnenforcedPermissions: false,
		force: false,
		listJson: false,
		trace: false,
		audit: false,
	};
}

export function parseArgs(argv: string[]): ParsedArgs {
	if (argv.length === 0 || argv[0] === "-h" || argv[0] === "--help") {
		return emptyArgs("help");
	}
	// `-h`/`--help` after a subcommand yields top-level help, so `chit run --help`
	// prints usage instead of treating "--help" as a manifest path. Per-subcommand
	// help text is future work.
	if (argv.includes("-h") || argv.includes("--help")) {
		return emptyArgs("help");
	}
	if (argv[0] === "run") return parseRunArgs(argv);
	if (argv[0] === "install") return parseInstallArgs(argv);
	if (argv[0] === "show") return parseShowArgs(argv);
	if (argv[0] === "list") return parseListArgs(argv);
	if (argv[0] === "uninstall") return parseUninstallArgs(argv);
	if (argv[0] === "studio") return parseStudioArgs(argv);
	if (argv[0] === "mcp") {
		// `chit mcp` takes no arguments: it launches the stdio MCP server.
		if (argv.length > 1) throw new Error(`mcp: unexpected argument "${argv[1]}"`);
		return emptyArgs("mcp");
	}
	throw new Error(`unknown command: ${argv[0]}`);
}

function parseStudioArgs(argv: string[]): ParsedArgs {
	// `chit studio` takes no manifest path: Studio is a live monitor, not a
	// manifest editor. Rejecting extra arguments is safer than ignoring a stale
	// `chit studio <path>` invocation and implying the file was opened.
	const out: ParsedArgs = emptyArgs("studio");
	for (let i = 1; i < argv.length; i++) {
		const a = argv[i];
		if (a === undefined) continue;
		if (a === "-h" || a === "--help") {
			return emptyArgs("help");
		}
		if (a.startsWith("-")) {
			throw new Error(`unknown flag: ${a}`);
		}
		throw new Error(`studio: unexpected argument "${a}"`);
	}
	return out;
}

function parseListArgs(argv: string[]): ParsedArgs {
	const out: ParsedArgs = emptyArgs("list");
	for (let i = 1; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--to") {
			const next = argv[++i];
			if (!next) throw new Error("--to requires a directory");
			out.outputDir = next;
		} else if (a === "--json") {
			out.listJson = true;
		} else {
			throw new Error(`unknown flag: ${a}`);
		}
	}
	return out;
}

function parseUninstallArgs(argv: string[]): ParsedArgs {
	if (argv.length < 2 || !argv[1]) {
		throw new Error("uninstall requires an install name");
	}
	const out: ParsedArgs = { ...emptyArgs("uninstall"), uninstallName: argv[1] };
	for (let i = 2; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--to") {
			const next = argv[++i];
			if (!next) throw new Error("--to requires a directory");
			out.outputDir = next;
		} else {
			throw new Error(`unknown flag: ${a}`);
		}
	}
	return out;
}

const SHOW_FORMATS: ReadonlySet<ShowFormat> = new Set(["json", "ascii", "mermaid", "html"]);

function parseShowArgs(argv: string[]): ParsedArgs {
	if (argv.length < 2 || !argv[1]) {
		throw new Error("show requires a manifest path");
	}
	const out: ParsedArgs = { ...emptyArgs("show"), manifestPath: argv[1] };
	for (let i = 2; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--surface") {
			const next = argv[++i];
			if (!next) throw new Error("--surface requires a kind");
			out.showSurface = next;
		} else if (a === "--format") {
			const next = argv[++i];
			if (!next) throw new Error("--format requires a value");
			if (!SHOW_FORMATS.has(next as ShowFormat)) {
				throw new Error(`--format must be one of: ${[...SHOW_FORMATS].join(", ")} (got: ${next})`);
			}
			out.showFormat = next as ShowFormat;
		} else {
			throw new Error(`unknown flag: ${a}`);
		}
	}
	return out;
}

function parseRunArgs(argv: string[]): ParsedArgs {
	if (argv.length < 2 || !argv[1]) {
		throw new Error("run requires a manifest path");
	}
	const out: ParsedArgs = { ...emptyArgs("run"), manifestPath: argv[1] };
	for (let i = 2; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--input") {
			const next = argv[++i];
			if (!next) throw new Error("--input requires key=value");
			const eq = next.indexOf("=");
			if (eq <= 0) throw new Error(`--input value must be key=value (got: ${next})`);
			out.inputs[next.slice(0, eq)] = next.slice(eq + 1);
		} else if (a === "--invocation-cwd") {
			const next = argv[++i];
			if (!next) throw new Error("--invocation-cwd requires a path");
			out.invocationCwd = next;
		} else if (a === "--scope") {
			const next = argv[++i];
			if (!next) throw new Error("--scope requires an identifier");
			out.scope = next;
		} else if (a === "--allow-unenforced-permissions") {
			out.allowUnenforcedPermissions = true;
		} else if (a === "--trace") {
			out.trace = true;
		} else if (a === "--audit") {
			out.audit = true;
		} else if (a === "--input-stdin") {
			const next = argv[++i];
			if (!next) throw new Error("--input-stdin requires an input name");
			out.inputStdinKey = next;
		} else {
			throw new Error(`unknown flag: ${a}`);
		}
	}
	return out;
}

function parseInstallArgs(argv: string[]): ParsedArgs {
	if (argv.length < 2 || !argv[1]) {
		throw new Error("install requires a manifest path");
	}
	const out: ParsedArgs = { ...emptyArgs("install"), manifestPath: argv[1] };
	for (let i = 2; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--as") {
			const next = argv[++i];
			if (!next) throw new Error("--as requires a surface kind");
			out.installAs = next;
		} else if (a === "--to") {
			const next = argv[++i];
			if (!next) throw new Error("--to requires a directory");
			out.outputDir = next;
		} else if (a === "--runtime-path") {
			const next = argv[++i];
			if (!next) throw new Error("--runtime-path requires a path");
			out.runtimePath = next;
		} else if (a === "--name") {
			const next = argv[++i];
			if (!next) throw new Error("--name requires an identifier");
			out.overrideName = next;
		} else if (a === "--force") {
			out.force = true;
		} else if (a === "--allow-unenforced-permissions") {
			out.allowUnenforcedPermissions = true;
		} else if (a === "--trace") {
			out.trace = true;
		} else {
			throw new Error(`unknown flag: ${a}`);
		}
	}
	return out;
}

const HELP = `Usage:
  chit run <manifest.json> [options]
  chit install <manifest.json> --as <surface> [options]
  chit show <manifest.json> [--surface <kind>] [--format <fmt>]
  chit list [--to <dir>] [--json]
  chit uninstall <name> [--to <dir>]
  chit studio
  chit mcp                                         (run the stdio MCP server)
  chit doctor                                      (preflight: check setup)
  chit loop-log <start|append|stop|show> [flags]   (chit loop-log --help)
  chit converge --task <text> --scope <id> [options]   (chit converge --help)
  chit audit <list|show|stats> [options]   (chit audit --help)
  chit -h | --help

run options:
  --input key=value             Set a manifest input. Repeat for multiple.
  --input-stdin <key>           Read all of stdin as the value for <key>. Avoids
                                shell interpolation of user text. Conflicts with
                                --input <key>=...
  --invocation-cwd <path>       Working directory passed to adapters. Defaults to cwd.
  --scope <id>                  Enable per_scope session persistence keyed by this id.
  --allow-unenforced-permissions  Run anyway when an adapter can't enforce a declared
                                permission. Both built-in adapters enforce filesystem
                                read_only today, so this is reserved for a future adapter
                                that cannot. Emits a warning every run; use deliberately.
  --trace                       Render a step transcript to stderr (id, participant,
                                agent, session policy, elapsed, status, prompt/output
                                previews). Streams live in a terminal. Off by default.
  --audit                       Persist a full audit run (prompts, outputs, token
                                usage as blobs) under the local state dir. Off by
                                default: blobs can contain secrets. Prints the run id.

show options:
  --surface <kind>              Validate against a surface (claude-skill | cli). Without
                                this, the graph renders without validation block.
  --format <fmt>                Output format: json, ascii (default), mermaid, html.

list options:
  --to <dir>                    Parent directory to scan. Default: ~/.claude/skills.
  --json                        Emit machine-readable JSON instead of a text table.

uninstall options:
  --to <dir>                    Parent directory holding the install. Default:
                                ~/.claude/skills. Refuses to remove a directory that
                                does not contain a valid .chit-install.json marker.

install options:
  --as <surface>                Required. Surface to install for. Today: claude-skill.
  --to <dir>                    Parent directory for the skill folder. Default:
                                ~/.claude/skills
  --runtime-path <path>         Absolute path to the chit CLI package root
                                (the directory containing src/cli/run.ts, i.e.,
                                apps/cli/ in this repo's monorepo layout). The
                                generated SKILL.md runs <runtime-path>/src/cli/run.ts
                                in its bash block. Default: auto-detected from
                                this CLI's location. Passing the repo root here
                                will generate a broken skill. NOTE: the claude-skill
                                surface needs a SOURCE checkout: the generated skill
                                runs the CLI source, not the installed binary, so
                                point --runtime-path at a cloned apps/cli, not an
                                npm-installed @chit-run/cli (which ships only dist/).
  --name <id>                   Override the install name (folder + SKILL.md name).
                                Useful when manifest.id collides with an existing
                                skill on disk. Defaults to manifest.id.
  --force                       If the target skill dir exists, remove it (rm -rf)
                                before installing. Without --force, install refuses.
  --allow-unenforced-permissions  See above. Required if the manifest declares
                                permissions the chosen adapter cannot enforce.
  --trace                       Bake --trace into the generated skill so each run
                                emits its step transcript (visible in chat).

Loads a manifest, builds adapters from the agent registry, and runs the
chit to completion. Prints final output to stdout, or a failure summary
to stderr on error.

Pass --scope <id> to enable per_scope session persistence. Sessions are keyed
by (scope, manifestId, participantId, fingerprint).

Permission enforcement: each participant's declared permissions are checked
against the chosen adapter's capabilities at install time. If the adapter
cannot enforce a permission, the run is rejected unless
--allow-unenforced-permissions is set. Both built-in adapters enforce
filesystem read_only today: codex-exec via an OS sandbox (--sandbox read-only
for a reviewer, --sandbox workspace-write for a write-capable implementer),
claude-cli via --permission-mode plan (a Claude plan-mode permission, not an
OS/filesystem sandbox).

Limitations in this build:
- file[] inputs are not yet supported via the CLI.
- claude-cli read-only is enforced by Claude plan-mode permissions, not an
  OS/filesystem sandbox: plan mode blocks writes (file edits and write-capable
  Bash) from inside claude. Codex runs in an OS sandbox sized to the
  participant's declared filesystem permission (--sandbox read-only for a
  reviewer, --sandbox workspace-write for a write-capable implementer).
`;

export async function runMain(argv: string[]): Promise<number> {
	// loop-log has nested sub-verbs and its own flags; it owns its parsing in a
	// separate module so the flat-command parser below stays simple.
	if (argv[0] === "loop-log") return runLoopLog(argv.slice(1));
	// converge drives the autonomous implement/check loop; it owns its own
	// flags and loop logic in a separate module, same as loop-log.
	if (argv[0] === "converge") return runConverge(argv.slice(1));
	// audit reads the persisted audit transcripts; read-only, its own parsing.
	if (argv[0] === "audit") return runAudit(argv.slice(1));
	// doctor is a read-only preflight (checks Bun, the agent CLIs, registry,
	// audit dir, MCP registration, git); it owns its own (argument-less) parsing.
	if (argv[0] === "doctor") return runDoctor(argv.slice(1));
	// job-run is the INTERNAL background-converge worker entrypoint (spawned
	// detached by chit_converge_run); deliberately not listed in help. It advances
	// one job's converge loop to a terminal state, writing job/loop/audit state.
	if (argv[0] === "job-run") {
		const jobId = argv[1];
		if (!jobId) {
			process.stderr.write("chit job-run: requires a <jobId>\n");
			return 2;
		}
		await runJobWorker(jobId, { jobStore: new JobStore() });
		return 0;
	}

	let args: ParsedArgs;
	try {
		args = parseArgs(argv);
	} catch (e) {
		process.stderr.write(`chit: ${(e as Error).message}\n\n${HELP}`);
		return 2;
	}

	if (args.command === "help") {
		process.stdout.write(HELP);
		return 0;
	}
	if (args.command === "install") {
		return runInstall(args);
	}
	if (args.command === "show") {
		return runShow(args);
	}
	if (args.command === "list") {
		return runList(args);
	}
	if (args.command === "uninstall") {
		return runUninstall(args);
	}
	if (args.command === "studio") {
		return runStudio(args);
	}
	if (args.command === "mcp") {
		// Launch the stdio MCP server. connect() resolves once connected; the stdio
		// transport then keeps the process alive until stdin closes, so returning 0
		// here does not end the process early (runMain's caller sets exitCode and
		// lets the event loop drain), matching `bun server.ts` and `chit studio`.
		await startMcpServer();
		return 0;
	}
	if (!args.manifestPath) {
		process.stderr.write(`chit: run requires a manifest path\n\n${HELP}`);
		return 2;
	}

	let manifestRaw: unknown;
	try {
		manifestRaw = JSON.parse(readFileSync(args.manifestPath, "utf-8"));
	} catch (e) {
		process.stderr.write(
			`chit: failed to read manifest ${args.manifestPath}: ${(e as Error).message}\n`,
		);
		return 2;
	}

	// Load the config and the manifest as separate steps so their failures report
	// distinctly: a malformed config.json is "invalid config"; a malformed or
	// unresolvable manifest is "invalid manifest". RESOLVE before any governance
	// check: resolution can change requires (a role can carry a per_scope session
	// parse cannot see), so the capability check below runs on the resolved manifest.
	// resolveManifest throws on an unknown role / no-agent participant.
	let config: NormalizedConfig;
	try {
		// --invocation-cwd is the run's working directory, so repo-config discovery
		// starts there (same value the runtime gets as invocationCwd below).
		config = loadConfig(undefined, { cwd: args.invocationCwd ?? process.cwd() });
	} catch (e) {
		process.stderr.write(`chit: invalid config: ${(e as Error).message}\n`);
		return 2;
	}
	let manifest: ResolvedManifest;
	try {
		manifest = resolveManifest(parseManifest(manifestRaw), { roles: config.roles });
	} catch (e) {
		process.stderr.write(`chit: invalid manifest: ${(e as Error).message}\n`);
		return 2;
	}

	if (args.inputStdinKey) {
		if (args.inputs[args.inputStdinKey] !== undefined) {
			process.stderr.write(
				`chit: --input-stdin "${args.inputStdinKey}" conflicts with --input ${args.inputStdinKey}=...\n`,
			);
			return 2;
		}
		// Bun.stdin.text() reads until EOF. The skill's heredoc closes stdin
		// after the closing delimiter; heredocs add a trailing newline we strip.
		let text = await Bun.stdin.text();
		if (text.endsWith("\n")) text = text.slice(0, -1);
		args.inputs[args.inputStdinKey] = text;
	}

	const surfaceCaps = cliCapabilities(args.scope);
	const missingCaps = findMissingCapabilities(manifest, surfaceCaps);
	if (missingCaps.length > 0) {
		process.stderr.write(
			`chit: this CLI surface does not provide capabilities required by "${manifest.id}":\n`,
		);
		for (const cap of missingCaps) process.stderr.write(`  - ${cap}\n`);
		if (missingCaps.includes("can_provide_stable_scope")) {
			process.stderr.write(
				"\nThis manifest uses session: per_scope. Pass --scope <id> to enable\n" +
					"session persistence, or change participant sessions to stateless.\n",
			);
		}
		if (missingCaps.includes("can_pass_files")) {
			process.stderr.write(
				"\nThis manifest declares file[] inputs. The CLI does not yet support\n" +
					"passing file inputs. Use a manifest with string-only inputs for now.\n",
			);
		}
		return 2;
	}

	const registry = config.registry;

	const unknownAgents = findUnknownAgents(manifest, registry);
	if (unknownAgents.length > 0) {
		for (const u of unknownAgents) {
			process.stderr.write(
				`chit: unknown agent "${u.agentId}" in registry (referenced by participant "${u.participantId}")\n`,
			);
		}
		return 2;
	}

	// Permission enforcement: each declared permission must be enforceable by
	// the chosen adapter. Shared with the claude-skill surface so governance
	// behavior is identical across surfaces.
	const enforcementGaps = findEnforcementGaps(manifest, registry);
	if (enforcementGaps.length > 0 && !args.allowUnenforcedPermissions) {
		process.stderr.write(`chit: cannot enforce required permissions for "${manifest.id}":\n`);
		for (const gap of enforcementGaps) {
			process.stderr.write(
				`  - participant "${gap.participantId}" (agent "${gap.agentId}") requires ${gap.permission}, but its adapter cannot enforce it\n`,
			);
		}
		process.stderr.write(
			"\nPass --allow-unenforced-permissions to run anyway (emits a warning each run).\n",
		);
		return 2;
	}
	// Past the strict gate: produce structured warnings via the shared
	// invocation-warning helper. Surfaces decide how to render the data;
	// the CLI surface emits to stderr. The user-visible output here is
	// identical to before the refactor.
	const warnings = collectInvocationWarnings(manifest, registry, {
		allowUnenforcedPermissions: args.allowUnenforcedPermissions,
	});
	if (warnings.length > 0) {
		process.stderr.write("chit: WARNING -- unenforced permissions:\n");
		for (const w of warnings) {
			process.stderr.write(`  - ${w.message}\n`);
		}
	}

	const adapters: AdapterMap = {};
	try {
		for (const p of Object.values(manifest.participants)) {
			if (!(p.agent in adapters)) {
				const agent = registry.agents[p.agent];
				if (!agent) continue; // already validated above
				adapters[p.agent] = buildAdapter(agent);
			}
		}
	} catch (e) {
		if (e instanceof AdapterError) {
			process.stderr.write(`chit: ${e.message}\n`);
			return 2;
		}
		throw e;
	}

	const invocationCwd = args.invocationCwd ?? process.cwd();

	// Opt-in audit: persist a full run (prompts/outputs/usage as blobs) to the
	// audit store. Best-effort and transparent, like the converge path. The audit
	// wrapper sits BENEATH the session wrapper so the recorder sees injected/
	// returned sessions.
	let effectiveAdapters = adapters;
	let recorder: AuditRecorder | undefined;
	const startedAt = Date.now();
	if (args.audit) {
		recorder = new AuditRecorder(new AuditStore(), crypto.randomUUID(), {
			manifestId: manifest.id,
			cwd: invocationCwd,
			surface: "cli",
			...(args.scope !== undefined && { scope: args.scope }),
			participants: resolveParticipantSnapshots(manifest, registry),
		});
		recorder.runStarted();
		effectiveAdapters = wrapAdaptersWithAudit(effectiveAdapters, recorder);
	}
	if (args.scope !== undefined) {
		const store = new FileSessionStore(defaultSessionDir());
		effectiveAdapters = wrapAdaptersWithSessions(
			effectiveAdapters,
			manifest,
			registry,
			args.scope,
			store,
		);
	}

	// --trace renders to stderr; audit feeds the recorder. Compose both.
	const onTrace =
		args.trace || recorder
			? (e: TraceEvent) => {
					if (args.trace) process.stderr.write(`${renderTraceEvent(e)}\n`);
					recorder?.fromTrace(e);
				}
			: undefined;

	// Surface the audit run id on stderr (never stdout, which carries the result)
	// so a user can find the transcript - including for a FAILED run. Only when the
	// audit run was actually written: if any audit write failed (lastError), there
	// is no usable transcript to point at, so stay silent.
	const reportAudit = () => {
		if (recorder && recorder.lastError === undefined) {
			process.stderr.write(`chit: audit run ${recorder.runId}\n`);
		}
	};

	let result: RunResult;
	try {
		result = await executeManifest(manifest, {
			inputs: args.inputs,
			adapters: effectiveAdapters,
			invocationCwd,
			onTrace,
		});
	} catch (e) {
		recorder?.runCompleted("failed", Date.now() - startedAt);
		recorder?.prune();
		reportAudit();
		if (e instanceof RuntimeError) {
			process.stderr.write(`chit: ${e.message}\n`);
			return 2;
		}
		throw e;
	}

	recorder?.runCompleted(result.ok ? "ok" : "failed", Date.now() - startedAt);
	recorder?.prune();
	reportAudit();

	if (result.ok) {
		process.stdout.write(result.output);
		if (!result.output.endsWith("\n")) process.stdout.write("\n");
		return 0;
	}

	process.stderr.write(`chit: run failed at step "${result.failedStep}"\n`);
	process.stderr.write(`  error: ${result.error}\n`);
	if (Object.keys(result.outputs).length > 0) {
		process.stderr.write(`  partial outputs: ${Object.keys(result.outputs).join(", ")}\n`);
	}
	return 1;
}

function defaultRuntimePath(): string {
	// Returns the CLI package root (i.e., apps/cli/). This file is at
	// apps/cli/src/cli/run.ts; two dirname() calls from import.meta.dir
	// (apps/cli/src/cli) take us up to apps/cli. The generated SKILL.md
	// bakes `${runtimePath}/src/cli/run.ts` into its bash block, so
	// runtimePath must be the CLI package root, NOT the repo root. The
	// `--runtime-path` flag accepts the same convention.
	return dirname(dirname(import.meta.dir));
}

// --- Trace rendering (--trace) ---

const TRACE_PREVIEW_CHARS = 280;

// One-line, length-capped preview. Full prompt/output stay in result.trace;
// --trace deliberately shows previews, not dumps, so a chat transcript stays
// readable.
function tracePreview(label: string, text: string): string {
	const oneLine = text.replace(/\s+/g, " ").trim();
	const clipped =
		oneLine.length > TRACE_PREVIEW_CHARS
			? `${oneLine.slice(0, TRACE_PREVIEW_CHARS)}… (${text.length} chars)`
			: oneLine;
	return `chit: trace |   ${label}: ${clipped}`;
}

function renderTraceEvent(e: TraceEvent): string {
	if (e.type === "step.started") {
		if (e.kind === "call") {
			const head = `chit: trace > step "${e.stepId}": call ${e.participantId} (agent ${e.agentId}, session ${e.session})`;
			return `${head}\n${tracePreview("prompt", e.prompt ?? "")}`;
		}
		return `chit: trace > step "${e.stepId}": format`;
	}
	if (e.type === "step.completed") {
		return `chit: trace < step "${e.stepId}": done in ${e.durationMs}ms\n${tracePreview("output", e.output)}`;
	}
	return `chit: trace x step "${e.stepId}": FAILED in ${e.durationMs}ms: ${e.error}`;
}

function runInstall(args: ParsedArgs): number {
	if (!args.manifestPath) {
		process.stderr.write(`chit: install requires a manifest path\n\n${HELP}`);
		return 2;
	}
	if (!args.installAs) {
		process.stderr.write("chit: --as is required (today: --as claude-skill)\n");
		return 2;
	}
	if (args.installAs !== "claude-skill") {
		process.stderr.write(`chit: unknown surface "${args.installAs}" (today: claude-skill)\n`);
		return 2;
	}

	const outputDir = args.outputDir ?? join(homedir(), ".claude", "skills");
	const runtimePath = args.runtimePath ?? defaultRuntimePath();

	try {
		const result = installClaudeSkill({
			manifestPath: args.manifestPath,
			outputDir,
			runtimePath,
			allowUnenforcedPermissions: args.allowUnenforcedPermissions,
			overrideName: args.overrideName,
			force: args.force,
			trace: args.trace,
		});
		process.stdout.write(`chit: installed skill at ${result.skillDir}\n`);
		process.stdout.write(`  SKILL.md: ${result.skillMdPath}\n`);
		process.stdout.write(`  manifest: ${result.manifestPath}\n`);
		process.stdout.write(`  runtime:  ${runtimePath}\n`);
		if (result.enforcementGaps.length > 0) {
			process.stdout.write(
				`  warnings: ${result.enforcementGaps.length} unenforced permission(s); the installed skill warns on every run\n`,
			);
		}
		return 0;
	} catch (e) {
		if (e instanceof SurfaceInstallError) {
			process.stderr.write(`chit: ${e.message}\n`);
			return 2;
		}
		throw e;
	}
}

function runShow(args: ParsedArgs): number {
	if (!args.manifestPath) {
		process.stderr.write(`chit: show requires a manifest path\n\n${HELP}`);
		return 2;
	}

	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(args.manifestPath, "utf-8"));
	} catch (e) {
		process.stderr.write(
			`chit: failed to read manifest ${args.manifestPath}: ${(e as Error).message}\n`,
		);
		return 2;
	}

	// Config and manifest failures report distinctly (mirrors the run path).
	let config: NormalizedConfig;
	try {
		config = loadConfig();
	} catch (e) {
		process.stderr.write(`chit: invalid config: ${(e as Error).message}\n`);
		return 2;
	}
	let manifest: ResolvedManifest;
	try {
		manifest = resolveManifest(parseManifest(raw), { roles: config.roles });
	} catch (e) {
		process.stderr.write(`chit: invalid manifest: ${(e as Error).message}\n`);
		return 2;
	}

	const registry = config.registry;
	let model: ReturnType<typeof buildGraphModel>;
	try {
		model = buildGraphModel(manifest, registry, args.showSurface);
	} catch (e) {
		process.stderr.write(`chit: ${(e as Error).message}\n`);
		return 2;
	}

	const format: ShowFormat = args.showFormat ?? "ascii";
	process.stdout.write(renderShow(model, format));
	return 0;
}

function runList(args: ParsedArgs): number {
	const parentDir = args.outputDir ?? defaultSkillsDir();
	const records = listInstalled(parentDir);

	if (args.listJson) {
		process.stdout.write(`${JSON.stringify({ parentDir, installs: records }, null, 2)}\n`);
		return 0;
	}

	if (records.length === 0) {
		process.stdout.write(`chit: no installs found under ${parentDir}\n`);
		return 0;
	}

	process.stdout.write(`installs under ${parentDir}:\n`);
	for (const r of records) {
		process.stdout.write(`  ${r.marker.installName}\n`);
		process.stdout.write(`    surface:    ${r.marker.surface}\n`);
		process.stdout.write(`    manifest:   ${r.marker.manifestId}\n`);
		process.stdout.write(`    runtime:    ${r.marker.runtimePath}\n`);
		process.stdout.write(`    installed:  ${r.marker.installedAt}\n`);
		process.stdout.write(`    path:       ${r.skillDir}\n`);
	}
	return 0;
}

function runUninstall(args: ParsedArgs): number {
	if (!args.uninstallName) {
		process.stderr.write(`chit: uninstall requires an install name\n\n${HELP}`);
		return 2;
	}
	const parentDir = args.outputDir ?? defaultSkillsDir();
	try {
		const removed = uninstall(parentDir, args.uninstallName);
		process.stdout.write(`chit: uninstalled ${removed.marker.installName}\n`);
		process.stdout.write(`  was at: ${removed.skillDir}\n`);
		return 0;
	} catch (e) {
		if (e instanceof LifecycleError) {
			process.stderr.write(`chit: ${e.message}\n`);
			return 2;
		}
		throw e;
	}
}

type StudioLiveSource = import("@chit-run/studio/server").StudioLiveSource;
type StudioLiveActions = import("@chit-run/studio/server").StudioLiveActions;
type LiveCancelResult = import("@chit-run/studio/server").LiveCancelResult;
type ForegroundLiveRow = import("@chit-run/studio/server").ForegroundLiveRow;
type BackgroundLiveRow = import("@chit-run/studio/server").BackgroundLiveRow;
type LiveParticipant = import("@chit-run/studio/server").LiveParticipant;
type LiveEventView = import("@chit-run/studio/server").LiveEventView;
type LiveExecutionIdentity = import("@chit-run/studio/server").LiveExecutionIdentity;
type RoutineLastRunSummary = import("@chit-run/studio/server").RoutineLastRunSummary;
type RoutineManifestSummary = import("@chit-run/studio/server").RoutineManifestSummary;
type StudioRoutineSource = import("@chit-run/studio/server").StudioRoutineSource;

// Live-activity source injected into Studio so GET /api/live reflects current Chit
// state without @chit-run/studio importing CLI internals (the CLI owns the state
// readers and injects this small interface). Two
// sources, kept visibly distinct in the response: the cross-process FOREGROUND
// registry (in-flight foreground loop iterations) and the durable JobStore
// (BACKGROUND jobs). Reads are best-effort: a registry/jobs I/O failure degrades
// that slice to [] rather than failing the whole snapshot, mirroring the operator
// status assembly. State dirs default to the real XDG-aware locations; tests pass
// temp dirs. Exported for the CLI injection-shape test.
export function buildStudioLiveSource(
	opts: { foregroundDir?: string; jobsDir?: string } = {},
): StudioLiveSource {
	const registry = new ForegroundRegistry(opts.foregroundDir);
	const jobStore = new JobStore(opts.jobsDir);
	return {
		live: () => {
			const now = Date.now();
			return {
				foreground: foregroundLiveRows(registry, now),
				background: backgroundLiveRows(jobStore, now),
			};
		},
	};
}

// Live actions injected into Studio so POST /api/live/cancel can cancel a
// BACKGROUND job, without @chit-run/studio importing CLI internals (the CLI owns
// JobStore and the worker signaling, like buildStudioLiveSource). Background
// ONLY: the foreground registry is a
// cross-process MIRROR -- Studio reads it but the MCP server, not the CLI host,
// owns the foreground run controller -- so this surface never claims to cancel a
// foreground run (the server rejects that with 422 before reaching here).
//
// The cancel itself runs through the shared requestJobCancel helper that
// chit_cancel and the batch engine also use, so all three honor the same
// intent-first, lock-protected semantics (cancelRequestedAt persisted BEFORE
// signaling; a RUNNING job also gets phase `cancelling`; a TERMINAL job is
// reported already-finished and never re-signaled, decided against the locked
// record). Here we only map the CLI-internal result onto Studio's wire shape.
// State dir defaults to the real XDG location; tests pass a temp dir. Exported for
// the CLI host test.
export function buildStudioLiveActions(opts: { jobsDir?: string } = {}): StudioLiveActions {
	const jobStore = new JobStore(opts.jobsDir);
	return {
		cancelBackground: (runId): LiveCancelResult => {
			const result = requestJobCancel(jobStore, runId);
			switch (result.status) {
				case "missing":
					return { status: "not-found" };
				case "terminal":
					return { status: "already-finished", state: result.state };
				case "requested":
					return { status: "requested", state: result.state, signaled: result.signaled };
			}
		},
	};
}

// Live foreground rows, newest-started first. The registry already filters
// dead/stale snapshots and skips corrupt files; reuse the operator status
// summarizer (it derives ages and reduces participants to agent+adapter at the
// read boundary), then remap its snake_case handle to Studio's camelCase wire
// shape.
function foregroundLiveRows(registry: ForegroundRegistry, nowMs: number): ForegroundLiveRow[] {
	// Opportunistically reclaim dead-pid snapshot files before reading. list() is
	// side-effect-free, so a server killed mid-iteration leaves a dead-pid file it
	// filters forever but never removes; this poll (GET /api/live, every few seconds
	// while Studio is open) is the natural place to sweep them. Best-effort: a prune
	// failure must never fail the live read, so it is swallowed and the read proceeds.
	try {
		registry.pruneDead();
	} catch {
		// best-effort cleanup; never fail the live read
	}
	let snapshots: ReturnType<ForegroundRegistry["list"]>;
	try {
		snapshots = registry.list(nowMs);
	} catch {
		return [];
	}
	return snapshots
		.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
		.map((s): ForegroundLiveRow => {
			const summary = summarizeForegroundForStatus(s, nowMs);
			const phases = foregroundPhaseTimeline(s, summary);
			const recentEvents = liveEventViews(s.events, nowMs);
			return {
				source: "foreground",
				runId: summary.run_id,
				scope: summary.scope,
				task: summary.task,
				...(summary.taskFull !== undefined && { taskFull: summary.taskFull }),
				phase: summary.phase,
				statusLine: summary.statusLine,
				iteration: summary.iteration,
				...(summary.maxIterations !== undefined && { maxIterations: summary.maxIterations }),
				...(summary.callTimeoutMs !== undefined && { callTimeoutMs: summary.callTimeoutMs }),
				...(summary.worktreePath !== undefined && { worktreePath: summary.worktreePath }),
				...(summary.elapsedMs !== undefined && { elapsedMs: summary.elapsedMs }),
				...(summary.phaseElapsedMs !== undefined && { phaseElapsedMs: summary.phaseElapsedMs }),
				...(summary.lastActivityAgeMs !== undefined && {
					lastActivityAgeMs: summary.lastActivityAgeMs,
				}),
				...(phases !== undefined && { phases }),
				...(recentEvents !== undefined && { recentEvents }),
				...(summary.participants !== undefined && { participants: summary.participants }),
			};
		});
}

// The current iteration's phase timeline for a foreground row: each stored
// completed phase becomes a fixed duration (its own two marks), and the active
// phase -- when its clock is derivable -- appends as the single trailing "active"
// entry, with elapsedMs against the reader's clock (the summary's phaseElapsedMs,
// the same derivation the row's top-level field uses). A completed entry with an
// unparseable or inverted pair is dropped rather than shown with a bogus duration.
// Returns undefined when nothing is derivable (e.g. the pre-phase "starting"
// spin-up), so the row omits the field. Foreground only by design: background
// rows carry no per-iteration phase history.
function foregroundPhaseTimeline(
	s: ForegroundSnapshot,
	summary: ForegroundActivitySummary,
): ForegroundLiveRow["phases"] {
	const timeline: NonNullable<ForegroundLiveRow["phases"]> = [];
	for (const p of s.phases ?? []) {
		const started = Date.parse(p.startedAt);
		const ended = Date.parse(p.endedAt);
		if (!Number.isFinite(started) || !Number.isFinite(ended) || ended < started) continue;
		timeline.push({ phase: p.phase, status: "completed", elapsedMs: ended - started });
	}
	if (summary.phaseElapsedMs !== undefined) {
		timeline.push({ phase: summary.phase, status: "active", elapsedMs: summary.phaseElapsedMs });
	}
	return timeline.length > 0 ? timeline : undefined;
}

// Map a live-event tail onto Studio's wire shape. Shared by foreground and
// background rows, the same way both share the participant reduction. The tail
// is re-run through sanitizeLiveEvents first -- the read paths already sanitize
// at the trust boundary (parseSnapshot / JobStore), but this surface hands rows
// to a browser, so the cap and the field allowlist (kind/label/ids, never
// raw/body/prompt/output) are enforced here too rather than assumed. The
// sanitizer gets the reader's clock, so an entry with a future timestamp (no
// derivable age) is dropped BEFORE the cap -- a skewed or hostile tail can
// never crowd out the datable safe entries. Each surviving entry's stored
// timestamp becomes an age against that same clock (the row-level age
// convention). Returns undefined when nothing survives, so the row omits the
// field.
function liveEventViews(
	events: LiveEventSummary[] | undefined,
	nowMs: number,
): LiveEventView[] | undefined {
	const out: LiveEventView[] = [];
	for (const e of sanitizeLiveEvents(events, nowMs)) {
		out.push({
			ageMs: nowMs - e.ts,
			kind: e.kind,
			label: e.label,
			...(e.stepId !== undefined && { stepId: e.stepId }),
			...(e.participantId !== undefined && { participantId: e.participantId }),
			...(e.agentId !== undefined && { agentId: e.agentId }),
		});
	}
	return out.length > 0 ? out : undefined;
}

// Live background rows: only in-flight jobs (queued/running, including stale).
// Terminal receipts belong in the Loops/receipt views, not in the live control
// tower. JobStore.list() is newest-first and skips corrupt files; guard the whole
// read so a jobs I/O failure degrades this slice to [] rather than failing the
// snapshot.
function backgroundLiveRows(jobStore: JobStore, nowMs: number): BackgroundLiveRow[] {
	let all: JobRecord[];
	try {
		// The reader clock makes the store drop future-dated tail entries before its
		// own cap, so they cannot crowd out datable ones (see withSanitizedTail).
		all = jobStore.list(nowMs);
	} catch {
		return [];
	}
	return all
		.filter((j) => j.state === "queued" || j.state === "running")
		.map((j) => backgroundRow(j, nowMs));
}

function backgroundRow(job: JobRecord, nowMs: number): BackgroundLiveRow {
	// `stale` is derived (a running job whose worker is gone or its heartbeat is
	// old), the same legible signal chit_status surfaces; the stored state is never
	// rewritten.
	const display = isStale(job, nowMs) ? "stale" : job.state;
	const timing = jobTiming(job, nowMs);
	// A compact glance line, mirroring the foreground statusLine style (no live
	// duration baked in -- the reader composes that from the derived ages).
	const statusLine = job.phase ? `${display} · ${job.phase}` : display;
	const participants = liveParticipants(job);
	const execution = executionIdentity(job);
	const recentEvents = liveEventViews(job.recentEvents, nowMs);
	return {
		source: "background",
		runId: job.runId,
		scope: job.scope ?? "",
		display,
		statusLine,
		// JobRecord.task is the raw converge body. Keep `task` bounded for the rail,
		// and expose the full value only through Studio's selected-run disclosure.
		...(job.policy === "loop" && { task: compactTask(job.task), taskFull: job.task }),
		// Structured loop counters/budgets, straight from the persisted record (plain
		// numbers only). A one-shot job has no loop identity, so none of these apply.
		...(job.policy === "loop" && {
			...(job.iteration !== undefined && { iteration: job.iteration }),
			iterationsCompleted: job.iterationsCompleted,
			maxIterations: job.maxIterations,
			...(job.callTimeoutMs !== undefined && { callTimeoutMs: job.callTimeoutMs }),
		}),
		...(job.phase !== undefined && { phase: job.phase }),
		...(job.worktreePath !== undefined && { worktreePath: job.worktreePath }),
		...(timing.elapsedMs !== undefined && { elapsedMs: timing.elapsedMs }),
		...(timing.phaseElapsedMs !== undefined && { phaseElapsedMs: timing.phaseElapsedMs }),
		...(timing.lastHeartbeatAgeMs !== undefined && {
			lastHeartbeatAgeMs: timing.lastHeartbeatAgeMs,
		}),
		...(recentEvents !== undefined && { recentEvents }),
		...(participants !== undefined && { participants }),
		...(execution !== undefined && { execution }),
	};
}

// Reduce a loop job's persisted participant provenance to the safe identity the
// rail shows: the agent+adapter pair plus the model/reasoningEffort the agent
// runs with. The stored snapshot's config also carries envKeys and the rest of
// the participant config; those are config detail and MUST NOT cross this
// surface, so only model + reasoningEffort are copied from config (when present).
// Permissions and enforcement flags stay out entirely. A one-shot job has no
// participant provenance.
function liveParticipants(job: JobRecord): Record<string, LiveParticipant> | undefined {
	if (job.policy !== "loop" || job.participants === undefined) return undefined;
	const out: Record<string, LiveParticipant> = {};
	for (const [id, p] of Object.entries(job.participants)) {
		out[id] = {
			agentId: p.agentId,
			adapter: p.adapter,
			...(p.config.model !== undefined && { model: p.config.model }),
			...(p.config.reasoningEffort !== undefined && { reasoningEffort: p.config.reasoningEffort }),
		};
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

// The execution surface of a background loop run, rebuilt field-by-field for the
// wire: the run's recipe identity (id/origin layer/budgets, never the origin
// path) and the manifest path + content digest it was bound to. Direct runs with
// no recipe and no digest binding yield nothing, so the row omits the field. A
// one-shot job has no recipe/digest binding. PRIVACY: identity facts only -- no
// manifest CONTENTS, prompts, config values, or env cross here.
function executionIdentity(job: JobRecord): LiveExecutionIdentity | undefined {
	if (job.policy !== "loop") return undefined;
	const identity: LiveExecutionIdentity = {};
	if (job.recipe !== undefined) {
		identity.recipe = {
			id: job.recipe.id,
			mode: job.recipe.mode,
			...(job.recipe.origin !== undefined && { origin: job.recipe.origin.source }),
			...(job.recipe.maxIterations !== undefined && { maxIterations: job.recipe.maxIterations }),
			...(job.recipe.callTimeoutMs !== undefined && { callTimeoutMs: job.recipe.callTimeoutMs }),
		};
	}
	if (job.manifestPath !== undefined) identity.manifestPath = job.manifestPath;
	if (job.manifestDigest !== undefined) identity.manifestDigest = job.manifestDigest;
	return identity.recipe !== undefined ||
		identity.manifestPath !== undefined ||
		identity.manifestDigest !== undefined
		? identity
		: undefined;
}

// Where the Studio client bundle lives in a published install: next to the
// packaged chit.js (dist/client/), copied there by build.ts. The Studio server's
// own default path is correct for a source checkout but resolves wrong once the
// server module is inlined into chit.js, so the CLI passes the packaged path
// explicitly when it exists. moduleDir is import.meta.dir of the running module:
// apps/cli/dist in the published bundle, apps/cli/src/cli in a source checkout.
// In a source checkout dist/client/ does not sit beside this module, so we
// return undefined and let the Studio server fall back to its source-checkout
// default (apps/studio/dist/client). Exported for tests.
export function studioClientDir(moduleDir: string): string | undefined {
	const packaged = join(moduleDir, "client");
	return existsSync(join(packaged, "index.js")) ? packaged : undefined;
}

interface LastRunCandidate {
	recipeId?: string;
	manifestPath?: string;
	manifestDigest?: string;
	loopId: string;
	sortAt: string;
	summary: RoutineLastRunSummary;
}

function loopHeader(records: LoopRecord[]): LoopHeaderRecord | undefined {
	const first = records[0];
	return first?.type === "loop" ? first : undefined;
}

function latestIteration(records: LoopRecord[]): LoopIterationRecord | undefined {
	return records.filter((r): r is LoopIterationRecord => r.type === "iteration").at(-1);
}

function positiveAgeMs(iso: string | undefined, nowMs: number): number | undefined {
	if (iso === undefined) return undefined;
	const parsed = Date.parse(iso);
	if (!Number.isFinite(parsed)) return undefined;
	return Math.max(0, nowMs - parsed);
}

function terminalLastRunCandidate(
	records: LoopRecord[],
	nowMs: number,
	opts: { traceRef?: string; manifestPath?: string; manifestDigest?: string } = {},
): LastRunCandidate | undefined {
	const header = loopHeader(records);
	if (header === undefined) return undefined;
	const receipt = buildLoopReceipt(records);
	if (receipt.status === "open" || receipt.status === "running") return undefined;
	const latest = latestIteration(records);
	const auditRef = receipt.auditRefs.at(-1);
	const summary: RoutineLastRunSummary = {
		status: receipt.status,
		iterationsCompleted: receipt.iterationsCompleted,
	};
	if (latest !== undefined) summary.verdict = latest.verdict;
	if (receipt.statusLine !== undefined) summary.statusLine = receipt.statusLine;
	if (receipt.elapsedMs !== undefined) summary.elapsedMs = receipt.elapsedMs;
	const ageMs = positiveAgeMs(receipt.endedAt ?? latest?.at ?? header.startedAt, nowMs);
	if (ageMs !== undefined) summary.ageMs = ageMs;
	if (receipt.usage?.estimatedCostUsd !== undefined) {
		summary.estimatedCostUsd = receipt.usage.estimatedCostUsd;
	}
	if (auditRef !== undefined) summary.auditRef = auditRef;
	summary.traceRef = opts.traceRef ?? header.loopId;
	const candidate: LastRunCandidate = {
		loopId: header.loopId,
		sortAt: receipt.endedAt ?? latest?.at ?? header.startedAt,
		summary,
	};
	if (header.recipe?.id !== undefined) candidate.recipeId = header.recipe.id;
	if (opts.manifestPath !== undefined) candidate.manifestPath = opts.manifestPath;
	if (opts.manifestDigest !== undefined) candidate.manifestDigest = opts.manifestDigest;
	return candidate;
}

function safeReadLoopRecords(path: string): LoopRecord[] | undefined {
	try {
		return validateLoopLog(parseLoopLog(readFileSync(path, "utf-8")));
	} catch {
		return undefined;
	}
}

function safeDirEntries(path: string): Dirent[] {
	try {
		return readdirSync(path, { withFileTypes: true });
	} catch {
		return [];
	}
}

function loopRecordPathsForCwd(studioCwd: string): string[] {
	const paths: string[] = [];
	const directDir = loopLogDir(studioCwd);
	if (existsSync(directDir)) {
		for (const entry of safeDirEntries(directDir)) {
			if (entry.isFile() && entry.name.endsWith(".jsonl")) {
				paths.push(join(directDir, entry.name));
			}
		}
	}
	return paths;
}

function jobBelongsToRepo(
	job: LoopJobRecord,
	targetRepoRoot: string,
	targetRepoKey: string,
): boolean {
	return (
		job.repoKey === targetRepoKey ||
		job.repo === targetRepoRoot ||
		job.callerCheckout === targetRepoRoot
	);
}

function terminalJobCandidate(job: LoopJobRecord, nowMs: number): LastRunCandidate | undefined {
	if (job.state === "queued" || job.state === "running") return undefined;
	let records: LoopRecord[] | undefined;
	try {
		records = readLoop(job.cwd, job.loopId);
	} catch {
		records = undefined;
	}
	if (records !== undefined) {
		const candidate = terminalLastRunCandidate(records, nowMs, {
			traceRef: job.runId,
			...(job.manifestPath !== undefined && { manifestPath: job.manifestPath }),
			...(job.manifestDigest !== undefined && { manifestDigest: job.manifestDigest }),
		});
		if (candidate !== undefined) {
			if (job.recipe?.id !== undefined) candidate.recipeId = job.recipe.id;
			return candidate;
		}
	}

	const endedAge = positiveAgeMs(job.endedAt, nowMs);
	const elapsedMs =
		job.startedAt !== undefined && job.endedAt !== undefined
			? Date.parse(job.endedAt) - Date.parse(job.startedAt)
			: undefined;
	const summary: RoutineLastRunSummary = {
		status: job.stopStatus ?? job.state,
		iterationsCompleted: job.iterationsCompleted,
		traceRef: job.runId,
	};
	if (job.lastVerdict !== undefined) summary.verdict = job.lastVerdict;
	if (Number.isFinite(elapsedMs) && elapsedMs !== undefined && elapsedMs >= 0) {
		summary.elapsedMs = elapsedMs;
	}
	if (endedAge !== undefined) summary.ageMs = endedAge;
	const auditRef = job.auditRefs.at(-1);
	if (auditRef !== undefined) summary.auditRef = auditRef;
	const candidate: LastRunCandidate = {
		loopId: job.loopId,
		sortAt: job.endedAt ?? job.startedAt ?? job.createdAt,
		summary,
	};
	if (job.recipe?.id !== undefined) candidate.recipeId = job.recipe.id;
	if (job.manifestPath !== undefined) candidate.manifestPath = job.manifestPath;
	if (job.manifestDigest !== undefined) candidate.manifestDigest = job.manifestDigest;
	return candidate;
}

function lastRunMatchesRoutine(
	candidate: LastRunCandidate,
	recipeId: string,
	recipeManifestPath: string,
	manifest: RoutineManifestSummary | undefined,
): boolean {
	if (candidate.recipeId !== undefined) return candidate.recipeId === recipeId;
	return (
		candidate.manifestPath === recipeManifestPath &&
		candidate.manifestDigest !== undefined &&
		manifest?.manifestDigest !== undefined &&
		candidate.manifestDigest === manifest.manifestDigest
	);
}

function collectLastRunCandidates(studioCwd: string, targetRepoRoot: string): LastRunCandidate[] {
	const nowMs = Date.now();
	const byLoop = new Map<string, LastRunCandidate>();
	for (const path of loopRecordPathsForCwd(studioCwd)) {
		const records = safeReadLoopRecords(path);
		if (records === undefined) continue;
		const candidate = terminalLastRunCandidate(records, nowMs);
		if (candidate !== undefined) byLoop.set(candidate.loopId, candidate);
	}

	let jobs: JobRecord[] = [];
	try {
		jobs = new JobStore().list(nowMs);
	} catch {
		jobs = [];
	}
	const targetRepoKey = repoKey(studioCwd);
	for (const job of jobs) {
		if (job.policy !== "loop" || !jobBelongsToRepo(job, targetRepoRoot, targetRepoKey)) {
			continue;
		}
		const candidate = terminalJobCandidate(job, nowMs);
		if (candidate !== undefined) byLoop.set(candidate.loopId, candidate);
	}

	return [...byLoop.values()];
}

function latestRoutineLastRun(
	candidates: LastRunCandidate[],
	targetRepoRoot: string,
	config: NormalizedConfig,
	recipeId: string,
	manifest: RoutineManifestSummary | undefined,
): RoutineLastRunSummary | undefined {
	const recipe = config.recipes[recipeId];
	if (recipe === undefined) return undefined;
	let recipeManifestPath: string;
	try {
		recipeManifestPath = normalizeManifestReference(
			recipe.manifestPath,
			targetRepoRoot,
			targetRepoRoot,
		).manifestPath;
	} catch {
		return undefined;
	}

	return candidates
		.filter((candidate) => lastRunMatchesRoutine(candidate, recipeId, recipeManifestPath, manifest))
		.sort((a, b) => b.sortAt.localeCompare(a.sortAt))[0]?.summary;
}

// Studio asks the CLI to resolve manifests because the CLI owns the git read point
// and path guards. The returned shape is the small at-rest summary only.
export function buildStudioRoutineSource(studioCwd: string): StudioRoutineSource | undefined {
	let repoRoot: string;
	try {
		repoRoot = repoToplevel(realGit, studioCwd);
	} catch {
		return undefined;
	}
	const candidatesByConfig = new WeakMap<NormalizedConfig, LastRunCandidate[]>();
	function candidatesForConfig(config: NormalizedConfig): LastRunCandidate[] {
		const existing = candidatesByConfig.get(config);
		if (existing !== undefined) return existing;
		const candidates = collectLastRunCandidates(studioCwd, repoRoot);
		candidatesByConfig.set(config, candidates);
		return candidates;
	}
	return {
		resolveManifest(config, recipeId) {
			const recipe = config.recipes[recipeId];
			if (recipe === undefined) throw new Error(`unknown recipe ${JSON.stringify(recipeId)}`);
			const baseSha = resolveBaseSha(realGit, repoRoot, "HEAD");
			const ref = normalizeManifestReference(recipe.manifestPath, repoRoot, repoRoot);
			const text = readBoundManifestText(ref, { git: realGit, gitCwd: repoRoot, baseSha });
			let raw: unknown;
			try {
				raw = JSON.parse(text);
			} catch (e) {
				throw new Error(`manifest ${ref.manifestPath} is not valid JSON: ${(e as Error).message}`);
			}
			const resolved = resolveManifest(parseManifest(raw), { roles: config.roles });
			const unknownAgents = findUnknownAgents(resolved, config.registry);
			if (unknownAgents.length > 0) {
				const first = unknownAgents[0] as (typeof unknownAgents)[number];
				throw new Error(
					`manifest ${ref.manifestPath}: unknown agent ${JSON.stringify(first.agentId)} referenced by participant ${JSON.stringify(first.participantId)}`,
				);
			}
			const snapshots = resolveParticipantSnapshots(resolved, config.registry);
			const participants = Object.entries(resolved.participants).map(([id, p]) => {
				const snapshot = snapshots[id];
				if (snapshot === undefined) {
					throw new Error(`manifest ${ref.manifestPath}: could not resolve participant ${id}`);
				}
				return {
					id,
					...(p.provenance.role !== undefined && { role: p.provenance.role }),
					agentId: snapshot.agentId,
					session: snapshot.session,
					filesystem: snapshot.permissions.filesystem,
				};
			});
			const requiredChecks =
				resolved.policy.kind === "loop"
					? (resolved.policy.requiredChecks ?? []).map((check) => ({
							...(check.name !== undefined && { name: check.name }),
							command: check.command,
							args: check.args,
							...(check.timeoutMs !== undefined && { timeoutMs: check.timeoutMs }),
						}))
					: [];
			return { manifestDigest: digestManifestText(text), participants, requiredChecks };
		},
		resolveLastRun(config, recipeId, manifest) {
			return latestRoutineLastRun(
				candidatesForConfig(config),
				repoRoot,
				config,
				recipeId,
				manifest,
			);
		},
	};
}

async function runStudio(_args: ParsedArgs): Promise<number> {
	const { startStudio } = await import("@chit-run/studio/server");
	// The Studio target repo, captured once so config reads observe the same repo.
	const studioCwd = process.cwd();
	let handle: { url: string; stop(): void };
	try {
		handle = await startStudio({
			cwd: studioCwd,
			// Live activity backed by current Chit state: the cross-process foreground
			// registry and the durable background jobs. Defaults to the real XDG state
			// dirs, the same locations the MCP server and workers write.
			liveSource: buildStudioLiveSource(),
			// Cancel a background job through JobStore + the worker signaling, the
			// same intent-first path chit_cancel uses. Background only -- the CLI host
			// does not own the MCP foreground controller, so it never claims to cancel
			// a foreground run.
			liveActions: buildStudioLiveActions(),
			// Effective-config reader for GET /api/config: a fresh loadConfig per
			// request against the Studio target repo cwd, so the view tracks config
			// edits made while Studio is open. A load failure propagates as 422 from
			// the route instead of silently reporting defaults.
			configSource: { load: () => loadConfig(undefined, { cwd: studioCwd }) },
			// Lets /api/routines show the same manifest identity a recipe-backed run binds.
			routineSource: buildStudioRoutineSource(studioCwd),
			// In a published install the client bundle ships beside chit.js, not at
			// the Studio server's default path. Undefined in a source checkout, where
			// the server default already resolves correctly.
			clientDistDir: studioClientDir(import.meta.dir),
		});
	} catch (e) {
		process.stderr.write(`chit studio: failed to start: ${(e as Error).message}\n`);
		return 1;
	}

	process.stdout.write(`chit studio: ${handle.url}\n`);
	process.stdout.write("Press Ctrl-C to stop.\n");
	await new Promise<void>((resolve) => {
		process.on("SIGINT", () => {
			process.stdout.write("\nchit studio: stopped\n");
			handle.stop();
			resolve();
		});
	});
	return 0;
}

if (import.meta.main) {
	// Set the exit code and let the process end naturally. A hard process.exit()
	// here truncates output still buffered in an async pipe (piping `--format
	// json` to a consumer dropped most or all of it), because exit does not wait
	// for stdout to drain. Returning lets the event loop flush stdout/stderr first.
	process.exitCode = await runMain(process.argv.slice(2));
}
