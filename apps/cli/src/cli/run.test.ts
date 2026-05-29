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
import { parseArgs } from "./run.ts";

const PROJECT_ROOT = join(import.meta.dir, "..", "..");
const RUN_TS = join(PROJECT_ROOT, "src", "cli", "run.ts");
const ASK_CODEX = join(PROJECT_ROOT, "examples", "ask-codex.json");
const ASK_CLAUDE = join(PROJECT_ROOT, "examples", "ask-claude.json");
const CONSULT_STATELESS = join(PROJECT_ROOT, "examples", "consult-stateless.json");
const CONSULT = join(PROJECT_ROOT, "examples", "consult.json");

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
if [ "$IS_RESUME" = "1" ]; then
  echo '{"session_id":"claude-session-2","result":"CLAUDE_RESUMED: yes","subtype":"success","is_error":false}'
else
  echo '{"session_id":"claude-session-1","result":"CLAUDE_ANSWER: yes","subtype":"success","is_error":false}'
fi
`;

let TMPDIR: string;
let FAKE_BIN_DIR: string;

beforeAll(() => {
	TMPDIR = mkdtempSync(join(tmpdir(), "handoff-cli-"));
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
			"/proj/handoff",
			"--name",
			"my-skill",
			"--force",
			"--allow-unenforced-permissions",
		]);
		expect(args.command).toBe("install");
		expect(args.manifestPath).toBe("m.json");
		expect(args.installAs).toBe("claude-skill");
		expect(args.outputDir).toBe("/tmp/skills");
		expect(args.runtimePath).toBe("/proj/handoff");
		expect(args.overrideName).toBe("my-skill");
		expect(args.force).toBe(true);
		expect(args.allowUnenforcedPermissions).toBe(true);
	});

	test("--trace captured on run, defaults false", () => {
		expect(parseArgs(["run", "m.json", "--trace"]).trace).toBe(true);
		expect(parseArgs(["run", "m.json"]).trace).toBe(false);
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
});

describe("handoff run (subprocess)", () => {
	test("ask-codex.json end-to-end with fake codex", async () => {
		const { stdout, code } = await runCLI([
			"run",
			ASK_CODEX,
			"--input",
			"question=what is the meaning of life",
		]);
		expect(code).toBe(0);
		expect(stdout).toContain("CODEX_ANSWER: 42");
	});

	test("ask-claude.json end-to-end with fake claude (needs allow-unenforced)", async () => {
		const { stdout, code } = await runCLI([
			"run",
			ASK_CLAUDE,
			"--allow-unenforced-permissions",
			"--input",
			"question=is it tuesday",
		]);
		expect(code).toBe(0);
		expect(stdout).toContain("CLAUDE_ANSWER: yes");
	});

	test("consult-stateless.json runs codex + claude in parallel", async () => {
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

	test("rejects claude manifest without --allow-unenforced-permissions", async () => {
		const { stderr, code } = await runCLI(["run", ASK_CLAUDE, "--input", "question=hi"]);
		expect(code).toBe(2);
		expect(stderr).toContain("cannot enforce required permissions");
		expect(stderr).toContain("filesystem: read_only");
		expect(stderr).toContain("claude");
		expect(stderr).toContain("--allow-unenforced-permissions");
	});

	test("claude manifest with --allow-unenforced-permissions runs and warns on stderr", async () => {
		const { stderr, code } = await runCLI([
			"run",
			ASK_CLAUDE,
			"--allow-unenforced-permissions",
			"--input",
			"question=hi",
		]);
		expect(code).toBe(0);
		expect(stderr).toContain("WARNING");
		expect(stderr).toContain("unenforced permissions");
		expect(stderr).toContain("claude");
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

		// Session file exists with payloads for both participants.
		const sessionsDir = join(TMPDIR, "handoff", "sessions");
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
		const { stderr, code } = await runCLI(["run", "/tmp/does-not-exist-handoff.json"]);
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
			"handoff-ask",
		]);
		expect(code).toBe(0);
		expect(existsSync(join(target, "handoff-ask", "SKILL.md"))).toBe(true);
		const md = readFileSync(join(target, "handoff-ask", "SKILL.md"), "utf-8");
		expect(md).toContain("name: handoff-ask");
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

	test("show against claude-skill surface flags claude's unenforced permissions", async () => {
		const { stdout, code } = await runCLI([
			"show",
			CONSULT,
			"--surface",
			"claude-skill",
			"--format",
			"ascii",
		]);
		expect(code).toBe(0);
		expect(stdout).toContain("NEEDS OVERRIDE");
		expect(stdout).toContain("claude");
		expect(stdout).toContain("cannot enforce");
	});

	test("show against claude-skill surface flags can_pass_files missing for file[] inputs", async () => {
		const investigateBug = join(PROJECT_ROOT, "examples", "investigate-bug.json");
		const { stdout, code } = await runCLI([
			"show",
			investigateBug,
			"--surface",
			"claude-skill",
			"--format",
			"ascii",
		]);
		expect(code).toBe(0);
		expect(stdout).toContain("INCOMPATIBLE");
		expect(stdout).toContain("can_pass_files");
	});

	test("install rejects claude manifest without --allow-unenforced-permissions", async () => {
		const target = mkdtempSync(join(TMPDIR, "install-target-"));
		const { stderr, code } = await runCLI([
			"install",
			ASK_CLAUDE,
			"--as",
			"claude-skill",
			"--to",
			target,
			"--runtime-path",
			PROJECT_ROOT,
		]);
		expect(code).toBe(2);
		expect(stderr).toContain("cannot enforce required permissions");
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
		expect(stderr).toContain(".handoff-install.json");
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
		// Two parent dirs, both legitimate handoff `--to` locations. Without
		// the kebab-case check in lifecycle.uninstall, `uninstall ../sensitive`
		// against parent A could rm-rf the install in parent B (the sibling
		// path resolves outside A but happens to carry a valid marker).
		const intended = mkdtempSync(join(TMPDIR, "uninstall-intended-"));
		const sensitive = mkdtempSync(join(TMPDIR, "uninstall-sensitive-"));
		// Install a real handoff skill into the "sensitive" location.
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
