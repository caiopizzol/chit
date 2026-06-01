import { afterAll, beforeAll, describe, expect, test } from "bun:test";
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
import { AuditStore } from "../audit/store.ts";
import { parseArgs } from "./run.ts";

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
  echo '{"type":"assistant","message":{"role":"assistant"}}'
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
				role: "Answer briefly. Cite file:line for any claim about code.",
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
				role: "Answer briefly. Cite file:line for any claim about code.",
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
			codex: { agent: "codex", role: "Second opinion advisor.", session: "stateless" },
			claude: { agent: "claude", role: "Second opinion advisor.", session: "stateless" },
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
			codex: { agent: "codex", role: "Read the files.", session: "stateless" },
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

	test("studio with no args parses with empty manifestPath (discovery mode)", () => {
		const args = parseArgs(["studio"]);
		expect(args.command).toBe("studio");
		expect(args.manifestPath).toBeUndefined();
	});

	test("studio captures an explicit path", () => {
		const args = parseArgs(["studio", "consult.json"]);
		expect(args.command).toBe("studio");
		expect(args.manifestPath).toBe("consult.json");
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
