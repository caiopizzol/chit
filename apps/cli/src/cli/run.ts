import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { NormalizedManifest } from "@chit-run/core";
import {
	buildGraphModel,
	collectInvocationWarnings,
	findEnforcementGaps,
	findMissingCapabilities,
	findUnknownAgents,
	parseManifest,
	renderShow,
	resolveParticipantSnapshots,
	type ShowFormat,
} from "@chit-run/core";
import { AdapterError, buildAdapter } from "../adapters/factory.ts";
import { loadRegistry } from "../agents/parse.ts";
import { AuditRecorder } from "../audit/recorder.ts";
import { AuditStore } from "../audit/store.ts";
import { wrapAdaptersWithAudit } from "../audit/wrap.ts";
import { executeManifest } from "../runtime/execute.ts";
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
import { runAudit } from "./audit.ts";
import { runConverge } from "./converge.ts";
import { runLoopLog } from "./loop-log.ts";

const BASE_CLI_CAPABILITIES: ReadonlySet<string> = new Set(["can_show_markdown"]);

function cliCapabilities(scope: string | undefined): Set<string> {
	const caps = new Set(BASE_CLI_CAPABILITIES);
	if (scope !== undefined) caps.add("can_provide_stable_scope");
	return caps;
}

interface ParsedArgs {
	command: "run" | "install" | "show" | "list" | "uninstall" | "studio" | "help";
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
	throw new Error(`unknown command: ${argv[0]}`);
}

function parseStudioArgs(argv: string[]): ParsedArgs {
	// `chit studio [path]` — path is optional. If present, it is the explicit
	// manifest path (one positional, no flags in sub-unit 1.0). Unknown flags
	// and extra positionals throw, following the same pattern as the other
	// parseXxxArgs in this file. `--help` / `-h` yield the top-level help so
	// behavior is consistent with the rest of the CLI.
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
		if (out.manifestPath !== undefined) {
			throw new Error(`studio: unexpected argument "${a}"`);
		}
		out.manifestPath = a;
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
  chit studio [path]
  chit loop-log <start|append|stop|show> [flags]   (chit loop-log --help)
  chit converge --task <text> --scope <id> [options]   (chit converge --help)
  chit audit <list|show> [options]   (chit audit --help)
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
                                will generate a broken skill.
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
filesystem read_only today: codex-exec via --sandbox read-only (a hard OS
sandbox), claude-cli via --permission-mode plan (Claude plan-mode permissions,
not an OS/filesystem sandbox).

Limitations in this build:
- file[] inputs are not yet supported via the CLI.
- claude-cli read-only is enforced by Claude plan-mode permissions, not an
  OS/filesystem sandbox: plan mode blocks writes (file edits and write-capable
  Bash) from inside claude. Codex remains the hard sandbox.
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

	let manifest: NormalizedManifest;
	try {
		manifest = parseManifest(manifestRaw);
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

	const registry = loadRegistry();

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

	let manifest: NormalizedManifest;
	try {
		manifest = parseManifest(raw);
	} catch (e) {
		process.stderr.write(`chit: invalid manifest: ${(e as Error).message}\n`);
		return 2;
	}

	const registry = loadRegistry();
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

// Lifecycle adapter injected into Studio so its install/list/uninstall
// endpoints reuse the exact CLI surface code paths (no workspace cycle: the
// CLI implements the interface @chit-run/studio defines). CHIT_SKILLS_DIR overrides
// the install location, so e2e tests install into a temp dir instead of the
// real ~/.claude/skills.
function buildStudioLifecycle(): import("@chit-run/studio/server").StudioLifecycle {
	const skillsDir = process.env.CHIT_SKILLS_DIR ?? defaultSkillsDir();
	return {
		list: () =>
			listInstalled(skillsDir).map((r) => ({
				name: r.marker.installName,
				surface: r.marker.surface,
				manifestId: r.marker.manifestId,
				installedAt: r.marker.installedAt,
			})),
		install: (params) => {
			if (params.surface !== "claude-skill") {
				throw new Error(`surface "${params.surface}" is not installable (today: claude-skill)`);
			}
			const result = installClaudeSkill({
				manifestPath: params.manifestPath,
				outputDir: skillsDir,
				runtimePath: defaultRuntimePath(),
				overrideName: params.overrideName,
				force: params.force,
				allowUnenforcedPermissions: params.allowUnenforcedPermissions,
			});
			return {
				name: basename(result.skillDir),
				surface: "claude-skill",
				enforcementGaps: [...result.enforcementGaps],
			};
		},
		uninstall: (name) => {
			const removed = uninstall(skillsDir, name);
			return { name: removed.marker.installName };
		},
	};
}

async function runStudio(args: ParsedArgs): Promise<number> {
	const { PathError, startStudio } = await import("@chit-run/studio/server");
	let handle: { url: string; stop(): void };
	try {
		const registry = loadRegistry();
		handle = await startStudio({
			cwd: process.cwd(),
			explicitPath: args.manifestPath,
			registry,
			lifecycle: buildStudioLifecycle(),
		});
	} catch (e) {
		if (e instanceof PathError) {
			process.stderr.write(`chit: ${e.message}\n`);
			return 2;
		}
		throw e;
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
