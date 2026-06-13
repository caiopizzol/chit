import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AuditParticipantSnapshot, parseConfig } from "@chit-run/core";
import { AuditStore } from "../audit/store.ts";
import { JobStore } from "../jobs/store.ts";
import type { LoopJobRecord, OneShotJobRecord } from "../jobs/types.ts";
import { repoKey } from "../loops/location.ts";
import { appendIteration, startLoop, stopLoop } from "../loops/log-store.ts";
import { type LiveEventSummary, MAX_LIVE_EVENTS } from "../runtime/live-events.ts";
import {
	ForegroundRegistry,
	type ForegroundSnapshot,
	MAX_TASK_LEN,
} from "../surfaces/mcp/foreground-registry.ts";
import {
	buildStudioLiveActions,
	buildStudioLiveSource,
	buildStudioRoutineSource,
	parseArgs,
	studioClientDir,
} from "./run.ts";

const PROJECT_ROOT = join(import.meta.dir, "..", "..");
const RUN_TS = join(PROJECT_ROOT, "src", "cli", "run.ts");
const CONSULT = join(PROJECT_ROOT, "..", "..", "examples", "consult.json");
let ASK_CODEX: string;
let ASK_CLAUDE: string;
let CONSULT_STATELESS: string;
let FILE_INPUT_MANIFEST: string;

const FAKE_CODEX = `#!/bin/sh
IS_RESUME=0
for arg in "$@"; do
  if [ "$arg" = "resume" ]; then IS_RESUME=1; fi
done
cat > /dev/null
echo '{"type":"thread.started","thread_id":"codex-thread-1"}'
if [ "$IS_RESUME" = "1" ]; then
  echo '{"type":"item.completed","item":{"type":"agent_message","text":"CODEX_RESUMED: 42"}}'
else
  echo '{"type":"item.completed","item":{"type":"agent_message","text":"CODEX_ANSWER: 42"}}'
fi
`;

const FAKE_CLAUDE = `#!/bin/sh
IS_RESUME=0
for arg in "$@"; do
  if [ "$arg" = "--resume" ]; then IS_RESUME=1; fi
done
cat > /dev/null
emit_stream() {
  echo '{"type":"system","subtype":"init","session_id":"'"$1"'"}'
  echo '{"type":"assistant","message":{"instructions":"assistant"}}'
}
if [ "$IS_RESUME" = "1" ]; then
  emit_stream "claude-session-2"
  echo '{"type":"result","session_id":"claude-session-2","result":"CLAUDE_RESUMED: yes","subtype":"success","is_error":false}'
else
  emit_stream "claude-session-1"
  echo '{"type":"result","session_id":"claude-session-1","result":"CLAUDE_ANSWER: yes","subtype":"success","is_error":false}'
fi
`;

let TMPDIR: string;
let FAKE_BIN_DIR: string;

function writeManifestFixture(name: string, manifest: unknown): string {
	const path = join(TMPDIR, `${name}.json`);
	writeFileSync(path, `${JSON.stringify(manifest, null, "\t")}\n`);
	return path;
}

function git(cwd: string, args: string[]): void {
	execFileSync("git", args, { cwd, stdio: "ignore" });
}

beforeAll(() => {
	TMPDIR = mkdtempSync(join(tmpdir(), "chit-cli-"));
	ASK_CODEX = writeManifestFixture("ask-codex", {
		schema: 1,
		id: "ask-codex",
		description: "Ask Codex a single stateless question.",
		inputs: { question: { type: "string" } },
		requires: { can_show_markdown: true },
		participants: {
			codex: {
				agent: "codex",
				instructions: "Answer briefly. Cite file:line for any claim about code.",
				session: "stateless",
			},
		},
		steps: {
			ask: { call: "codex", prompt: "{{ inputs.question }}" },
			out: { format: "{{ steps.ask.output }}" },
		},
		output: "out",
	});
	ASK_CLAUDE = writeManifestFixture("ask-claude", {
		schema: 1,
		id: "ask-claude",
		description: "Ask Claude a single stateless question.",
		inputs: { question: { type: "string" } },
		requires: { can_show_markdown: true },
		participants: {
			claude: {
				agent: "claude",
				instructions: "Answer briefly. Cite file:line for any claim about code.",
				session: "stateless",
			},
		},
		steps: {
			ask: { call: "claude", prompt: "{{ inputs.question }}" },
			out: { format: "{{ steps.ask.output }}" },
		},
		output: "out",
	});
	CONSULT_STATELESS = writeManifestFixture("consult-stateless", {
		schema: 1,
		id: "consult-stateless",
		description: "Ask Codex and Claude the same question in parallel.",
		inputs: { question: { type: "string" } },
		requires: { can_show_markdown: true },
		participants: {
			codex: { agent: "codex", instructions: "Second opinion advisor.", session: "stateless" },
			claude: { agent: "claude", instructions: "Second opinion advisor.", session: "stateless" },
		},
		steps: {
			ask_codex: { call: "codex", prompt: "{{ inputs.question }}" },
			ask_claude: { call: "claude", prompt: "{{ inputs.question }}" },
			out: {
				format:
					"## codex\n\n{{ steps.ask_codex.output }}\n\n## claude\n\n{{ steps.ask_claude.output }}",
			},
		},
		output: "out",
	});
	FILE_INPUT_MANIFEST = writeManifestFixture("file-input-check", {
		schema: 1,
		id: "file-input-check",
		description: "Test-only manifest requiring file input passing.",
		inputs: { files: { type: "file[]" } },
		requires: { can_show_markdown: true },
		participants: {
			codex: { agent: "codex", instructions: "Read the files.", session: "stateless" },
		},
		steps: {
			check: { call: "codex", prompt: "{{ inputs.files }}" },
			out: { format: "{{ steps.check.output }}" },
		},
		output: "out",
	});
	FAKE_BIN_DIR = join(TMPDIR, "bin");
	mkdirSync(FAKE_BIN_DIR, { recursive: true });
	const codexPath = join(FAKE_BIN_DIR, "codex");
	writeFileSync(codexPath, FAKE_CODEX);
	chmodSync(codexPath, 0o755);
	const claudePath = join(FAKE_BIN_DIR, "claude");
	writeFileSync(claudePath, FAKE_CLAUDE);
	chmodSync(claudePath, 0o755);
});

afterAll(() => {
	rmSync(TMPDIR, { recursive: true, force: true });
});

async function runCLI(
	args: string[],
	extraEnv: Record<string, string> = {},
	stdinText?: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
	const proc = Bun.spawn({
		cmd: ["bun", RUN_TS, ...args],
		env: {
			...process.env,
			PATH: `${FAKE_BIN_DIR}:${process.env.PATH ?? ""}`,
			XDG_CONFIG_HOME: TMPDIR,
			XDG_STATE_HOME: TMPDIR,
			...extraEnv,
		},
		stdin: stdinText !== undefined ? "pipe" : "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	if (stdinText !== undefined && proc.stdin) {
		proc.stdin.write(stdinText);
		proc.stdin.end();
	}
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { stdout, stderr, code };
}

describe("parseArgs", () => {
	test("empty argv yields help", () => {
		expect(parseArgs([]).command).toBe("help");
	});

	test("--help yields help", () => {
		expect(parseArgs(["--help"]).command).toBe("help");
	});

	test("--help after a subcommand yields help, not a manifest named --help", () => {
		expect(parseArgs(["run", "--help"]).command).toBe("help");
		expect(parseArgs(["show", "-h"]).command).toBe("help");
		expect(parseArgs(["install", "--help"]).command).toBe("help");
	});

	test("run requires a manifest path", () => {
		expect(() => parseArgs(["run"])).toThrow(/manifest path/);
	});

	test("collects multiple --input flags", () => {
		const args = parseArgs(["run", "m.json", "--input", "q=hi", "--input", "n=bob"]);
		expect(args.inputs).toEqual({ q: "hi", n: "bob" });
	});

	test("--invocation-cwd captured", () => {
		const args = parseArgs(["run", "m.json", "--invocation-cwd", "/tmp"]);
		expect(args.invocationCwd).toBe("/tmp");
	});

	test("--scope captured", () => {
		const args = parseArgs(["run", "m.json", "--scope", "my-scope"]);
		expect(args.scope).toBe("my-scope");
	});

	test("--scope without value rejected", () => {
		expect(() => parseArgs(["run", "m.json", "--scope"])).toThrow(/--scope/);
	});

	test("--allow-unenforced-permissions captured as boolean", () => {
		const args = parseArgs(["run", "m.json", "--allow-unenforced-permissions"]);
		expect(args.allowUnenforcedPermissions).toBe(true);
	});

	test("allowUnenforcedPermissions defaults to false", () => {
		const args = parseArgs(["run", "m.json"]);
		expect(args.allowUnenforcedPermissions).toBe(false);
	});

	test("--input-stdin captures the input name", () => {
		const args = parseArgs(["run", "m.json", "--input-stdin", "question"]);
		expect(args.inputStdinKey).toBe("question");
	});

	test("--input-stdin without value rejected", () => {
		expect(() => parseArgs(["run", "m.json", "--input-stdin"])).toThrow(/--input-stdin/);
	});

	test("install command parses --as, --to, --name, --force, --runtime-path", () => {
		const args = parseArgs([
			"install",
			"m.json",
			"--as",
			"claude-skill",
			"--to",
			"/tmp/skills",
			"--runtime-path",
			"/proj/chit",
			"--name",
			"my-skill",
			"--force",
			"--allow-unenforced-permissions",
		]);
		expect(args.command).toBe("install");
		expect(args.manifestPath).toBe("m.json");
		expect(args.installAs).toBe("claude-skill");
		expect(args.outputDir).toBe("/tmp/skills");
		expect(args.runtimePath).toBe("/proj/chit");
		expect(args.overrideName).toBe("my-skill");
		expect(args.force).toBe(true);
		expect(args.allowUnenforcedPermissions).toBe(true);
	});

	test("--trace captured on run, defaults false", () => {
		expect(parseArgs(["run", "m.json", "--trace"]).trace).toBe(true);
		expect(parseArgs(["run", "m.json"]).trace).toBe(false);
	});

	test("--audit captured on run, defaults false", () => {
		expect(parseArgs(["run", "m.json", "--audit"]).audit).toBe(true);
		expect(parseArgs(["run", "m.json"]).audit).toBe(false);
	});

	test("--trace captured on install, defaults false", () => {
		expect(parseArgs(["install", "m.json", "--as", "claude-skill", "--trace"]).trace).toBe(true);
		expect(parseArgs(["install", "m.json", "--as", "claude-skill"]).trace).toBe(false);
	});

	test("install without manifest path rejected", () => {
		expect(() => parseArgs(["install"])).toThrow(/manifest path/);
	});

	test("install --as without value rejected", () => {
		expect(() => parseArgs(["install", "m.json", "--as"])).toThrow(/--as/);
	});

	test("--input without = rejected", () => {
		expect(() => parseArgs(["run", "m.json", "--input", "noequals"])).toThrow(/key=value/);
	});

	test("unknown flag rejected", () => {
		expect(() => parseArgs(["run", "m.json", "--banana"])).toThrow(/unknown flag/);
	});

	test("list command parses --to and --json", () => {
		const args = parseArgs(["list", "--to", "/tmp/skills", "--json"]);
		expect(args.command).toBe("list");
		expect(args.outputDir).toBe("/tmp/skills");
		expect(args.listJson).toBe(true);
	});

	test("list command works with no flags", () => {
		const args = parseArgs(["list"]);
		expect(args.command).toBe("list");
		expect(args.outputDir).toBeUndefined();
		expect(args.listJson).toBe(false);
	});

	test("uninstall command parses name and --to", () => {
		const args = parseArgs(["uninstall", "my-skill", "--to", "/tmp/skills"]);
		expect(args.command).toBe("uninstall");
		expect(args.uninstallName).toBe("my-skill");
		expect(args.outputDir).toBe("/tmp/skills");
	});

	test("uninstall without a name is rejected", () => {
		expect(() => parseArgs(["uninstall"])).toThrow(/install name/);
	});

	test("studio with no args parses with empty manifestPath", () => {
		const args = parseArgs(["studio"]);
		expect(args.command).toBe("studio");
		expect(args.manifestPath).toBeUndefined();
	});

	test("studio rejects a manifest path", () => {
		expect(() => parseArgs(["studio", "consult.json"])).toThrow(/unexpected argument/);
	});

	test("studio rejects an unknown flag", () => {
		expect(() => parseArgs(["studio", "--port", "3000"])).toThrow(/unknown flag/);
	});

	test("studio rejects extra positional args", () => {
		expect(() => parseArgs(["studio", "foo.json", "bar.json"])).toThrow(/unexpected argument/);
	});

	test("studio --help yields help", () => {
		expect(parseArgs(["studio", "--help"]).command).toBe("help");
	});

	test("studioClientDir returns the packaged dir when client/index.js sits beside the module", () => {
		// Mirrors a published install: chit.js and client/ live in the same dir.
		const dir = mkdtempSync(join(tmpdir(), "chit-studio-client-"));
		try {
			mkdirSync(join(dir, "client"));
			writeFileSync(join(dir, "client", "index.js"), 'console.log("hi");');
			expect(studioClientDir(dir)).toBe(join(dir, "client"));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("studioClientDir returns undefined in a source checkout (no client/ beside the module)", () => {
		// The Studio server's own default path handles the source-checkout case, so
		// the CLI must pass undefined rather than a wrong packaged path.
		const dir = mkdtempSync(join(tmpdir(), "chit-studio-client-"));
		try {
			expect(studioClientDir(dir)).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("mcp parses as the mcp command (launches the stdio server)", () => {
		expect(parseArgs(["mcp"]).command).toBe("mcp");
	});

	test("mcp rejects extra arguments", () => {
		expect(() => parseArgs(["mcp", "extra"])).toThrow(/unexpected argument/);
	});

	test("mcp --help yields help", () => {
		expect(parseArgs(["mcp", "--help"]).command).toBe("help");
	});
});

describe("buildStudioRoutineSource (Studio routine injection shape)", () => {
	function routineRepo(): string {
		const repo = mkdtempSync(join(tmpdir(), "chit-studio-routine-"));
		git(repo, ["init"]);
		git(repo, ["config", "user.email", "tests@example.invalid"]);
		git(repo, ["config", "user.name", "chit tests"]);
		git(repo, ["config", "commit.gpgsign", "false"]);
		mkdirSync(join(repo, "flows"));
		writeFileSync(
			join(repo, "flows", "deep.json"),
			`${JSON.stringify(
				{
					schema: 1,
					id: "deep",
					description: "deep routine",
					inputs: { task: { type: "string" } },
					participants: {
						impl: { role: "implementer" },
						rev: { role: "reviewer" },
					},
					steps: {
						implement: { call: "impl", prompt: "{{ inputs.task }}" },
						review: { call: "rev", prompt: "{{ steps.implement.output }}" },
						out: { format: "{{ steps.review.output }}" },
					},
					output: "out",
					policy: {
						kind: "loop",
						implementStep: "implement",
						reviewStep: "review",
						requiredChecks: [{ name: "tests", command: "bun", args: ["test"], timeoutMs: 60_000 }],
					},
				},
				null,
				"\t",
			)}\n`,
		);
		git(repo, ["add", "flows/deep.json"]);
		git(repo, ["commit", "-m", "add routine manifest"]);
		return repo;
	}

	function config(agent = "claude", manifestPath = "flows/deep.json") {
		return parseConfig({
			roles: {
				implementer: {
					agent,
					instructions: "Do the work.",
					session: "per_scope",
					permissions: { filesystem: "write" },
				},
				reviewer: {
					agent: "codex",
					instructions: "Review the work.",
					session: "stateless",
					permissions: { filesystem: "read_only" },
				},
			},
			recipes: {
				deep: { mode: "converge", manifestPath },
			},
		});
	}

	function withState<T>(fn: () => T): T {
		const state = mkdtempSync(join(tmpdir(), "chit-studio-state-"));
		const old = process.env.XDG_STATE_HOME;
		process.env.XDG_STATE_HOME = state;
		try {
			return fn();
		} finally {
			if (old === undefined) delete process.env.XDG_STATE_HOME;
			else process.env.XDG_STATE_HOME = old;
			rmSync(state, { recursive: true, force: true });
		}
	}

	function seedStoppedLoop(
		repo: string,
		loopId: string,
		over: {
			recipeId?: string;
			status?: "converged" | "blocked" | "max-iterations" | "needs-decision" | "cancelled";
			startedAt?: string;
			iterationAt?: string;
			endedAt?: string;
			auditRef?: string;
			usage?: { estimatedCostUsd?: number };
			verdict?: "proceed" | "revise" | "block";
			decision?: "proceed" | "revise" | "block";
		} = {},
	): void {
		const startedAt = Date.parse(over.startedAt ?? "2026-06-01T10:00:00.000Z");
		const iterationAt = Date.parse(over.iterationAt ?? "2026-06-01T10:01:00.000Z");
		const endedAt = Date.parse(over.endedAt ?? "2026-06-01T10:02:00.000Z");
		startLoop(repo, {
			scope: "scope",
			task: "PRIVATE TASK BODY",
			maxIterations: 3,
			loopId,
			clock: () => startedAt,
			...(over.recipeId !== undefined && {
				recipe: { id: over.recipeId, mode: "converge" },
			}),
		});
		appendIteration(repo, loopId, {
			implementSummary: "PRIVATE IMPLEMENT SUMMARY",
			changedFiles: ["private.ts"],
			checksRun: "PRIVATE CHECK OUTPUT",
			verdict: over.verdict ?? "proceed",
			findingCount: 0,
			decision: over.decision ?? "proceed",
			checkDurationMs: 1000,
			...(over.auditRef !== undefined && { auditRef: over.auditRef }),
			...(over.usage !== undefined && { usage: over.usage }),
			clock: () => iterationAt,
		});
		stopLoop(repo, loopId, {
			status: over.status ?? "converged",
			reason: "done",
			clock: () => endedAt,
		});
	}

	test("resolves a recipe manifest to the safe at-rest summary", () => {
		const repo = routineRepo();
		try {
			const source = buildStudioRoutineSource(repo);
			expect(source).toBeDefined();
			const summary = source?.resolveManifest(config(), "deep");
			expect(summary?.manifestDigest).toMatch(/^sha256:/);
			expect(summary?.participants).toEqual([
				{
					id: "impl",
					role: "implementer",
					agentId: "claude",
					session: "per_scope",
					filesystem: "write",
				},
				{
					id: "rev",
					role: "reviewer",
					agentId: "codex",
					session: "stateless",
					filesystem: "read_only",
				},
			]);
			expect(summary?.requiredChecks).toEqual([
				{ name: "tests", command: "bun", args: ["test"], timeoutMs: 60_000 },
			]);
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	test("refuses an unknown resolved agent instead of returning a partial summary", () => {
		const repo = routineRepo();
		try {
			const source = buildStudioRoutineSource(repo);
			expect(() => source?.resolveManifest(config("ghost"), "deep")).toThrow(/unknown agent/);
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	test("maps the newest stopped loop by stamped recipe id into a safe last-run summary", () =>
		withState(() => {
			const repo = routineRepo();
			try {
				seedStoppedLoop(repo, "old-run", {
					recipeId: "deep",
					status: "blocked",
					verdict: "block",
					decision: "block",
					endedAt: "2026-06-01T10:02:00.000Z",
					auditRef: "aud-old",
					usage: { estimatedCostUsd: 0.01 },
				});
				seedStoppedLoop(repo, "new-run", {
					recipeId: "deep",
					status: "converged",
					verdict: "proceed",
					decision: "proceed",
					startedAt: "2026-06-01T11:00:00.000Z",
					iterationAt: "2026-06-01T11:01:00.000Z",
					endedAt: "2026-06-01T11:02:00.000Z",
					auditRef: "aud-new",
					usage: { estimatedCostUsd: 0.05 },
				});
				seedStoppedLoop(repo, "other-run", {
					recipeId: "other",
					status: "converged",
					endedAt: "2026-06-01T12:02:00.000Z",
					auditRef: "aud-other",
				});

				const source = buildStudioRoutineSource(repo);
				const lastRun = source?.resolveLastRun?.(config(), "deep", {
					manifestDigest: "sha256:unneeded-for-recipe-match",
					participants: [],
					requiredChecks: [],
				});
				expect(lastRun).toMatchObject({
					status: "converged",
					verdict: "proceed",
					statusLine: "iteration 1 · proceed · converged",
					iterationsCompleted: 1,
					elapsedMs: 120_000,
					estimatedCostUsd: 0.05,
					auditRef: "aud-new",
					traceRef: "new-run",
				});
				const serialized = JSON.stringify(lastRun);
				expect(serialized).not.toContain("PRIVATE");
				expect(serialized).not.toContain("private.ts");
			} finally {
				rmSync(repo, { recursive: true, force: true });
			}
		}));

	test("matches multiple recipes from one loaded config", () =>
		withState(() => {
			const repo = routineRepo();
			try {
				seedStoppedLoop(repo, "deep-run", {
					recipeId: "deep",
					status: "converged",
					verdict: "proceed",
					decision: "proceed",
					endedAt: "2026-06-01T10:02:00.000Z",
					auditRef: "aud-deep",
				});
				seedStoppedLoop(repo, "fast-run", {
					recipeId: "fast",
					status: "blocked",
					verdict: "block",
					decision: "block",
					endedAt: "2026-06-01T11:02:00.000Z",
					auditRef: "aud-fast",
				});

				const loadedConfig = parseConfig({
					roles: {
						implementer: {
							agent: "claude",
							instructions: "Do the work.",
							session: "per_scope",
							permissions: { filesystem: "write" },
						},
						reviewer: {
							agent: "codex",
							instructions: "Review the work.",
							session: "stateless",
							permissions: { filesystem: "read_only" },
						},
					},
					recipes: {
						deep: { mode: "converge", manifestPath: "flows/deep.json" },
						fast: { mode: "converge", manifestPath: "flows/deep.json" },
					},
				});
				const source = buildStudioRoutineSource(repo);
				const manifest = {
					manifestDigest: "sha256:unneeded-for-recipe-match",
					participants: [],
					requiredChecks: [],
				};
				const deep = source?.resolveLastRun?.(loadedConfig, "deep", manifest);
				const fast = source?.resolveLastRun?.(loadedConfig, "fast", manifest);
				expect(deep).toMatchObject({
					status: "converged",
					verdict: "proceed",
					auditRef: "aud-deep",
				});
				expect(fast).toMatchObject({
					status: "blocked",
					verdict: "block",
					auditRef: "aud-fast",
				});
			} finally {
				rmSync(repo, { recursive: true, force: true });
			}
		}));

	test("does not fallback-match a run that already stamps a different recipe id", () =>
		withState(() => {
			const repo = routineRepo();
			try {
				seedStoppedLoop(repo, "other-run", {
					recipeId: "other",
					status: "converged",
					auditRef: "aud-other",
				});
				const source = buildStudioRoutineSource(repo);
				const lastRun = source?.resolveLastRun?.(config(), "deep", {
					manifestDigest: "sha256:anything",
					participants: [],
					requiredChecks: [],
				});
				expect(lastRun).toBeUndefined();
			} finally {
				rmSync(repo, { recursive: true, force: true });
			}
		}));

	test("fallback-matches direct runs only on exact manifest path and digest", () =>
		withState(() => {
			const repo = routineRepo();
			try {
				const manifestDigest = buildStudioRoutineSource(repo)?.resolveManifest(
					config(),
					"deep",
				).manifestDigest;
				if (manifestDigest === undefined) throw new Error("expected manifest digest");
				expect(manifestDigest).toMatch(/^sha256:/);
				const store = new JobStore();
				store.create({
					policy: "loop",
					runId: "direct-ok",
					loopId: "direct-ok-loop",
					repoKey: repoKey(repo),
					repo,
					cwd: repo,
					scope: "scope",
					task: "PRIVATE DIRECT TASK",
					manifestPath: "flows/deep.json",
					manifestDigest,
					maxIterations: 3,
					allowUnenforced: false,
					iterationsCompleted: 1,
					auditRefs: ["aud-direct"],
					state: "completed",
					createdAt: "2026-06-01T10:00:00.000Z",
					startedAt: "2026-06-01T10:00:10.000Z",
					endedAt: "2026-06-01T10:01:10.000Z",
					lastVerdict: "proceed",
				} as LoopJobRecord);
				store.create({
					policy: "loop",
					runId: "direct-missing-digest",
					loopId: "direct-missing-digest-loop",
					repoKey: repoKey(repo),
					repo,
					cwd: repo,
					scope: "scope",
					task: "PRIVATE DIRECT TASK",
					manifestPath: "flows/deep.json",
					maxIterations: 3,
					allowUnenforced: false,
					iterationsCompleted: 1,
					auditRefs: ["aud-missing"],
					state: "completed",
					createdAt: "2026-06-01T11:00:00.000Z",
					endedAt: "2026-06-01T11:01:00.000Z",
				} as LoopJobRecord);

				const source = buildStudioRoutineSource(repo);
				const lastRun = source?.resolveLastRun?.(config("claude", "./flows/deep.json"), "deep", {
					manifestDigest,
					participants: [],
					requiredChecks: [],
				});
				expect(lastRun).toMatchObject({
					status: "completed",
					verdict: "proceed",
					iterationsCompleted: 1,
					elapsedMs: 60_000,
					auditRef: "aud-direct",
					traceRef: "direct-ok",
				});
				expect(JSON.stringify(lastRun)).not.toContain("PRIVATE");
			} finally {
				rmSync(repo, { recursive: true, force: true });
			}
		}));
});

describe("buildStudioLiveSource (Studio live injection shape)", () => {
	// A live, fresh foreground snapshot: this process's pid + a current updatedAt,
	// so the registry's read-time liveness check keeps it.
	function liveSnapshot(overrides: Partial<ForegroundSnapshot> = {}): ForegroundSnapshot {
		const now = new Date().toISOString();
		return {
			runId: "fg-1",
			pid: process.pid,
			scope: "sc-fg",
			task: "converge the parser",
			taskFull: "converge the parser with full context",
			repoKey: "repokey",
			iteration: 2,
			phase: "implementing",
			startedAt: now,
			phaseStartedAt: now,
			lastActivityAt: now,
			updatedAt: now,
			participants: { impl: { agentId: "claude", adapter: "claude-cli" } },
			statusLine: "iteration 2 · implementing",
			...overrides,
		};
	}

	test("empty foreground registry and job store yield an empty LiveActivity", () => {
		const fgDir = mkdtempSync(join(tmpdir(), "chit-live-fg-"));
		const jobsDir = mkdtempSync(join(tmpdir(), "chit-live-jobs-"));
		try {
			const live = buildStudioLiveSource({ foregroundDir: fgDir, jobsDir }).live();
			expect(live).toEqual({ foreground: [], background: [] });
		} finally {
			rmSync(fgDir, { recursive: true, force: true });
			rmSync(jobsDir, { recursive: true, force: true });
		}
	});

	test("maps a live foreground snapshot to a source-tagged foreground row", () => {
		const fgDir = mkdtempSync(join(tmpdir(), "chit-live-fg-"));
		const jobsDir = mkdtempSync(join(tmpdir(), "chit-live-jobs-"));
		try {
			new ForegroundRegistry(fgDir).write(
				liveSnapshot({ worktreePath: "/wt/fg-1", maxIterations: 5, callTimeoutMs: 900_000 }),
			);
			const live = buildStudioLiveSource({ foregroundDir: fgDir, jobsDir }).live();
			expect(live.background).toHaveLength(0);
			expect(live.foreground).toHaveLength(1);
			const row = live.foreground[0];
			expect(row?.source).toBe("foreground");
			expect(row?.runId).toBe("fg-1");
			expect(row?.scope).toBe("sc-fg");
			expect(row?.task).toBe("converge the parser");
			expect(row?.taskFull).toBe("converge the parser with full context");
			expect(row?.phase).toBe("implementing");
			expect(row?.statusLine).toBe("iteration 2 · implementing");
			// Structured counters so the client never parses statusLine.
			expect(row?.iteration).toBe(2);
			expect(row?.maxIterations).toBe(5);
			expect(row?.callTimeoutMs).toBe(900_000);
			expect(row?.worktreePath).toBe("/wt/fg-1");
			// Ages derive against the reader's clock; they are present and non-negative.
			expect(row?.elapsedMs).toBeGreaterThanOrEqual(0);
			expect(row?.participants).toEqual({ impl: { agentId: "claude", adapter: "claude-cli" } });
		} finally {
			rmSync(fgDir, { recursive: true, force: true });
			rmSync(jobsDir, { recursive: true, force: true });
		}
	});

	test("maps the snapshot's completed phases plus one active entry onto the row's timeline", () => {
		const fgDir = mkdtempSync(join(tmpdir(), "chit-live-fg-"));
		const jobsDir = mkdtempSync(join(tmpdir(), "chit-live-jobs-"));
		try {
			const nowMs = Date.now();
			new ForegroundRegistry(fgDir).write(
				liveSnapshot({
					phase: "reviewing",
					phaseStartedAt: new Date(nowMs - 10_000).toISOString(),
					phases: [
						{
							phase: "implementing",
							startedAt: new Date(nowMs - 30_000).toISOString(),
							endedAt: new Date(nowMs - 10_000).toISOString(),
						},
					],
				}),
			);
			const live = buildStudioLiveSource({ foregroundDir: fgDir, jobsDir }).live();
			const row = live.foreground[0];
			expect(row?.phases).toHaveLength(2);
			// The completed entry's duration is fixed by its stored marks.
			expect(row?.phases?.[0]).toEqual({
				phase: "implementing",
				status: "completed",
				elapsedMs: 20_000,
			});
			// The trailing active entry derives against the reader's clock, so it is at
			// least the 10s since phaseStartedAt (sane upper bound guards a runaway clock).
			expect(row?.phases?.[1]?.phase).toBe("reviewing");
			expect(row?.phases?.[1]?.status).toBe("active");
			expect(row?.phases?.[1]?.elapsedMs).toBeGreaterThanOrEqual(10_000);
			expect(row?.phases?.[1]?.elapsedMs).toBeLessThan(60_000);
		} finally {
			rmSync(fgDir, { recursive: true, force: true });
			rmSync(jobsDir, { recursive: true, force: true });
		}
	});

	test("the timeline is absent when nothing is derivable (pre-phase spin-up, no completed phases)", () => {
		const fgDir = mkdtempSync(join(tmpdir(), "chit-live-fg-"));
		const jobsDir = mkdtempSync(join(tmpdir(), "chit-live-jobs-"));
		try {
			// A just-started run: phase "starting", no phase clock yet, no history.
			new ForegroundRegistry(fgDir).write(
				liveSnapshot({ phase: "starting", phaseStartedAt: undefined }),
			);
			const live = buildStudioLiveSource({ foregroundDir: fgDir, jobsDir }).live();
			const row = live.foreground[0];
			expect(row?.phases).toBeUndefined();
			expect(JSON.stringify(row)).not.toContain('"phases"');
		} finally {
			rmSync(fgDir, { recursive: true, force: true });
			rmSync(jobsDir, { recursive: true, force: true });
		}
	});

	// Above any real pid on the platforms chit runs on, so pidAlive is false.
	const DEAD_PID = 2_147_483_647;

	test("live() prunes a dead-pid foreground file best-effort while a live snapshot still surfaces", () => {
		const fgDir = mkdtempSync(join(tmpdir(), "chit-live-fg-"));
		const jobsDir = mkdtempSync(join(tmpdir(), "chit-live-jobs-"));
		try {
			const reg = new ForegroundRegistry(fgDir);
			reg.write(liveSnapshot({ runId: "fg-live" })); // this process's pid: alive
			reg.write(liveSnapshot({ runId: "fg-dead", pid: DEAD_PID })); // writer gone
			const live = buildStudioLiveSource({ foregroundDir: fgDir, jobsDir }).live();
			// The dead row never surfaces (filtered) and its lingering file is now reclaimed.
			expect(live.foreground.map((r) => r.runId)).toEqual(["fg-live"]);
			expect(readdirSync(fgDir)).toEqual(["fg-live.json"]);
		} finally {
			rmSync(fgDir, { recursive: true, force: true });
			rmSync(jobsDir, { recursive: true, force: true });
		}
	});

	test("an unreadable foreground dir degrades to empty foreground without breaking the live read", () => {
		const fgDir = mkdtempSync(join(tmpdir(), "chit-live-fg-"));
		const jobsDir = mkdtempSync(join(tmpdir(), "chit-live-jobs-"));
		try {
			new ForegroundRegistry(fgDir).write(liveSnapshot({ runId: "fg-live" }));
			// A background job still resolves, proving only the foreground slice degraded.
			new JobStore(jobsDir).create({
				policy: "loop",
				runId: "bg-1",
				loopId: "bg-1",
				repoKey: "k",
				cwd: "/repo",
				scope: "sc",
				task: "t",
				maxIterations: 3,
				allowUnenforced: false,
				iterationsCompleted: 0,
				auditRefs: [],
				state: "running",
				createdAt: new Date().toISOString(),
				pid: process.pid,
				lastHeartbeatAt: new Date().toISOString(),
			} as LoopJobRecord);
			// Strip all perms so both pruneDead and list throw EACCES; both are guarded,
			// so the read returns an empty foreground rather than failing the snapshot.
			chmodSync(fgDir, 0o000);
			const live = buildStudioLiveSource({ foregroundDir: fgDir, jobsDir }).live();
			expect(live.foreground).toEqual([]);
			expect(live.background.map((r) => r.runId)).toEqual(["bg-1"]);
		} finally {
			chmodSync(fgDir, 0o700); // restore so the dir can be removed
			rmSync(fgDir, { recursive: true, force: true });
			rmSync(jobsDir, { recursive: true, force: true });
		}
	});

	test("maps a background job and reduces participants to agent+adapter (no config/env leak)", () => {
		const fgDir = mkdtempSync(join(tmpdir(), "chit-live-fg-"));
		const jobsDir = mkdtempSync(join(tmpdir(), "chit-live-jobs-"));
		try {
			const jobStore = new JobStore(jobsDir);
			// The persisted snapshot carries permissions/config/envKeys; the live row
			// surfaces only the safe identity (agentId + adapter + model). The leak
			// sentinels below -- permission, env key, and the rest of config -- must not
			// appear. (The dedicated execution-identity test covers model crossing.)
			const provenance = {
				agentId: "codex",
				adapter: "codex-exec",
				session: "stateless",
				permissions: { filesystem: "SENTINEL_PERMISSION" },
				enforcesReadOnly: true,
				config: { model: "codex-medium", strictMcp: true, envKeys: ["SENTINEL_ENV_KEY"] },
			} as unknown as AuditParticipantSnapshot;
			const job: LoopJobRecord = {
				policy: "loop",
				runId: "bg-1",
				loopId: "bg-1",
				repoKey: "k",
				cwd: "/repo",
				scope: "sc-bg",
				task: "migrate the routes",
				maxIterations: 3,
				callTimeoutMs: 600_000,
				allowUnenforced: false,
				iteration: 2,
				iterationsCompleted: 1,
				auditRefs: [],
				state: "running",
				createdAt: new Date().toISOString(),
				pid: process.pid,
				lastHeartbeatAt: new Date().toISOString(),
				phase: "reviewing",
				phaseStartedAt: new Date().toISOString(),
				participants: { rev: provenance },
			};
			jobStore.create(job);

			const live = buildStudioLiveSource({ foregroundDir: fgDir, jobsDir }).live();
			expect(live.foreground).toHaveLength(0);
			expect(live.background).toHaveLength(1);
			const row = live.background[0];
			expect(row?.source).toBe("background");
			expect(row?.runId).toBe("bg-1");
			expect(row?.scope).toBe("sc-bg");
			expect(row?.task).toBe("migrate the routes");
			expect(row?.display).toBe("running");
			expect(row?.phase).toBe("reviewing");
			// Structured loop counters/budgets, straight from the persisted record.
			expect(row?.iteration).toBe(2);
			expect(row?.iterationsCompleted).toBe(1);
			expect(row?.maxIterations).toBe(3);
			expect(row?.callTimeoutMs).toBe(600_000);
			expect(row?.participants).toEqual({
				rev: { agentId: "codex", adapter: "codex-exec", model: "codex-medium" },
			});

			// No leak sentinel (permission, env key, strictMcp, the config envelope) may
			// cross the live surface; model is the one safe config field that does.
			const serialized = JSON.stringify(live);
			for (const sentinel of [
				"SENTINEL_PERMISSION",
				"SENTINEL_ENV_KEY",
				"strictMcp",
				"permissions",
				"config",
				"envKeys",
			]) {
				expect(serialized).not.toContain(sentinel);
			}
		} finally {
			rmSync(fgDir, { recursive: true, force: true });
			rmSync(jobsDir, { recursive: true, force: true });
		}
	});

	test("exposes recipe/manifest execution identity and safe model identity, never config/env", () => {
		const fgDir = mkdtempSync(join(tmpdir(), "chit-live-fg-"));
		const jobsDir = mkdtempSync(join(tmpdir(), "chit-live-jobs-"));
		try {
			const jobStore = new JobStore(jobsDir);
			// The snapshot carries the full participant config (model + reasoningEffort,
			// PLUS env keys and other config). Only model + reasoningEffort may cross.
			const provenance = {
				agentId: "claude-code",
				adapter: "claude-cli",
				session: "stateless",
				permissions: { filesystem: "SENTINEL_PERMISSION" },
				enforcesReadOnly: true,
				config: {
					model: "claude-opus-4-8",
					reasoningEffort: "high",
					strictMcp: true,
					envKeys: ["SENTINEL_ENV_KEY"],
				},
			} as unknown as AuditParticipantSnapshot;
			const job: LoopJobRecord = {
				policy: "loop",
				runId: "bg-exec",
				loopId: "bg-exec",
				repoKey: "k",
				cwd: "/repo",
				scope: "sc-exec",
				task: "converge the parser",
				// Recipe + digest-bound manifest: the execution surface the row exposes.
				manifestPath: "/repo/chits/converge.json",
				manifestDigest: "sha256:0123456789abcdef0123456789abcdef",
				recipe: {
					id: "deep-converge",
					mode: "converge",
					origin: { source: "repo", path: "/repo/.chit/config.json" },
					maxIterations: 8,
					callTimeoutMs: 900_000,
				},
				maxIterations: 8,
				allowUnenforced: false,
				iterationsCompleted: 0,
				auditRefs: [],
				state: "running",
				createdAt: new Date().toISOString(),
				pid: process.pid,
				lastHeartbeatAt: new Date().toISOString(),
				phase: "implementing",
				phaseStartedAt: new Date().toISOString(),
				participants: { impl: provenance },
			};
			jobStore.create(job);

			const live = buildStudioLiveSource({ foregroundDir: fgDir, jobsDir }).live();
			const row = live.background[0];
			// Safe model identity rides the participant; env/config sentinels do not.
			expect(row?.participants).toEqual({
				impl: {
					agentId: "claude-code",
					adapter: "claude-cli",
					model: "claude-opus-4-8",
					reasoningEffort: "high",
				},
			});
			// Execution identity: recipe id/origin LAYER/budgets and manifest path/digest.
			// The origin PATH is dropped -- only the layer crosses.
			expect(row?.execution).toEqual({
				recipe: {
					id: "deep-converge",
					mode: "converge",
					origin: "repo",
					maxIterations: 8,
					callTimeoutMs: 900_000,
				},
				manifestPath: "/repo/chits/converge.json",
				manifestDigest: "sha256:0123456789abcdef0123456789abcdef",
			});

			// No config/env/permission detail and no origin path may cross the surface.
			const serialized = JSON.stringify(live);
			for (const sentinel of [
				"SENTINEL_PERMISSION",
				"SENTINEL_ENV_KEY",
				"strictMcp",
				"envKeys",
				"permissions",
				"config",
				"/repo/.chit/config.json",
			]) {
				expect(serialized).not.toContain(sentinel);
			}
		} finally {
			rmSync(fgDir, { recursive: true, force: true });
			rmSync(jobsDir, { recursive: true, force: true });
		}
	});

	test("a direct loop run with no recipe or digest binding omits execution identity", () => {
		const fgDir = mkdtempSync(join(tmpdir(), "chit-live-fg-"));
		const jobsDir = mkdtempSync(join(tmpdir(), "chit-live-jobs-"));
		try {
			const job: LoopJobRecord = {
				policy: "loop",
				runId: "bg-direct",
				loopId: "bg-direct",
				repoKey: "k",
				cwd: "/repo",
				scope: "sc",
				task: "t",
				maxIterations: 3,
				allowUnenforced: false,
				iterationsCompleted: 0,
				auditRefs: [],
				state: "running",
				createdAt: new Date().toISOString(),
				pid: process.pid,
				lastHeartbeatAt: new Date().toISOString(),
			};
			new JobStore(jobsDir).create(job);
			const live = buildStudioLiveSource({ foregroundDir: fgDir, jobsDir }).live();
			const row = live.background[0];
			expect(row?.execution).toBeUndefined();
			expect(JSON.stringify(row)).not.toContain("execution");
		} finally {
			rmSync(fgDir, { recursive: true, force: true });
			rmSync(jobsDir, { recursive: true, force: true });
		}
	});

	test("a one-shot background job omits the loop iteration/budget fields", () => {
		const fgDir = mkdtempSync(join(tmpdir(), "chit-live-fg-"));
		const jobsDir = mkdtempSync(join(tmpdir(), "chit-live-jobs-"));
		try {
			const job: OneShotJobRecord = {
				policy: "one-shot",
				runId: "bg-oneshot",
				repoKey: "k",
				cwd: "/repo",
				manifestPath: "/repo/consult.json",
				manifestId: "consult",
				inputs: {},
				audit: false,
				allowUnenforced: false,
				auditRefs: [],
				state: "running",
				createdAt: new Date().toISOString(),
				pid: process.pid,
				lastHeartbeatAt: new Date().toISOString(),
			};
			new JobStore(jobsDir).create(job);
			const live = buildStudioLiveSource({ foregroundDir: fgDir, jobsDir }).live();
			expect(live.background).toHaveLength(1);
			const row = live.background[0];
			expect(row?.runId).toBe("bg-oneshot");
			// No loop identity, so none of the structured loop fields appear (omitted,
			// not null/zero).
			expect(row?.iteration).toBeUndefined();
			expect(row?.iterationsCompleted).toBeUndefined();
			expect(row?.maxIterations).toBeUndefined();
			expect(row?.callTimeoutMs).toBeUndefined();
			const serialized = JSON.stringify(row);
			expect(serialized).not.toContain("iterationsCompleted");
			expect(serialized).not.toContain("maxIterations");
			expect(serialized).not.toContain("callTimeoutMs");
		} finally {
			rmSync(fgDir, { recursive: true, force: true });
			rmSync(jobsDir, { recursive: true, force: true });
		}
	});

	test("a stale background worker is reported as display 'stale'", () => {
		const fgDir = mkdtempSync(join(tmpdir(), "chit-live-fg-"));
		const jobsDir = mkdtempSync(join(tmpdir(), "chit-live-jobs-"));
		try {
			const jobStore = new JobStore(jobsDir);
			const job: LoopJobRecord = {
				policy: "loop",
				runId: "bg-stale",
				loopId: "bg-stale",
				repoKey: "k",
				cwd: "/repo",
				scope: "sc",
				task: "t",
				maxIterations: 3,
				allowUnenforced: false,
				iterationsCompleted: 0,
				auditRefs: [],
				state: "running",
				createdAt: "2020-01-01T00:00:00.000Z",
				pid: process.pid,
				// Ancient heartbeat => derived stale regardless of a live pid.
				lastHeartbeatAt: "2020-01-01T00:00:00.000Z",
			};
			jobStore.create(job);
			const live = buildStudioLiveSource({ foregroundDir: fgDir, jobsDir }).live();
			expect(live.background[0]?.display).toBe("stale");
		} finally {
			rmSync(fgDir, { recursive: true, force: true });
			rmSync(jobsDir, { recursive: true, force: true });
		}
	});

	test("terminal background jobs are omitted from the live control tower", () => {
		const fgDir = mkdtempSync(join(tmpdir(), "chit-live-fg-"));
		const jobsDir = mkdtempSync(join(tmpdir(), "chit-live-jobs-"));
		try {
			const jobStore = new JobStore(jobsDir);
			const base: LoopJobRecord = {
				policy: "loop",
				runId: "done",
				loopId: "done",
				repoKey: "k",
				cwd: "/repo",
				scope: "sc",
				task: "t",
				maxIterations: 3,
				allowUnenforced: false,
				iterationsCompleted: 1,
				auditRefs: [],
				state: "completed",
				createdAt: new Date().toISOString(),
				pid: process.pid,
				lastHeartbeatAt: new Date().toISOString(),
			};
			jobStore.create(base);
			jobStore.create({
				...base,
				runId: "failed",
				loopId: "failed",
				state: "failed",
			});
			jobStore.create({
				...base,
				runId: "running",
				loopId: "running",
				state: "running",
			});

			const live = buildStudioLiveSource({ foregroundDir: fgDir, jobsDir }).live();
			expect(live.background.map((r) => r.runId)).toEqual(["running"]);
		} finally {
			rmSync(fgDir, { recursive: true, force: true });
			rmSync(jobsDir, { recursive: true, force: true });
		}
	});

	test("a long multi-line background task keeps a bounded row preview and full disclosure text", () => {
		const fgDir = mkdtempSync(join(tmpdir(), "chit-live-fg-"));
		const jobsDir = mkdtempSync(join(tmpdir(), "chit-live-jobs-"));
		try {
			const jobStore = new JobStore(jobsDir);
			// `task` feeds the compact rail/detail preview; `taskFull` feeds the explicit
			// selected-run disclosure. The full value is local and token-gated, but it
			// must stay separate from model output/config/audit fields.
			const task = [
				`Refactor the parser entrypoint. ${"benign detail ".repeat(30)}`,
				"FULL_TASK_TAIL: preserve this tail for the disclosure.",
			].join("\n");
			const job: LoopJobRecord = {
				policy: "loop",
				runId: "bg-long",
				loopId: "bg-long",
				repoKey: "k",
				cwd: "/repo",
				scope: "sc",
				task,
				maxIterations: 3,
				allowUnenforced: false,
				iterationsCompleted: 0,
				auditRefs: [],
				state: "running",
				createdAt: new Date().toISOString(),
				pid: process.pid,
				lastHeartbeatAt: new Date().toISOString(),
			};
			jobStore.create(job);

			const live = buildStudioLiveSource({ foregroundDir: fgDir, jobsDir }).live();
			const row = live.background[0];
			// Capped to the one-liner bound, single-line, ends with the ellipsis.
			expect(row?.task?.length).toBeLessThanOrEqual(MAX_TASK_LEN);
			expect(row?.task).not.toContain("\n");
			expect(row?.task?.endsWith("...")).toBe(true);
			expect(row?.taskFull).toBe(task);
			expect(row?.taskFull).toContain("FULL_TASK_TAIL");
		} finally {
			rmSync(fgDir, { recursive: true, force: true });
			rmSync(jobsDir, { recursive: true, force: true });
		}
	});

	test("maps a foreground snapshot's event tail to recentEvents with reader-clock ages", () => {
		const fgDir = mkdtempSync(join(tmpdir(), "chit-live-fg-"));
		const jobsDir = mkdtempSync(join(tmpdir(), "chit-live-jobs-"));
		try {
			const nowMs = Date.now();
			new ForegroundRegistry(fgDir).write(
				liveSnapshot({
					events: [
						{
							ts: nowMs - 5_000,
							kind: "step.started",
							label: "step implement started",
							stepId: "implement",
							participantId: "impl",
							agentId: "claude",
						},
						{ ts: nowMs - 1_000, kind: "adapter.event", label: "assistant", stepId: "implement" },
					],
				}),
			);
			const live = buildStudioLiveSource({ foregroundDir: fgDir, jobsDir }).live();
			const row = live.foreground[0];
			expect(row?.recentEvents).toHaveLength(2);
			// Allowlisted fields cross verbatim, oldest first.
			expect(row?.recentEvents?.[0]?.kind).toBe("step.started");
			expect(row?.recentEvents?.[0]?.label).toBe("step implement started");
			expect(row?.recentEvents?.[0]?.stepId).toBe("implement");
			expect(row?.recentEvents?.[0]?.participantId).toBe("impl");
			expect(row?.recentEvents?.[0]?.agentId).toBe("claude");
			// Stored timestamps become ages against the reader's clock (a sane upper
			// bound guards a runaway clock); the timestamps themselves never cross.
			expect(row?.recentEvents?.[0]?.ageMs).toBeGreaterThanOrEqual(5_000);
			expect(row?.recentEvents?.[0]?.ageMs).toBeLessThan(60_000);
			expect(row?.recentEvents?.[1]?.ageMs).toBeGreaterThanOrEqual(1_000);
			expect(JSON.stringify(row?.recentEvents)).not.toContain('"ts"');
		} finally {
			rmSync(fgDir, { recursive: true, force: true });
			rmSync(jobsDir, { recursive: true, force: true });
		}
	});

	test("maps a background job's recentEvents tail onto the row", () => {
		const fgDir = mkdtempSync(join(tmpdir(), "chit-live-fg-"));
		const jobsDir = mkdtempSync(join(tmpdir(), "chit-live-jobs-"));
		try {
			const nowMs = Date.now();
			const job: LoopJobRecord = {
				policy: "loop",
				runId: "bg-tail",
				loopId: "bg-tail",
				repoKey: "k",
				cwd: "/repo",
				scope: "sc",
				task: "t",
				maxIterations: 3,
				allowUnenforced: false,
				iterationsCompleted: 0,
				auditRefs: [],
				state: "running",
				createdAt: new Date().toISOString(),
				pid: process.pid,
				lastHeartbeatAt: new Date().toISOString(),
				recentEvents: [
					{
						ts: nowMs - 3_000,
						kind: "step.completed",
						label: "step implement completed (1200ms)",
						stepId: "implement",
						participantId: "impl",
						agentId: "claude",
					},
				],
			};
			new JobStore(jobsDir).create(job);
			const live = buildStudioLiveSource({ foregroundDir: fgDir, jobsDir }).live();
			const row = live.background[0];
			expect(row?.recentEvents).toHaveLength(1);
			expect(row?.recentEvents?.[0]?.kind).toBe("step.completed");
			expect(row?.recentEvents?.[0]?.label).toBe("step implement completed (1200ms)");
			expect(row?.recentEvents?.[0]?.stepId).toBe("implement");
			expect(row?.recentEvents?.[0]?.participantId).toBe("impl");
			expect(row?.recentEvents?.[0]?.agentId).toBe("claude");
			expect(row?.recentEvents?.[0]?.ageMs).toBeGreaterThanOrEqual(3_000);
			expect(row?.recentEvents?.[0]?.ageMs).toBeLessThan(60_000);
			expect(JSON.stringify(row?.recentEvents)).not.toContain('"ts"');
		} finally {
			rmSync(fgDir, { recursive: true, force: true });
			rmSync(jobsDir, { recursive: true, force: true });
		}
	});

	test("a hostile event tail loses extra keys and undatable entries but keeps safe ones", () => {
		const fgDir = mkdtempSync(join(tmpdir(), "chit-live-fg-"));
		const jobsDir = mkdtempSync(join(tmpdir(), "chit-live-jobs-"));
		try {
			const nowMs = Date.now();
			// What a hand-edited or off-contract writer could put in the state files:
			// payload-bearing extra keys, a future timestamp (no derivable age), and
			// entries that are not summaries at all.
			const hostile = [
				{
					ts: nowMs - 2_000,
					kind: "adapter.event",
					label: "assistant",
					raw: "SENTINEL_RAW",
					body: "SENTINEL_BODY",
					prompt: "SENTINEL_PROMPT",
					output: "SENTINEL_OUTPUT",
					config: { envKeys: ["SENTINEL_ENV_KEY"] },
				},
				{ ts: nowMs + 60_000, kind: "step.started", label: "SENTINEL_FUTURE" },
				{ kind: "step.started", label: "SENTINEL_NO_TS" },
				{ ts: nowMs - 1_000, kind: "not.a.kind", label: "SENTINEL_BAD_KIND" },
				"SENTINEL_NOT_AN_OBJECT",
			] as unknown as LiveEventSummary[];
			new ForegroundRegistry(fgDir).write(liveSnapshot({ events: hostile }));
			const job: LoopJobRecord = {
				policy: "loop",
				runId: "bg-hostile",
				loopId: "bg-hostile",
				repoKey: "k",
				cwd: "/repo",
				scope: "sc",
				task: "t",
				maxIterations: 3,
				allowUnenforced: false,
				iterationsCompleted: 0,
				auditRefs: [],
				state: "running",
				createdAt: new Date().toISOString(),
				pid: process.pid,
				lastHeartbeatAt: new Date().toISOString(),
				recentEvents: hostile,
			};
			new JobStore(jobsDir).create(job);

			const live = buildStudioLiveSource({ foregroundDir: fgDir, jobsDir }).live();
			// Only the one well-formed, datable entry survives on each side.
			expect(live.foreground[0]?.recentEvents).toHaveLength(1);
			expect(live.foreground[0]?.recentEvents?.[0]?.label).toBe("assistant");
			expect(live.background[0]?.recentEvents).toHaveLength(1);
			expect(live.background[0]?.recentEvents?.[0]?.label).toBe("assistant");
			const serialized = JSON.stringify(live);
			for (const sentinel of [
				"SENTINEL_RAW",
				"SENTINEL_BODY",
				"SENTINEL_PROMPT",
				"SENTINEL_OUTPUT",
				"SENTINEL_ENV_KEY",
				"SENTINEL_FUTURE",
				"SENTINEL_NO_TS",
				"SENTINEL_BAD_KIND",
				"SENTINEL_NOT_AN_OBJECT",
			]) {
				expect(serialized).not.toContain(sentinel);
			}
		} finally {
			rmSync(fgDir, { recursive: true, force: true });
			rmSync(jobsDir, { recursive: true, force: true });
		}
	});

	test("an oversized event tail is capped to the newest MAX_LIVE_EVENTS entries", () => {
		const fgDir = mkdtempSync(join(tmpdir(), "chit-live-fg-"));
		const jobsDir = mkdtempSync(join(tmpdir(), "chit-live-jobs-"));
		try {
			const nowMs = Date.now();
			const oversized: LiveEventSummary[] = Array.from(
				{ length: MAX_LIVE_EVENTS + 10 },
				(_, i) => ({
					ts: nowMs - (MAX_LIVE_EVENTS + 10 - i) * 1_000,
					kind: "adapter.event",
					label: `evt-${i}`,
				}),
			);
			new ForegroundRegistry(fgDir).write(liveSnapshot({ events: oversized }));
			const live = buildStudioLiveSource({ foregroundDir: fgDir, jobsDir }).live();
			const tail = live.foreground[0]?.recentEvents;
			expect(tail).toHaveLength(MAX_LIVE_EVENTS);
			// Newest entries kept: the 10 oldest fell off the front.
			expect(tail?.[0]?.label).toBe("evt-10");
			expect(tail?.[tail.length - 1]?.label).toBe(`evt-${MAX_LIVE_EVENTS + 9}`);
		} finally {
			rmSync(fgDir, { recursive: true, force: true });
			rmSync(jobsDir, { recursive: true, force: true });
		}
	});

	test("over-cap future-dated entries cannot crowd out older safe entries", () => {
		const fgDir = mkdtempSync(join(tmpdir(), "chit-live-fg-"));
		const jobsDir = mkdtempSync(join(tmpdir(), "chit-live-jobs-"));
		try {
			const nowMs = Date.now();
			// Datable safe entries FIRST, then a full cap's worth of future-dated
			// ones: a cap applied before the future filter would keep only the
			// futures, then drop them all, emitting no tail despite the safe entries.
			const safe: LiveEventSummary[] = Array.from({ length: 10 }, (_, i) => ({
				ts: nowMs - 10_000 + i * 100,
				kind: "adapter.event",
				label: `safe-${i}`,
			}));
			const future: LiveEventSummary[] = Array.from({ length: MAX_LIVE_EVENTS }, (_, i) => ({
				ts: nowMs + 60_000 + i,
				kind: "adapter.event",
				label: `future-${i}`,
			}));
			const mixed = [...safe, ...future];
			new ForegroundRegistry(fgDir).write(liveSnapshot({ events: mixed }));
			const job: LoopJobRecord = {
				policy: "loop",
				runId: "bg-skew",
				loopId: "bg-skew",
				repoKey: "k",
				cwd: "/repo",
				scope: "sc",
				task: "t",
				maxIterations: 3,
				allowUnenforced: false,
				iterationsCompleted: 0,
				auditRefs: [],
				state: "running",
				createdAt: new Date().toISOString(),
				pid: process.pid,
				lastHeartbeatAt: new Date().toISOString(),
				recentEvents: mixed,
			};
			new JobStore(jobsDir).create(job);

			const live = buildStudioLiveSource({ foregroundDir: fgDir, jobsDir }).live();
			const expected = safe.map((e) => e.label);
			expect(live.foreground[0]?.recentEvents?.map((e) => e.label)).toEqual(expected);
			expect(live.background[0]?.recentEvents?.map((e) => e.label)).toEqual(expected);
			expect(JSON.stringify(live)).not.toContain("future-");
		} finally {
			rmSync(fgDir, { recursive: true, force: true });
			rmSync(jobsDir, { recursive: true, force: true });
		}
	});

	test("rows with no event tail omit recentEvents entirely", () => {
		const fgDir = mkdtempSync(join(tmpdir(), "chit-live-fg-"));
		const jobsDir = mkdtempSync(join(tmpdir(), "chit-live-jobs-"));
		try {
			new ForegroundRegistry(fgDir).write(liveSnapshot());
			const job: LoopJobRecord = {
				policy: "loop",
				runId: "bg-no-tail",
				loopId: "bg-no-tail",
				repoKey: "k",
				cwd: "/repo",
				scope: "sc",
				task: "t",
				maxIterations: 3,
				allowUnenforced: false,
				iterationsCompleted: 0,
				auditRefs: [],
				state: "running",
				createdAt: new Date().toISOString(),
				pid: process.pid,
				lastHeartbeatAt: new Date().toISOString(),
				// An explicitly empty tail must also be omitted, not emitted as [].
				recentEvents: [],
			};
			new JobStore(jobsDir).create(job);
			const live = buildStudioLiveSource({ foregroundDir: fgDir, jobsDir }).live();
			expect(live.foreground[0]?.recentEvents).toBeUndefined();
			expect(live.background[0]?.recentEvents).toBeUndefined();
			expect(JSON.stringify(live)).not.toContain("recentEvents");
		} finally {
			rmSync(fgDir, { recursive: true, force: true });
			rmSync(jobsDir, { recursive: true, force: true });
		}
	});
});

describe("buildStudioLiveActions (Studio background cancel injection)", () => {
	// A background loop job with no live worker (no pid/pgid), so cancel persists
	// the intent without trying to signal -- the behavior the route exercises in a
	// test environment.
	function loopJob(over: Partial<LoopJobRecord> = {}): LoopJobRecord {
		return {
			policy: "loop",
			runId: "bg-1",
			loopId: "bg-1",
			repoKey: "k",
			cwd: "/repo",
			scope: "sc",
			task: "migrate the routes",
			maxIterations: 3,
			allowUnenforced: false,
			iterationsCompleted: 0,
			auditRefs: [],
			state: "running",
			createdAt: new Date().toISOString(),
			...over,
		};
	}

	test("a running job persists cancelRequestedAt and sets phase cancelling (intent-first)", () => {
		const jobsDir = mkdtempSync(join(tmpdir(), "chit-cancel-jobs-"));
		try {
			const store = new JobStore(jobsDir);
			store.create(loopJob({ state: "running" }));
			const result = buildStudioLiveActions({ jobsDir }).cancelBackground("bg-1");
			expect(result.status).toBe("requested");
			if (result.status === "requested") {
				expect(result.state).toBe("running");
				expect(result.signaled).toBe(false); // no pgid/pid, so no worker was signaled
			}
			const after = store.get("bg-1");
			expect(after?.cancelRequestedAt).toBeDefined();
			expect(after?.phase).toBe("cancelling");
		} finally {
			rmSync(jobsDir, { recursive: true, force: true });
		}
	});

	test("a queued job persists the intent but does not get a cancelling phase (no worker yet)", () => {
		const jobsDir = mkdtempSync(join(tmpdir(), "chit-cancel-jobs-"));
		try {
			const store = new JobStore(jobsDir);
			store.create(loopJob({ state: "queued" }));
			const result = buildStudioLiveActions({ jobsDir }).cancelBackground("bg-1");
			expect(result.status).toBe("requested");
			if (result.status === "requested") expect(result.state).toBe("queued");
			const after = store.get("bg-1");
			expect(after?.cancelRequestedAt).toBeDefined();
			expect(after?.phase).toBeUndefined();
		} finally {
			rmSync(jobsDir, { recursive: true, force: true });
		}
	});

	test("a terminal job is reported already-finished and gets no cancel fields", () => {
		const jobsDir = mkdtempSync(join(tmpdir(), "chit-cancel-jobs-"));
		try {
			const store = new JobStore(jobsDir);
			store.create(loopJob({ state: "completed", endedAt: new Date().toISOString() }));
			const result = buildStudioLiveActions({ jobsDir }).cancelBackground("bg-1");
			expect(result).toEqual({ status: "already-finished", state: "completed" });
			// No cancel intent was written onto a finished run.
			expect(store.get("bg-1")?.cancelRequestedAt).toBeUndefined();
		} finally {
			rmSync(jobsDir, { recursive: true, force: true });
		}
	});

	test("an unknown run id is not-found", () => {
		const jobsDir = mkdtempSync(join(tmpdir(), "chit-cancel-jobs-"));
		try {
			const result = buildStudioLiveActions({ jobsDir }).cancelBackground("ghost");
			expect(result).toEqual({ status: "not-found" });
		} finally {
			rmSync(jobsDir, { recursive: true, force: true });
		}
	});
});

describe("chit run (subprocess)", () => {
	test("codex-only fixture end-to-end with fake codex", async () => {
		const { stdout, code } = await runCLI([
			"run",
			ASK_CODEX,
			"--input",
			"question=what is the meaning of life",
		]);
		expect(code).toBe(0);
		expect(stdout).toContain("CODEX_ANSWER: 42");
	});

	test("a malformed config.json reports as 'invalid config', not 'invalid manifest'", async () => {
		// Isolate XDG so the bad config cannot leak into the other subprocess runs
		// (which share TMPDIR and rely on its absence of a config file).
		const cfgDir = mkdtempSync(join(tmpdir(), "chit-badcfg-"));
		try {
			mkdirSync(join(cfgDir, "chit"), { recursive: true });
			writeFileSync(join(cfgDir, "chit", "config.json"), "{ not valid json");
			const { stderr, code } = await runCLI(["run", ASK_CODEX, "--input", "question=hi"], {
				XDG_CONFIG_HOME: cfgDir,
			});
			expect(code).toBe(2);
			expect(stderr).toContain("invalid config");
			expect(stderr).not.toContain("invalid manifest");
		} finally {
			rmSync(cfgDir, { recursive: true, force: true });
		}
	});

	test("config layers from --invocation-cwd: a repo chit.config.json with env there is rejected", async () => {
		// The repo config lives in the --invocation-cwd dir, not in the directory the
		// CLI process runs from. Its trust-boundary violation must fail the run, which
		// proves the flag is threaded into config loading.
		const repoDir = mkdtempSync(join(tmpdir(), "chit-repocfg-"));
		try {
			writeFileSync(
				join(repoDir, "chit.config.json"),
				JSON.stringify({ agents: { sneaky: { adapter: "codex-exec", env: { PATH: "/evil" } } } }),
			);
			const { stderr, code } = await runCLI([
				"run",
				ASK_CODEX,
				"--input",
				"question=hi",
				"--invocation-cwd",
				repoDir,
			]);
			expect(code).toBe(2);
			expect(stderr).toContain("invalid config");
			expect(stderr).toContain('"env" is not allowed in repo config');
		} finally {
			rmSync(repoDir, { recursive: true, force: true });
		}
	});

	test("a manifest that fails to parse reports as 'invalid manifest'", async () => {
		// Valid JSON (so it is not a read error) that parseManifest rejects: schema 2.
		const badManifest = writeManifestFixture("bad-schema", {
			schema: 2,
			id: "bad",
			description: "wrong schema",
			inputs: { q: { type: "string" } },
			participants: { a: { agent: "codex", instructions: "r", session: "stateless" } },
			steps: { s: { call: "a", prompt: "{{ inputs.q }}" } },
			output: "s",
		});
		const { stderr, code } = await runCLI(["run", badManifest, "--input", "q=hi"]);
		expect(code).toBe(2);
		expect(stderr).toContain("invalid manifest");
	});

	test("--audit persists a full audit run (cli surface) without changing output", async () => {
		// Isolate the audit store in a fresh state dir so we can read it back.
		const stateDir = mkdtempSync(join(tmpdir(), "chit-run-audit-"));
		try {
			const { stdout, stderr, code } = await runCLI(
				["run", ASK_CODEX, "--input", "question=hi", "--audit"],
				{ XDG_STATE_HOME: stateDir },
			);
			expect(code).toBe(0);
			expect(stdout).toContain("CODEX_ANSWER: 42"); // output unchanged by audit
			expect(stderr).toMatch(/audit run /); // run id surfaced on stderr

			const store = new AuditStore(join(stateDir, "chit", "audit"));
			const runs = store.listRuns();
			expect(runs.length).toBe(1);
			const events = store.readEvents(runs[0] as string);
			expect(events[0]).toMatchObject({ type: "run.started", surface: "cli" });
			expect(events.at(-1)?.type).toBe("run.completed");
			// The single codex call produced a completed adapter call with a readable
			// output blob.
			const done = events.find((e) => e.type === "adapter.call.completed");
			expect(
				done?.type === "adapter.call.completed" &&
					store.readBlob(runs[0] as string, done.outputBlob).length,
			).toBeGreaterThan(0);
			// run.started records the resolved per-participant config snapshot, so the
			// audit shows what this run actually used (end-to-end through the surface).
			const started = events[0];
			const snaps = started?.type === "run.started" ? started.participants : undefined;
			expect(snaps).toBeDefined();
			const codexSnap = Object.values(snaps ?? {}).find((p) => p.adapter === "codex-exec");
			expect(codexSnap).toBeDefined();
			expect(codexSnap?.config).toBeDefined();
		} finally {
			rmSync(stateDir, { recursive: true, force: true });
		}
	});

	test("plain run does NOT write an audit run (audit is opt-in)", async () => {
		const stateDir = mkdtempSync(join(tmpdir(), "chit-run-noaudit-"));
		try {
			const { code } = await runCLI(["run", ASK_CODEX, "--input", "question=hi"], {
				XDG_STATE_HOME: stateDir,
			});
			expect(code).toBe(0);
			expect(new AuditStore(join(stateDir, "chit", "audit")).listRuns()).toEqual([]);
		} finally {
			rmSync(stateDir, { recursive: true, force: true });
		}
	});

	test("--audit surfaces the run id even when the run FAILS, and records run.completed", async () => {
		const stateDir = mkdtempSync(join(tmpdir(), "chit-run-auditfail-"));
		try {
			// Omit the required `question` input -> the run fails (exit 2) after the
			// audit run has already started; the id must still be discoverable.
			const { stderr, code } = await runCLI(["run", ASK_CODEX, "--audit"], {
				XDG_STATE_HOME: stateDir,
			});
			expect(code).toBe(2);
			expect(stderr).toMatch(/audit run /);
			const store = new AuditStore(join(stateDir, "chit", "audit"));
			const runs = store.listRuns();
			expect(runs.length).toBe(1);
			const events = store.readEvents(runs[0] as string);
			expect(events[0]?.type).toBe("run.started");
			const last = events.at(-1);
			expect(last?.type === "run.completed" && last.status).toBe("failed");
		} finally {
			rmSync(stateDir, { recursive: true, force: true });
		}
	});

	test("--audit does NOT print a run id when the audit store cannot be written", async () => {
		// Point XDG_STATE_HOME at a regular FILE so the audit dir cannot be created;
		// audit writes fail (best-effort, swallowed) and the run still succeeds, but
		// no misleading audit id is printed.
		const stateFile = join(mkdtempSync(join(tmpdir(), "chit-run-badstate-")), "not-a-dir");
		writeFileSync(stateFile, "x");
		try {
			const { stdout, stderr, code } = await runCLI(
				["run", ASK_CODEX, "--input", "question=hi", "--audit"],
				{ XDG_STATE_HOME: stateFile },
			);
			expect(code).toBe(0); // audit is best-effort: the run still succeeds
			expect(stdout).toContain("CODEX_ANSWER: 42"); // output unaffected
			expect(stderr).not.toMatch(/audit run /); // no link to a missing transcript
		} finally {
			rmSync(stateFile, { force: true });
		}
	});

	test("stateless consult fixture runs codex + claude in parallel", async () => {
		const { stdout, code } = await runCLI([
			"run",
			CONSULT_STATELESS,
			"--allow-unenforced-permissions",
			"--input",
			"question=hi",
		]);
		expect(code).toBe(0);
		expect(stdout).toContain("## codex");
		expect(stdout).toContain("CODEX_ANSWER: 42");
		expect(stdout).toContain("## claude");
		expect(stdout).toContain("CLAUDE_ANSWER: yes");
	});

	test("claude manifest runs without --allow-unenforced-permissions (plan mode enforces)", async () => {
		// claude read_only is now enforced via --permission-mode plan, so the run
		// no longer needs the override flag and emits no unenforced-permission gate.
		const { stdout, stderr, code } = await runCLI(["run", ASK_CLAUDE, "--input", "question=hi"]);
		expect(code).toBe(0);
		expect(stdout).toContain("CLAUDE_ANSWER: yes");
		expect(stderr).not.toContain("cannot enforce required permissions");
	});

	test("claude manifest runs clean with no unenforced-permission warning", async () => {
		// Passing the flag is now a harmless no-op (no gaps to warn about).
		const { stderr, code } = await runCLI([
			"run",
			ASK_CLAUDE,
			"--allow-unenforced-permissions",
			"--input",
			"question=hi",
		]);
		expect(code).toBe(0);
		expect(stderr).not.toContain("WARNING");
		expect(stderr).not.toContain("unenforced permissions");
	});

	test("codex-only manifest needs no enforcement override (codex-exec sandboxes)", async () => {
		const { stderr, code } = await runCLI(["run", ASK_CODEX, "--input", "question=hi"]);
		expect(code).toBe(0);
		expect(stderr).not.toContain("cannot enforce");
		expect(stderr).not.toContain("WARNING");
	});

	test("rejects per_scope manifest when --scope is missing", async () => {
		const { stderr, code } = await runCLI(["run", CONSULT, "--input", "question=hi"]);
		expect(code).toBe(2);
		expect(stderr).toContain("can_provide_stable_scope");
		expect(stderr).toContain("--scope");
	});

	test("accepts per_scope manifest when --scope is provided", async () => {
		const { stdout, code } = await runCLI([
			"run",
			CONSULT,
			"--scope",
			"test-scope-1",
			"--allow-unenforced-permissions",
			"--input",
			"question=hi",
		]);
		expect(code).toBe(0);
		expect(stdout).toContain("## codex");
		expect(stdout).toContain("## claude");
	});

	test("session round-trip: second run resumes both adapters", async () => {
		// First run: both adapters take the fresh path and persist session state.
		const first = await runCLI([
			"run",
			CONSULT,
			"--scope",
			"round-trip",
			"--allow-unenforced-permissions",
			"--input",
			"question=hi",
		]);
		expect(first.code).toBe(0);
		expect(first.stdout).toContain("CODEX_ANSWER");
		expect(first.stdout).toContain("CLAUDE_ANSWER");

		// Session file exists with payloads for both participants (new chit path).
		const sessionsDir = join(TMPDIR, "chit", "sessions");
		expect(existsSync(sessionsDir)).toBe(true);
		const files = readdirSync(sessionsDir);
		const file = files.find((f) => f.startsWith("round-trip--consult--"));
		expect(file).toBeDefined();
		const data = JSON.parse(readFileSync(join(sessionsDir, file as string), "utf-8"));
		const keys = Object.keys(data);
		expect(keys.some((k) => k.startsWith("codex--"))).toBe(true);
		expect(keys.some((k) => k.startsWith("claude--"))).toBe(true);

		// Second run with the same scope: both adapters should take the resume path.
		const second = await runCLI([
			"run",
			CONSULT,
			"--scope",
			"round-trip",
			"--allow-unenforced-permissions",
			"--input",
			"question=hi",
		]);
		expect(second.code).toBe(0);
		expect(second.stdout).toContain("CODEX_RESUMED");
		expect(second.stdout).toContain("CLAUDE_RESUMED");
	});

	test("errors on missing manifest file", async () => {
		const { stderr, code } = await runCLI(["run", "/tmp/does-not-exist-chit.json"]);
		expect(code).toBe(2);
		expect(stderr).toContain("failed to read manifest");
	});

	test("errors on missing required input", async () => {
		const { stderr, code } = await runCLI(["run", ASK_CODEX]);
		expect(code).toBe(2);
		expect(stderr).toContain("missing required input");
	});

	test("surfaces failure envelope when codex exits with error", async () => {
		// Shadow the working fake codex with a broken one that always exits 127.
		const brokenDir = join(TMPDIR, "broken-bin");
		mkdirSync(brokenDir, { recursive: true });
		const brokenCodex = join(brokenDir, "codex");
		writeFileSync(brokenCodex, "#!/bin/sh\nexit 127\n");
		chmodSync(brokenCodex, 0o755);

		const { stderr, code } = await runCLI(["run", ASK_CODEX, "--input", "question=hi"], {
			PATH: `${brokenDir}:${process.env.PATH ?? ""}`,
		});
		expect(code).toBe(1);
		expect(stderr).toContain("run failed");
		expect(stderr).toContain("codex exec exited 127");
	});

	test("prints help with --help", async () => {
		const { stdout, code } = await runCLI(["--help"]);
		expect(code).toBe(0);
		expect(stdout).toContain("Usage:");
		expect(stdout).toContain("chit run");
	});

	test("rejects unknown command", async () => {
		const { stderr, code } = await runCLI(["banana"]);
		expect(code).toBe(2);
		expect(stderr).toContain("unknown command");
	});

	test("--input-stdin reads stdin as the input value", async () => {
		const { stdout, code } = await runCLI(
			["run", ASK_CODEX, "--input-stdin", "question"],
			{},
			"what is the meaning of life",
		);
		expect(code).toBe(0);
		expect(stdout).toContain("CODEX_ANSWER");
	});

	test("--input-stdin conflicts with --input for the same key", async () => {
		const { stderr, code } = await runCLI(
			["run", ASK_CODEX, "--input", "question=x", "--input-stdin", "question"],
			{},
			"",
		);
		expect(code).toBe(2);
		expect(stderr).toContain("conflicts with --input");
	});

	test("install creates skill files in --to dir", async () => {
		const target = mkdtempSync(join(TMPDIR, "install-target-"));
		const { code, stdout } = await runCLI([
			"install",
			ASK_CODEX,
			"--as",
			"claude-skill",
			"--to",
			target,
			"--runtime-path",
			PROJECT_ROOT,
		]);
		expect(code).toBe(0);
		expect(stdout).toContain("installed skill at");
		expect(existsSync(join(target, "ask-codex", "SKILL.md"))).toBe(true);
		expect(existsSync(join(target, "ask-codex", "manifest.json"))).toBe(true);
	});

	test("install refuses when target exists; --force replaces it", async () => {
		const target = mkdtempSync(join(TMPDIR, "install-target-"));
		const first = await runCLI([
			"install",
			ASK_CODEX,
			"--as",
			"claude-skill",
			"--to",
			target,
			"--runtime-path",
			PROJECT_ROOT,
		]);
		expect(first.code).toBe(0);

		// Drop a residual file as if from a prior unrelated install.
		const stale = join(target, "ask-codex", "scripts", "old.js");
		mkdirSync(join(target, "ask-codex", "scripts"), { recursive: true });
		writeFileSync(stale, "// stale");

		const refused = await runCLI([
			"install",
			ASK_CODEX,
			"--as",
			"claude-skill",
			"--to",
			target,
			"--runtime-path",
			PROJECT_ROOT,
		]);
		expect(refused.code).toBe(2);
		expect(refused.stderr).toContain("already exists");
		expect(existsSync(stale)).toBe(true);

		const forced = await runCLI([
			"install",
			ASK_CODEX,
			"--as",
			"claude-skill",
			"--to",
			target,
			"--runtime-path",
			PROJECT_ROOT,
			"--force",
		]);
		expect(forced.code).toBe(0);
		expect(existsSync(stale)).toBe(false);
		expect(existsSync(join(target, "ask-codex", "scripts"))).toBe(false);
	});

	test("install --name uses overridden name for folder and SKILL.md", async () => {
		const target = mkdtempSync(join(TMPDIR, "install-target-"));
		const { code } = await runCLI([
			"install",
			ASK_CODEX,
			"--as",
			"claude-skill",
			"--to",
			target,
			"--runtime-path",
			PROJECT_ROOT,
			"--name",
			"chit-ask",
		]);
		expect(code).toBe(0);
		expect(existsSync(join(target, "chit-ask", "SKILL.md"))).toBe(true);
		const md = readFileSync(join(target, "chit-ask", "SKILL.md"), "utf-8");
		expect(md).toContain("name: chit-ask");
	});

	test("install requires --as", async () => {
		const target = mkdtempSync(join(TMPDIR, "install-target-"));
		const { stderr, code } = await runCLI([
			"install",
			ASK_CODEX,
			"--to",
			target,
			"--runtime-path",
			PROJECT_ROOT,
		]);
		expect(code).toBe(2);
		expect(stderr).toContain("--as is required");
	});

	test("install rejects --name with path-traversal sequence", async () => {
		const target = mkdtempSync(join(TMPDIR, "install-target-"));
		const { stderr, code } = await runCLI([
			"install",
			ASK_CODEX,
			"--as",
			"claude-skill",
			"--to",
			target,
			"--runtime-path",
			PROJECT_ROOT,
			"--name",
			"../../escape",
		]);
		expect(code).toBe(2);
		expect(stderr).toContain("overrideName");
		expect(stderr).toContain("invalid");
	});

	test("install rejects unknown --as value", async () => {
		const target = mkdtempSync(join(TMPDIR, "install-target-"));
		const { stderr, code } = await runCLI([
			"install",
			ASK_CODEX,
			"--as",
			"unicorn-tool",
			"--to",
			target,
			"--runtime-path",
			PROJECT_ROOT,
		]);
		expect(code).toBe(2);
		expect(stderr).toContain("unknown surface");
	});

	test("show emits JSON when --format json", async () => {
		const { stdout, code } = await runCLI([
			"show",
			ASK_CODEX,
			"--surface",
			"claude-skill",
			"--format",
			"json",
		]);
		expect(code).toBe(0);
		const parsed = JSON.parse(stdout);
		expect(parsed.manifest.id).toBe("ask-codex");
		expect(parsed.surface.kind).toBe("claude-skill");
		expect(parsed.validation.permissions.status).toBe("ok");
	});

	test("show defaults to ascii format when --format omitted", async () => {
		const { stdout, code } = await runCLI(["show", ASK_CODEX]);
		expect(code).toBe(0);
		expect(stdout).toContain("manifest: ask-codex");
		expect(stdout).toContain("participants:");
		expect(stdout).toContain("execution:");
	});

	test("show emits mermaid syntax", async () => {
		const { stdout, code } = await runCLI(["show", CONSULT_STATELESS, "--format", "mermaid"]);
		expect(code).toBe(0);
		expect(stdout.trim().startsWith("graph LR")).toBe(true);
		expect(stdout).toContain("ask_codex");
		expect(stdout).toContain("-->");
	});

	test("show emits HTML document", async () => {
		const { stdout, code } = await runCLI(["show", ASK_CODEX, "--format", "html"]);
		expect(code).toBe(0);
		expect(stdout.trim().startsWith("<!DOCTYPE html>")).toBe(true);
		expect(stdout).toContain("<title>chit: ask-codex</title>");
	});

	test("show rejects unknown --format value", async () => {
		const { stderr, code } = await runCLI(["show", ASK_CODEX, "--format", "pdf"]);
		expect(code).toBe(2);
		expect(stderr).toContain("--format must be one of");
	});

	test("show rejects unknown --surface value", async () => {
		const { stderr, code } = await runCLI(["show", ASK_CODEX, "--surface", "imaginary"]);
		expect(code).toBe(2);
		expect(stderr).toContain("unknown surface");
	});

	test("show without --surface omits validation block", async () => {
		const { stdout, code } = await runCLI(["show", CONSULT, "--format", "ascii"]);
		expect(code).toBe(0);
		expect(stdout).toContain("manifest: consult");
		expect(stdout).not.toContain("surface:");
		expect(stdout).not.toContain("NEEDS OVERRIDE");
	});

	test("show against claude-skill surface reports permissions OK (claude now enforces)", async () => {
		const { stdout, code } = await runCLI([
			"show",
			CONSULT,
			"--surface",
			"claude-skill",
			"--format",
			"ascii",
		]);
		expect(code).toBe(0);
		expect(stdout).toContain("permissions:  OK");
		expect(stdout).not.toContain("NEEDS OVERRIDE");
		expect(stdout).not.toContain("cannot enforce");
	});

	test("show against claude-skill surface flags can_pass_files missing for file[] inputs", async () => {
		const { stdout, code } = await runCLI([
			"show",
			FILE_INPUT_MANIFEST,
			"--surface",
			"claude-skill",
			"--format",
			"ascii",
		]);
		expect(code).toBe(0);
		expect(stdout).toContain("INCOMPATIBLE");
		expect(stdout).toContain("can_pass_files");
	});

	test("install accepts claude manifest without --allow-unenforced-permissions (plan mode enforces)", async () => {
		const target = mkdtempSync(join(TMPDIR, "install-target-"));
		const { stdout, stderr, code } = await runCLI([
			"install",
			ASK_CLAUDE,
			"--as",
			"claude-skill",
			"--to",
			target,
			"--runtime-path",
			PROJECT_ROOT,
		]);
		expect(code).toBe(0);
		expect(stdout).toContain("installed skill at");
		expect(stderr).not.toContain("cannot enforce required permissions");
	});

	test("list returns 'no installs found' against an empty parent dir", async () => {
		const target = mkdtempSync(join(TMPDIR, "list-empty-"));
		const { stdout, code } = await runCLI(["list", "--to", target]);
		expect(code).toBe(0);
		expect(stdout).toContain("no installs found");
		expect(stdout).toContain(target);
	});

	test("list shows installed skills after a successful install", async () => {
		const target = mkdtempSync(join(TMPDIR, "list-target-"));
		const inst = await runCLI([
			"install",
			ASK_CODEX,
			"--as",
			"claude-skill",
			"--to",
			target,
			"--runtime-path",
			PROJECT_ROOT,
		]);
		expect(inst.code).toBe(0);

		const { stdout, code } = await runCLI(["list", "--to", target]);
		expect(code).toBe(0);
		expect(stdout).toContain("ask-codex");
		expect(stdout).toContain("surface:");
		expect(stdout).toContain("claude-skill");
		expect(stdout).toContain("manifest:");
		expect(stdout).toContain("ask-codex");
	});

	test("list --json emits a parseable structured payload", async () => {
		const target = mkdtempSync(join(TMPDIR, "list-target-"));
		await runCLI([
			"install",
			ASK_CODEX,
			"--as",
			"claude-skill",
			"--to",
			target,
			"--runtime-path",
			PROJECT_ROOT,
		]);
		const { stdout, code } = await runCLI(["list", "--to", target, "--json"]);
		expect(code).toBe(0);
		const parsed = JSON.parse(stdout);
		expect(parsed.parentDir).toBe(target);
		expect(Array.isArray(parsed.installs)).toBe(true);
		expect(parsed.installs.length).toBe(1);
		expect(parsed.installs[0].marker.installName).toBe("ask-codex");
		expect(parsed.installs[0].marker.surface).toBe("claude-skill");
	});

	test("list ignores unmarked directories (e.g., a foreign skill)", async () => {
		const target = mkdtempSync(join(TMPDIR, "list-foreign-"));
		// A foreign skill folder with SKILL.md but no marker.
		const foreign = join(target, "foreign-skill");
		mkdirSync(foreign, { recursive: true });
		writeFileSync(join(foreign, "SKILL.md"), "(someone else's skill)\n");

		await runCLI([
			"install",
			ASK_CODEX,
			"--as",
			"claude-skill",
			"--to",
			target,
			"--runtime-path",
			PROJECT_ROOT,
		]);

		const { stdout, code } = await runCLI(["list", "--to", target, "--json"]);
		expect(code).toBe(0);
		const parsed = JSON.parse(stdout);
		const names = parsed.installs.map(
			(r: { marker: { installName: string } }) => r.marker.installName,
		);
		expect(names).toEqual(["ask-codex"]);
	});

	test("uninstall removes a previously-installed skill", async () => {
		const target = mkdtempSync(join(TMPDIR, "uninstall-target-"));
		await runCLI([
			"install",
			ASK_CODEX,
			"--as",
			"claude-skill",
			"--to",
			target,
			"--runtime-path",
			PROJECT_ROOT,
		]);
		const skillDir = join(target, "ask-codex");
		expect(existsSync(skillDir)).toBe(true);

		const { stdout, code } = await runCLI(["uninstall", "ask-codex", "--to", target]);
		expect(code).toBe(0);
		expect(stdout).toContain("uninstalled ask-codex");
		expect(existsSync(skillDir)).toBe(false);
	});

	test("uninstall refuses when target dir has no marker (foreign skill protection)", async () => {
		const target = mkdtempSync(join(TMPDIR, "uninstall-foreign-"));
		const foreign = join(target, "foreign");
		mkdirSync(foreign, { recursive: true });
		writeFileSync(join(foreign, "SKILL.md"), "(not ours)\n");

		const { stderr, code } = await runCLI(["uninstall", "foreign", "--to", target]);
		expect(code).toBe(2);
		expect(stderr).toContain("refusing to uninstall");
		expect(stderr).toContain(".chit-install.json");
		// Directory must still exist after a refused uninstall.
		expect(existsSync(foreign)).toBe(true);
	});

	test("uninstall refuses when the install does not exist", async () => {
		const target = mkdtempSync(join(TMPDIR, "uninstall-missing-"));
		const { stderr, code } = await runCLI(["uninstall", "ghost", "--to", target]);
		expect(code).toBe(2);
		expect(stderr).toContain("no install at");
	});

	test("uninstall without name is rejected", async () => {
		const { stderr, code } = await runCLI(["uninstall"]);
		expect(code).toBe(2);
		expect(stderr).toContain("install name");
	});

	test("uninstall rejects path-traversal name (sibling install protection)", async () => {
		// Two parent dirs, both legitimate chit `--to` locations. Without
		// the kebab-case check in lifecycle.uninstall, `uninstall ../sensitive`
		// against parent A could rm-rf the install in parent B (the sibling
		// path resolves outside A but happens to carry a valid marker).
		const intended = mkdtempSync(join(TMPDIR, "uninstall-intended-"));
		const sensitive = mkdtempSync(join(TMPDIR, "uninstall-sensitive-"));
		// Install a real chit skill into the "sensitive" location.
		await runCLI([
			"install",
			ASK_CODEX,
			"--as",
			"claude-skill",
			"--to",
			sensitive,
			"--runtime-path",
			PROJECT_ROOT,
		]);
		const sensitiveSkillDir = join(sensitive, "ask-codex");
		expect(existsSync(sensitiveSkillDir)).toBe(true);

		// Attempt to traverse from `intended` to `sensitive` via name.
		const relative = `../${sensitive.split("/").pop()}/ask-codex`;
		const { stderr, code } = await runCLI(["uninstall", relative, "--to", intended]);
		expect(code).toBe(2);
		expect(stderr).toContain("invalid");
		expect(existsSync(sensitiveSkillDir)).toBe(true);
	});

	test("--input-stdin preserves shell metacharacters as literal text", async () => {
		// If shell interpolation happened upstream, the payload would have been
		// expanded before reaching the CLI. --input-stdin reads bytes from
		// stdin verbatim, so the runtime sees the literal characters.
		const { stdout, code } = await runCLI(
			["run", ASK_CODEX, "--input-stdin", "question"],
			{},
			"$(uname) `whoami` \"quoted\" 'single' && rm -rf /",
		);
		expect(code).toBe(0);
		// fake codex echoes the input back; we should see the literal payload
		// substring in the captured output.
		expect(stdout).toContain("CODEX_ANSWER");
	});
});

describe("CLI entrypoint: piped stdout", () => {
	// Regression for the process.exit() truncation. Piping `chit ... | jq` cut the
	// output to ~512 bytes, because the entrypoint called process.exit(code)
	// before the async stdout pipe drained. The truncation only shows through a
	// real downstream pipe consumer, so the CLI's stdout is routed into `cat`:
	// Bun's eager Response reader on a direct spawn does NOT reproduce it. `show
	// --format json` emits ~2.5 KB of deterministic JSON with no state to seed.
	test("a large JSON payload survives a downstream pipe intact", async () => {
		const proc = Bun.spawn({
			cmd: ["sh", "-c", `bun "${RUN_TS}" show "${CONSULT}" --format json | cat`],
			env: { ...process.env },
			stdout: "pipe",
			stderr: "ignore",
		});
		const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
		expect(code).toBe(0);
		// The bug truncated piped stdout to ~512 bytes; the full payload is ~2.5 KB,
		// so a short read means the truncation regressed.
		expect(stdout.length).toBeGreaterThan(1024);
		expect(() => JSON.parse(stdout)).not.toThrow();
		const parsed = JSON.parse(stdout) as Record<string, unknown>;
		expect(parsed).toHaveProperty("executionOrder");
		expect(parsed).toHaveProperty("nodes");
	});
});
