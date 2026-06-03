import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import type { NormalizedRegistry, ResolvedManifest } from "@chit-run/core";
import {
	findEnforcementGaps,
	findMissingCapabilities,
	findUnknownAgents,
	formatEnforcementGaps,
	INSTALL_MARKER_FILENAME,
	type InstallMarker,
	parseManifest,
	resolveManifest,
	VALID_INSTALL_NAME_RE,
} from "@chit-run/core";
import { loadConfig } from "../config/load.ts";

export class SurfaceInstallError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SurfaceInstallError";
	}
}

// Capabilities the claude-skill surface offers at run time. Deliberately
// narrower than the CLI in PR6:
// - can_show_markdown: Claude Code renders the markdown output directly.
// - can_provide_stable_scope: derived from CLAUDE_SESSION_ID + worktree at run
//   time (the bash block computes it). The skill always provides scope, so
//   per_scope manifests install cleanly.
// - can_pass_files: NOT claimed. Argument hints in SKILL.md are UX, not a
//   runtime mechanism for passing structured file[] inputs.
const CLAUDE_SKILL_CAPABILITIES: ReadonlySet<string> = new Set([
	"can_show_markdown",
	"can_provide_stable_scope",
]);

export interface InstallOptions {
	// Path to the manifest source file. The file is read, parsed for
	// validation, and copied (canonical JSON) into the generated skill dir.
	// We copy the raw form (not the normalized one) so the runner can parse it
	// the same way as a hand-written manifest.
	manifestPath: string;
	// Directory where the skill folder will be created. The folder name is the
	// installed name (defaults to manifest.id, or overrideName if set).
	outputDir: string;
	// Absolute path to the chit runtime (the project root that contains
	// `src/cli/run.ts`). Baked into the generated SKILL.md.
	runtimePath: string;
	// Optional override for the install name. Affects both the folder name
	// (`<outputDir>/<name>`) and the SKILL.md `name:` frontmatter. Useful when
	// the manifest's id collides with an existing skill on disk. Defaults to
	// manifest.id.
	overrideName?: string;
	// If true and the target skill directory already exists, it is removed
	// (rm -rf semantics) before installing. The default is false, in which
	// case install refuses with a clear error pointing at overrideName/force.
	force?: boolean;
	// If true and the manifest declares permissions the chosen adapters cannot
	// enforce, install proceeds; the generated SKILL.md includes the
	// --allow-unenforced-permissions flag and the runtime will warn on every
	// invocation. If false, install refuses with SurfaceInstallError.
	allowUnenforcedPermissions?: boolean;
	// If true, the generated SKILL.md runs with --trace, so each invocation emits
	// a step transcript (id, participant, agent, session, elapsed, previews)
	// ahead of the final output. Off by default.
	trace?: boolean;
	// Used by tests to inject a fixture registry. Production callers omit this.
	registry?: NormalizedRegistry;
}

export interface InstallResult {
	skillDir: string;
	skillMdPath: string;
	manifestPath: string;
	markerPath: string;
	enforcementGaps: ReadonlyArray<{ participantId: string; agentId: string; permission: string }>;
}

export function installClaudeSkill(opts: InstallOptions): InstallResult {
	// Validate overrideName BEFORE doing any IO. A malicious or buggy name
	// (e.g., "..") combined with --force would delete outside the skills dir.
	if (opts.overrideName !== undefined && !VALID_INSTALL_NAME_RE.test(opts.overrideName)) {
		throw new SurfaceInstallError(
			`overrideName "${opts.overrideName}" is invalid: must be kebab-case (lowercase letters, digits, hyphens; must start with a letter). Path-traversal sequences like ".." or "/" are rejected.`,
		);
	}

	// Resolve outputDir and runtimePath to absolute paths at install time.
	// SKILL.md bakes runtimePath into its bash block; a relative path would
	// only work from whatever cwd Claude Code happened to launch from.
	const outputDir = resolvePath(opts.outputDir);
	const runtimePath = resolvePath(opts.runtimePath);
	const allowUnenforced = opts.allowUnenforcedPermissions === true;

	let rawJson: unknown;
	try {
		rawJson = JSON.parse(readFileSync(opts.manifestPath, "utf-8"));
	} catch (e) {
		throw new SurfaceInstallError(
			`failed to read manifest ${opts.manifestPath}: ${(e as Error).message}`,
		);
	}
	// Load the config (agents + roles) so install resolves role references the same
	// way a run does. Tests inject opts.registry with inline manifests, so roles
	// default to {} on that path. A real install with no injected registry uses the
	// file config (built-ins when absent).
	const config = opts.registry === undefined ? loadConfig() : undefined;
	const registry = opts.registry ?? config?.registry;
	if (!registry) throw new SurfaceInstallError("internal: no registry resolved");
	const roles = config?.roles ?? {};

	let manifest: ResolvedManifest;
	try {
		manifest = resolveManifest(parseManifest(rawJson), { roles });
	} catch (e) {
		throw new SurfaceInstallError(
			`invalid manifest at ${opts.manifestPath}: ${(e as Error).message}`,
		);
	}

	// Capability check first: this is the architectural contract. A manifest
	// that needs a capability the surface doesn't provide (e.g., can_pass_files
	// for file[] inputs) is rejected here, before surface-specific input-shape
	// constraints. This matches how the CLI orders its checks.
	const missingCaps = findMissingCapabilities(manifest, CLAUDE_SKILL_CAPABILITIES);
	if (missingCaps.length > 0) {
		throw new SurfaceInstallError(
			`claude-skill surface does not provide capabilities required by "${manifest.id}": ${missingCaps.join(", ")}`,
		);
	}

	// PR6 input-shape constraint: skill maps $ARGUMENTS to a single string
	// input. Capability check above already rules out file[] inputs (they'd
	// infer can_pass_files which the surface doesn't claim).
	const inputNames = Object.keys(manifest.inputs);
	const primaryInput = inputNames[0];
	if (!primaryInput) {
		throw new SurfaceInstallError(
			`manifest "${manifest.id}" has no inputs; nothing to wire from $ARGUMENTS`,
		);
	}
	const primaryInputSchema = manifest.inputs[primaryInput];
	if (primaryInputSchema?.type !== "string") {
		throw new SurfaceInstallError(
			`manifest "${manifest.id}": claude-skill surface only supports a string-typed primary input ` +
				`(got "${primaryInput}": ${primaryInputSchema?.type ?? "missing"})`,
		);
	}
	if (inputNames.length > 1) {
		throw new SurfaceInstallError(
			`manifest "${manifest.id}" declares multiple inputs (${inputNames.join(", ")}); ` +
				`claude-skill surface in PR6 supports exactly one string input`,
		);
	}

	const unknownAgents = findUnknownAgents(manifest, registry);
	if (unknownAgents.length > 0) {
		const lines = unknownAgents
			.map((u) => `  - participant "${u.participantId}" references unknown agent "${u.agentId}"`)
			.join("\n");
		throw new SurfaceInstallError(
			`manifest "${manifest.id}" references agents that are not in the registry:\n${lines}`,
		);
	}

	const gaps = findEnforcementGaps(manifest, registry);
	if (gaps.length > 0 && !allowUnenforced) {
		throw new SurfaceInstallError(
			`cannot enforce required permissions for "${manifest.id}":\n${formatEnforcementGaps(gaps)}\n\nPass allowUnenforcedPermissions=true to install anyway; the generated skill will warn on every run.`,
		);
	}

	const installName = opts.overrideName ?? manifest.id;
	const skillDir = join(outputDir, installName);
	if (existsSync(skillDir)) {
		if (!opts.force) {
			throw new SurfaceInstallError(
				`skill directory already exists: ${skillDir}\n\nPass force=true to remove and replace it, or use overrideName="<id>" to install with a different name (avoids overwriting an unrelated skill that happens to share this id).`,
			);
		}
		// force=true: rm -rf the existing directory. Necessary to ensure no
		// residual files from a prior install (or an unrelated skill that
		// happened to share this id) remain after install.
		rmSync(skillDir, { recursive: true, force: true });
	}
	mkdirSync(skillDir, { recursive: true });
	const skillMdPath = join(skillDir, "SKILL.md");
	const manifestPath = join(skillDir, "manifest.json");
	const markerPath = join(skillDir, INSTALL_MARKER_FILENAME);

	// Persist the raw (pre-normalization) manifest. The runner re-parses this
	// the same way as any other manifest file.
	const manifestJson = `${JSON.stringify(rawJson, null, 2)}\n`;
	writeFileSync(manifestPath, manifestJson);
	writeFileSync(
		skillMdPath,
		buildSkillMd({
			manifest,
			runtimePath,
			primaryInputName: primaryInput,
			allowUnenforced: gaps.length > 0,
			trace: opts.trace === true,
			heredocDelimiter: generateHeredocDelimiter(),
			installName,
		}),
	);

	// Write the install marker last so any earlier failure leaves the
	// directory in a partial-but-detectable state (no marker = "not a
	// confirmed chit install" from the uninstall side).
	const marker: InstallMarker = {
		schema: 1,
		surface: "claude-skill",
		installName,
		manifestId: manifest.id,
		runtimePath,
		installedAt: new Date().toISOString(),
		manifestHash: createHash("sha256").update(manifestJson).digest("hex"),
	};
	writeFileSync(markerPath, `${JSON.stringify(marker, null, 2)}\n`);

	return { skillDir, skillMdPath, manifestPath, markerPath, enforcementGaps: gaps };
}

// Random heredoc delimiter generated once per install. With 16 hex chars of
// entropy (64 bits), accidental collision with user input is astronomically
// unlikely. This does NOT protect against a deliberate attacker with read
// access to SKILL.md (they can simply read the delimiter and craft input
// that closes the heredoc); the threat model here is accidental collision,
// not a security boundary. A fundamentally safer transport would require
// Claude Code to expose user input as data rather than template-substituting
// it into shell source.
function generateHeredocDelimiter(): string {
	return `CHIT_INPUT_${randomBytes(8).toString("hex").toUpperCase()}_EOF`;
}

interface BuildOptions {
	manifest: ResolvedManifest;
	runtimePath: string;
	primaryInputName: string;
	allowUnenforced: boolean;
	trace: boolean;
	heredocDelimiter: string;
	installName: string;
}

function buildSkillMd(opts: BuildOptions): string {
	const {
		manifest,
		runtimePath,
		primaryInputName,
		allowUnenforced,
		trace,
		heredocDelimiter,
		installName,
	} = opts;
	const allowFlag = allowUnenforced ? `\\\n    --allow-unenforced-permissions ` : "";
	const traceFlag = trace ? `\\\n    --trace ` : "";

	// The fenced block uses ``` ```! ``` (NOT ``` ```bash ```). Claude Code's
	// preprocessor executes ``` ```! ``` blocks BEFORE rendering the skill into
	// the model's context, then substitutes the command's output in place. A
	// regular bash fence is just prompt content that Claude may or may not
	// choose to execute; empirically it often does not. The ``` ```! ``` fence
	// removes the model from the execution loop.
	//
	// The body:
	// 1. Fails fast if CLAUDE_SESSION_ID is missing. The skill claims
	//    can_provide_stable_scope; without a session id, the scope would
	//    collapse to worktree-only, letting unrelated Claude sessions share
	//    state. Refusing keeps the capability claim honest.
	// 2. Derives scope from CLAUDE_SESSION_ID + worktree hash.
	// 3. Invokes the shared chit runtime against the manifest.json that
	//    lives next to this SKILL.md.
	// 4. Pipes the user's $ARGUMENTS through a SINGLE-QUOTED heredoc to
	//    --input-stdin. Single quotes disable shell expansion inside the
	//    heredoc body, so quotes, $(...), backticks, and newlines in user
	//    text are treated as literal characters. Never interpolate
	//    $ARGUMENTS into a quoted command-line string; that path is a
	//    shell-injection hazard.
	// 5. Wraps everything in \`{ ... } 2>&1\` so stderr (the unenforced-
	//    permission WARNING and any failure messages) reaches the captured
	//    output. Skill-preprocessor stderr handling is undocumented at the
	//    time of writing; explicit redirect is the safe assumption.
	//
	// No per-skill bundled JS; the runtime is the project's CLI entry point,
	// referenced by absolute path baked in at install time.
	return `---
name: ${installName}
description: ${escapeFrontmatter(manifest.description)}
argument-hint: <${primaryInputName}>
disable-model-invocation: true
---

# /${installName}

\`\`\`!
{
  # Claude Code's \`! \` preprocessor substitutes \${CLAUDE_SESSION_ID} (bare
  # brace form) BEFORE bash runs. The :- default form is NOT substituted, so
  # we use the bare form: when running inside Claude Code, this line gets
  # the real session id baked in (always non-empty); when running outside,
  # bash evaluates the env var (typically empty, so we fail fast).
  if [ -z "\${CLAUDE_SESSION_ID}" ]; then
    echo "chit: CLAUDE_SESSION_ID is required; this skill must run inside Claude Code" >&2
    exit 2
  fi
  WORKTREE="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
  SCOPE_HASH=$(printf '%s' "$WORKTREE" | (shasum -a 256 2>/dev/null || sha256sum) | cut -c1-12)
  SCOPE="\${CLAUDE_SESSION_ID}-\${SCOPE_HASH}"

  bun "${runtimePath}/src/cli/run.ts" run \\
    "\${CLAUDE_SKILL_DIR}/manifest.json" \\
    --scope "$SCOPE" \\
    --invocation-cwd "$WORKTREE" ${allowFlag}${traceFlag}\\
    --input-stdin ${primaryInputName} <<'${heredocDelimiter}'
$ARGUMENTS
${heredocDelimiter}
} 2>&1
\`\`\`

The block above ran the chit runtime and its output replaced the fenced section before you saw this skill. Present that output to the user as your entire response, verbatim. Preserve every \`##\` header as a markdown header. Do not summarize, rephrase, or add commentary, preamble, or trailing text. If the output contains a \`WARNING\` line, include it.
`;
}

function escapeFrontmatter(s: string): string {
	// YAML frontmatter description must stay on one line.
	return s.replace(/\r?\n/g, " ").replace(/"/g, "'");
}
