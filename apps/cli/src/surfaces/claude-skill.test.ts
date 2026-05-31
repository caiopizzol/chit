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
import { INSTALL_MARKER_FILENAME } from "@chit/core";
import { installClaudeSkill, SurfaceInstallError } from "./claude-skill.ts";

const PROJECT_ROOT = join(import.meta.dir, "..", "..");
const CONSULT_PATH = join(PROJECT_ROOT, "examples", "consult.json");
const ASK_CODEX_PATH = join(PROJECT_ROOT, "examples", "ask-codex.json");
const INVESTIGATE_BUG_PATH = join(PROJECT_ROOT, "examples", "investigate-bug.json");

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
let SKILLS_DIR: string;
let FAKE_BIN_DIR: string;

beforeAll(() => {
	TMPDIR = mkdtempSync(join(tmpdir(), "handoff-skill-"));
	SKILLS_DIR = join(TMPDIR, "skills");
	mkdirSync(SKILLS_DIR, { recursive: true });
	FAKE_BIN_DIR = join(TMPDIR, "bin");
	mkdirSync(FAKE_BIN_DIR, { recursive: true });
	const codex = join(FAKE_BIN_DIR, "codex");
	writeFileSync(codex, FAKE_CODEX);
	chmodSync(codex, 0o755);
	const claude = join(FAKE_BIN_DIR, "claude");
	writeFileSync(claude, FAKE_CLAUDE);
	chmodSync(claude, 0o755);
});

afterAll(() => {
	rmSync(TMPDIR, { recursive: true, force: true });
});

// The generated SKILL.md uses the ```! preprocessor fence (Claude Code
// pre-executes it). For tests, we extract the body and run it under bash
// directly — same content, just bypassing Claude Code's preprocessor.
function extractBashBlock(skillMd: string): string {
	const match = skillMd.match(/```!\n([\s\S]*?)```/);
	if (!match || match[1] === undefined) throw new Error("no ```! block in SKILL.md");
	return match[1];
}

async function runBash(
	body: string,
	env: Record<string, string>,
	cwd: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
	const proc = Bun.spawn({
		cmd: ["bash", "-c", body],
		env,
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { stdout, stderr, code };
}

describe("installClaudeSkill: file generation", () => {
	test("creates SKILL.md and manifest.json in <outputDir>/<id>/", () => {
		const manifestPath = CONSULT_PATH;
		const out = mkdtempSync(join(TMPDIR, "install-"));
		const result = installClaudeSkill({
			manifestPath,
			outputDir: out,
			runtimePath: PROJECT_ROOT,
			allowUnenforcedPermissions: true,
		});
		expect(result.skillDir).toBe(join(out, "consult"));
		expect(existsSync(result.skillMdPath)).toBe(true);
		expect(existsSync(result.manifestPath)).toBe(true);
		const persisted = JSON.parse(readFileSync(result.manifestPath, "utf-8"));
		expect(persisted.id).toBe("consult");
		expect(persisted.participants.codex).toBeDefined();
		expect(persisted.participants.claude).toBeDefined();
	});

	test("SKILL.md frontmatter has manifest id and description", () => {
		const manifestPath = CONSULT_PATH;
		const sourceDescription = JSON.parse(readFileSync(manifestPath, "utf-8")).description;
		const out = mkdtempSync(join(TMPDIR, "install-"));
		const r = installClaudeSkill({
			manifestPath,
			outputDir: out,
			runtimePath: PROJECT_ROOT,
			allowUnenforcedPermissions: true,
		});
		const md = readFileSync(r.skillMdPath, "utf-8");
		expect(md).toContain("name: consult");
		expect(md).toContain(sourceDescription);
		expect(md).toContain("argument-hint: <question>");
	});

	test("SKILL.md uses the `!` preprocessor fence so Claude Code pre-executes it", () => {
		const manifestPath = CONSULT_PATH;
		const out = mkdtempSync(join(TMPDIR, "install-"));
		const r = installClaudeSkill({
			manifestPath,
			outputDir: out,
			runtimePath: PROJECT_ROOT,
			allowUnenforcedPermissions: true,
		});
		const md = readFileSync(r.skillMdPath, "utf-8");
		// Critical: the fence must be ```! (preprocessor) not ```bash (plain
		// prompt content). With ```bash, Claude reads the markdown and may
		// choose not to execute it. With ```!, Claude Code runs it before
		// the model sees the rendered skill.
		expect(md).toContain("```!");
		expect(md).not.toMatch(/```bash/);
		// And critically, NOT the original shell-interpolation form.
		expect(md).not.toContain('--input "question=$ARGUMENTS"');
	});

	test("SKILL.md bash invokes shared runtime with manifest.json path and stdin heredoc", () => {
		const manifestPath = CONSULT_PATH;
		const out = mkdtempSync(join(TMPDIR, "install-"));
		const r = installClaudeSkill({
			manifestPath,
			outputDir: out,
			runtimePath: PROJECT_ROOT,
			allowUnenforcedPermissions: true,
		});
		const body = extractBashBlock(readFileSync(r.skillMdPath, "utf-8"));
		expect(body).toContain(`bun "${PROJECT_ROOT}/src/cli/run.ts" run`);
		expect(body).toContain("CLAUDE_SKILL_DIR");
		expect(body).toContain("manifest.json");
		expect(body).toContain("--scope");
		expect(body).toContain("--allow-unenforced-permissions");
		// User input flows through --input-stdin + single-quoted heredoc, not
		// through shell interpolation. This is the shell-injection hardening.
		expect(body).toContain("--input-stdin question");
		// Heredoc delimiter is randomized per install (16 hex chars of entropy),
		// to make accidental collision with user input astronomically unlikely.
		expect(body).toMatch(/<<'HANDOFF_INPUT_[0-9A-F]{16}_EOF'/);
		// Body is wrapped in `{ ... } 2>&1` so stderr (the unenforced-permission
		// WARNING and any runtime errors) reaches the captured output that
		// Claude sees in place of the fenced block.
		expect(body).toContain("} 2>&1");
	});

	test("SKILL.md bakes --trace only when requested", () => {
		const out = mkdtempSync(join(TMPDIR, "install-"));
		const traced = installClaudeSkill({
			manifestPath: CONSULT_PATH,
			outputDir: out,
			runtimePath: PROJECT_ROOT,
			allowUnenforcedPermissions: true,
			trace: true,
		});
		expect(extractBashBlock(readFileSync(traced.skillMdPath, "utf-8"))).toContain("--trace");

		const out2 = mkdtempSync(join(TMPDIR, "install-"));
		const plain = installClaudeSkill({
			manifestPath: CONSULT_PATH,
			outputDir: out2,
			runtimePath: PROJECT_ROOT,
			allowUnenforcedPermissions: true,
		});
		expect(extractBashBlock(readFileSync(plain.skillMdPath, "utf-8"))).not.toContain("--trace");
	});

	test("heredoc delimiter is randomized per install (accidental-collision resistance)", () => {
		const manifestPath = CONSULT_PATH;
		const r1 = installClaudeSkill({
			manifestPath,
			outputDir: mkdtempSync(join(TMPDIR, "install-")),
			runtimePath: PROJECT_ROOT,
			allowUnenforcedPermissions: true,
		});
		const r2 = installClaudeSkill({
			manifestPath,
			outputDir: mkdtempSync(join(TMPDIR, "install-")),
			runtimePath: PROJECT_ROOT,
			allowUnenforcedPermissions: true,
		});
		const m1 = /HANDOFF_INPUT_([0-9A-F]{16})_EOF/.exec(readFileSync(r1.skillMdPath, "utf-8"));
		const m2 = /HANDOFF_INPUT_([0-9A-F]{16})_EOF/.exec(readFileSync(r2.skillMdPath, "utf-8"));
		expect(m1).not.toBeNull();
		expect(m2).not.toBeNull();
		expect(m1?.[1]).not.toBe(m2?.[1]);
	});

	test("SKILL.md bash exits 2 when CLAUDE_SESSION_ID is missing", async () => {
		const manifestPath = CONSULT_PATH;
		const out = mkdtempSync(join(TMPDIR, "install-"));
		const r = installClaudeSkill({
			manifestPath,
			outputDir: out,
			runtimePath: PROJECT_ROOT,
			allowUnenforcedPermissions: true,
		});
		const body = extractBashBlock(readFileSync(r.skillMdPath, "utf-8")).replace(
			/\$ARGUMENTS/g,
			"hi",
		);
		const env: Record<string, string> = {
			PATH: process.env.PATH ?? "",
			CLAUDE_SKILL_DIR: r.skillDir,
		};
		// Deliberately omit CLAUDE_SESSION_ID
		const proc = Bun.spawn({
			cmd: ["bash", "-c", body],
			env,
			cwd: out,
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
		expect(code).toBe(2);
		// The bash uses `{ ... } 2>&1` so stderr is folded into stdout, where
		// Claude Code's `! ` preprocessor will see and surface it.
		expect(stdout).toContain("CLAUDE_SESSION_ID is required");
	});

	test("SKILL.md omits --allow-unenforced when there are no gaps (codex-only manifest)", () => {
		const manifestPath = ASK_CODEX_PATH;
		const out = mkdtempSync(join(TMPDIR, "install-"));
		const r = installClaudeSkill({
			manifestPath,
			outputDir: out,
			runtimePath: PROJECT_ROOT,
		});
		const body = extractBashBlock(readFileSync(r.skillMdPath, "utf-8"));
		expect(body).not.toContain("--allow-unenforced-permissions");
	});
});

describe("installClaudeSkill: install marker", () => {
	test("writes .handoff-install.json with provenance fields", () => {
		const manifestPath = CONSULT_PATH;
		const out = mkdtempSync(join(TMPDIR, "install-"));
		const r = installClaudeSkill({
			manifestPath,
			outputDir: out,
			runtimePath: PROJECT_ROOT,
			allowUnenforcedPermissions: true,
		});
		expect(r.markerPath).toBe(join(r.skillDir, INSTALL_MARKER_FILENAME));
		expect(existsSync(r.markerPath)).toBe(true);
		const marker = JSON.parse(readFileSync(r.markerPath, "utf-8"));
		expect(marker.schema).toBe(1);
		expect(marker.surface).toBe("claude-skill");
		expect(marker.installName).toBe("consult");
		expect(marker.manifestId).toBe("consult");
		expect(marker.runtimePath).toBe(PROJECT_ROOT);
		expect(typeof marker.installedAt).toBe("string");
		expect(marker.installedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		// SHA-256 hex of the persisted manifest.json contents (64 hex chars).
		expect(marker.manifestHash).toMatch(/^[a-f0-9]{64}$/);
	});

	test("marker records overrideName in installName, not manifestId", () => {
		const manifestPath = CONSULT_PATH;
		const r = installClaudeSkill({
			manifestPath,
			outputDir: mkdtempSync(join(TMPDIR, "install-")),
			runtimePath: PROJECT_ROOT,
			allowUnenforcedPermissions: true,
			overrideName: "handoff-consult",
		});
		const marker = JSON.parse(readFileSync(r.markerPath, "utf-8"));
		expect(marker.installName).toBe("handoff-consult");
		expect(marker.manifestId).toBe("consult");
	});

	test("manifestHash matches sha256 of the persisted manifest.json contents", async () => {
		const manifestPath = CONSULT_PATH;
		const r = installClaudeSkill({
			manifestPath,
			outputDir: mkdtempSync(join(TMPDIR, "install-")),
			runtimePath: PROJECT_ROOT,
			allowUnenforcedPermissions: true,
		});
		const manifestBytes = readFileSync(r.manifestPath);
		const hasher = new Bun.CryptoHasher("sha256");
		hasher.update(manifestBytes);
		const expected = hasher.digest("hex");
		const marker = JSON.parse(readFileSync(r.markerPath, "utf-8"));
		expect(marker.manifestHash).toBe(expected);
	});
});

describe("installClaudeSkill: validation", () => {
	test("refuses install when permissions unenforceable and flag not set", () => {
		const manifestPath = CONSULT_PATH;
		expect(() =>
			installClaudeSkill({
				manifestPath,
				outputDir: mkdtempSync(join(TMPDIR, "install-")),
				runtimePath: PROJECT_ROOT,
				allowUnenforcedPermissions: false,
			}),
		).toThrow(SurfaceInstallError);
	});

	test("refuses install when surface lacks a required capability (file[] input)", () => {
		const manifestPath = INVESTIGATE_BUG_PATH;
		expect(() =>
			installClaudeSkill({
				manifestPath,
				outputDir: mkdtempSync(join(TMPDIR, "install-")),
				runtimePath: PROJECT_ROOT,
				allowUnenforcedPermissions: true,
			}),
		).toThrow(/can_pass_files/);
	});

	test("refuses install when target dir exists without force", () => {
		const manifestPath = CONSULT_PATH;
		const out = mkdtempSync(join(TMPDIR, "install-"));
		installClaudeSkill({
			manifestPath,
			outputDir: out,
			runtimePath: PROJECT_ROOT,
			allowUnenforcedPermissions: true,
		});
		expect(() =>
			installClaudeSkill({
				manifestPath,
				outputDir: out,
				runtimePath: PROJECT_ROOT,
				allowUnenforcedPermissions: true,
			}),
		).toThrow(/already exists/);
	});

	test("force=true replaces target dir, removing residual files", () => {
		const manifestPath = CONSULT_PATH;
		const out = mkdtempSync(join(TMPDIR, "install-"));
		const r1 = installClaudeSkill({
			manifestPath,
			outputDir: out,
			runtimePath: PROJECT_ROOT,
			allowUnenforcedPermissions: true,
		});

		// Drop a residual file as if from a prior unrelated install
		const stale = join(r1.skillDir, "scripts", "old.js");
		mkdirSync(join(r1.skillDir, "scripts"), { recursive: true });
		writeFileSync(stale, "// old bundle");
		expect(existsSync(stale)).toBe(true);

		const r2 = installClaudeSkill({
			manifestPath,
			outputDir: out,
			runtimePath: PROJECT_ROOT,
			allowUnenforcedPermissions: true,
			force: true,
		});
		expect(r2.skillDir).toBe(r1.skillDir);
		expect(existsSync(r2.skillMdPath)).toBe(true);
		// The residual scripts dir from the prior install is gone.
		expect(existsSync(stale)).toBe(false);
		expect(existsSync(join(r2.skillDir, "scripts"))).toBe(false);
	});

	test("overrideName with path-traversal sequence is rejected", () => {
		const manifestPath = CONSULT_PATH;
		expect(() =>
			installClaudeSkill({
				manifestPath,
				outputDir: mkdtempSync(join(TMPDIR, "install-")),
				runtimePath: PROJECT_ROOT,
				allowUnenforcedPermissions: true,
				overrideName: "../escape",
			}),
		).toThrow(/overrideName.*invalid/);
	});

	test("overrideName with slash is rejected", () => {
		const manifestPath = CONSULT_PATH;
		expect(() =>
			installClaudeSkill({
				manifestPath,
				outputDir: mkdtempSync(join(TMPDIR, "install-")),
				runtimePath: PROJECT_ROOT,
				allowUnenforcedPermissions: true,
				overrideName: "evil/payload",
			}),
		).toThrow(/overrideName.*invalid/);
	});

	test("overrideName with uppercase or dots is rejected", () => {
		const manifestPath = CONSULT_PATH;
		expect(() =>
			installClaudeSkill({
				manifestPath,
				outputDir: mkdtempSync(join(TMPDIR, "install-")),
				runtimePath: PROJECT_ROOT,
				allowUnenforcedPermissions: true,
				overrideName: "Foo.Bar",
			}),
		).toThrow(/overrideName.*invalid/);
	});

	test("relative runtimePath is normalized to absolute in generated SKILL.md", () => {
		const manifestPath = CONSULT_PATH;
		const r = installClaudeSkill({
			manifestPath,
			outputDir: mkdtempSync(join(TMPDIR, "install-")),
			runtimePath: ".",
			allowUnenforcedPermissions: true,
		});
		const md = readFileSync(r.skillMdPath, "utf-8");
		// The bash block must contain an absolute path under `bun "<...>"`,
		// not a relative one, so it works regardless of the cwd Claude Code
		// launches from.
		const match = md.match(/bun "([^"]+)\/src\/cli\/run\.ts" run/);
		expect(match).not.toBeNull();
		expect(match?.[1]?.startsWith("/")).toBe(true);
	});

	test("overrideName affects folder name and SKILL.md frontmatter", () => {
		const manifestPath = CONSULT_PATH;
		const out = mkdtempSync(join(TMPDIR, "install-"));
		const r = installClaudeSkill({
			manifestPath,
			outputDir: out,
			runtimePath: PROJECT_ROOT,
			allowUnenforcedPermissions: true,
			overrideName: "handoff-consult",
		});
		expect(r.skillDir).toBe(join(out, "handoff-consult"));
		const md = readFileSync(r.skillMdPath, "utf-8");
		expect(md).toContain("name: handoff-consult");
		expect(md).toContain("# /handoff-consult");
		// Manifest id inside the persisted manifest.json is untouched (it's
		// the recipe's stable identity, not the install location).
		const m = JSON.parse(readFileSync(r.manifestPath, "utf-8"));
		expect(m.id).toBe("consult");
	});

	test("refuses install when manifest references unknown agent", () => {
		const manifestPath = join(TMPDIR, "bad-agent.json");
		writeFileSync(
			manifestPath,
			JSON.stringify({
				schema: 1,
				id: "bad-agent",
				description: "references an agent that doesn't exist",
				inputs: { question: { type: "string" } },
				participants: {
					ghost: { agent: "does-not-exist", role: "x", session: "stateless" },
				},
				steps: {
					ask: { call: "ghost", prompt: "{{ inputs.question }}" },
					out: { format: "{{ steps.ask.output }}" },
				},
				output: "out",
			}),
		);
		expect(() =>
			installClaudeSkill({
				manifestPath,
				outputDir: mkdtempSync(join(TMPDIR, "install-")),
				runtimePath: PROJECT_ROOT,
				allowUnenforcedPermissions: true,
			}),
		).toThrow(/unknown agent "does-not-exist"/);
	});

	test("returns the enforcement gaps it accepted (for traceability)", () => {
		const manifestPath = CONSULT_PATH;
		const r = installClaudeSkill({
			manifestPath,
			outputDir: mkdtempSync(join(TMPDIR, "install-")),
			runtimePath: PROJECT_ROOT,
			allowUnenforcedPermissions: true,
		});
		expect(r.enforcementGaps.length).toBe(1);
		expect(r.enforcementGaps[0]?.participantId).toBe("claude");
		expect(r.enforcementGaps[0]?.permission).toBe("filesystem: read_only");
	});
});

describe("installClaudeSkill: acceptance round-trip", () => {
	test("installed skill resumes across invocations with same Claude session id", async () => {
		const manifestPath = CONSULT_PATH;
		const out = mkdtempSync(join(TMPDIR, "install-"));
		const stateDir = mkdtempSync(join(TMPDIR, "state-"));

		const r = installClaudeSkill({
			manifestPath,
			outputDir: out,
			runtimePath: PROJECT_ROOT,
			allowUnenforcedPermissions: true,
		});

		const bashBody = extractBashBlock(readFileSync(r.skillMdPath, "utf-8"));
		const sharedEnv: Record<string, string> = {
			...(process.env as Record<string, string>),
			PATH: `${FAKE_BIN_DIR}:${process.env.PATH ?? ""}`,
			CLAUDE_SESSION_ID: "fixed-claude-session",
			CLAUDE_SKILL_DIR: r.skillDir,
			ARGUMENTS: "hi",
			XDG_STATE_HOME: stateDir,
		};

		// Claude Code substitutes $ARGUMENTS literally before running the bash.
		// Mirror that here so the bash sees a real "hi".
		const bodyWithArgs = bashBody.replace(/\$ARGUMENTS/g, "hi");

		// First run: fresh sessions, both adapters emit *_ANSWER outputs.
		const r1 = await runBash(bodyWithArgs, sharedEnv, out);
		expect(r1.code).toBe(0);
		expect(r1.stdout).toContain("CODEX_ANSWER");
		expect(r1.stdout).toContain("CLAUDE_ANSWER");
		// `{ ... } 2>&1` folds the runtime's stderr WARNING into stdout, so
		// Claude Code's `! ` preprocessor sees it and surfaces it to the user.
		expect(r1.stdout).toContain("WARNING");
		expect(r1.stdout).toContain("unenforced permissions");

		// Session file is written under the temp XDG_STATE_HOME.
		const sessionsDir = join(stateDir, "handoff", "sessions");
		expect(existsSync(sessionsDir)).toBe(true);
		const files = readdirSync(sessionsDir);
		expect(files.length).toBe(1);

		// Second run: same Claude session id + same worktree => same scope =>
		// session loaded => both adapters take the resume path.
		const r2 = await runBash(bodyWithArgs, sharedEnv, out);
		expect(r2.code).toBe(0);
		expect(r2.stdout).toContain("CODEX_RESUMED");
		expect(r2.stdout).toContain("CLAUDE_RESUMED");
	});

	test("shell metacharacters in $ARGUMENTS reach the adapter as literal text", async () => {
		// Set up a fake codex that captures stdin to a file (we then read it
		// back to verify what the adapter actually received).
		const captureDir = mkdtempSync(join(TMPDIR, "capture-"));
		const captureFile = join(captureDir, "codex-stdin.txt");
		const captureBinDir = mkdtempSync(join(TMPDIR, "capture-bin-"));
		const fakeCodex = join(captureBinDir, "codex");
		writeFileSync(
			fakeCodex,
			`#!/bin/sh\ncat > "${captureFile}"\necho '{"type":"thread.started","thread_id":"t"}'\necho '{"type":"item.completed","item":{"type":"agent_message","text":"OK"}}'\n`,
		);
		chmodSync(fakeCodex, 0o755);
		const fakeClaude = join(captureBinDir, "claude");
		writeFileSync(
			fakeClaude,
			'#!/bin/sh\ncat > /dev/null\necho \'{"type":"system","subtype":"init","session_id":"x"}\'\necho \'{"type":"result","session_id":"x","result":"OK","subtype":"success","is_error":false}\'\n',
		);
		chmodSync(fakeClaude, 0o755);

		const manifestPath = CONSULT_PATH;
		const out = mkdtempSync(join(TMPDIR, "install-"));
		const stateDir = mkdtempSync(join(TMPDIR, "state-"));
		const r = installClaudeSkill({
			manifestPath,
			outputDir: out,
			runtimePath: PROJECT_ROOT,
			allowUnenforcedPermissions: true,
		});

		// Payload includes $(...), backticks, quotes, and a metacharacter sequence
		// that would have catastrophic effects if expanded by the shell.
		const payload = "$(echo PWNED) `id` \"x\" 'y' && rm -rf /";
		const body = extractBashBlock(readFileSync(r.skillMdPath, "utf-8")).replace(
			/\$ARGUMENTS/g,
			payload,
		);
		const env: Record<string, string> = {
			PATH: `${captureBinDir}:${process.env.PATH ?? ""}`,
			CLAUDE_SESSION_ID: "injection-test",
			CLAUDE_SKILL_DIR: r.skillDir,
			XDG_STATE_HOME: stateDir,
		};
		const result = await runBash(body, env, out);
		expect(result.code).toBe(0);

		// The captured codex stdin must contain the literal payload, including
		// the unexpanded $(...) and `...` and the verbatim "&& rm -rf /". If
		// the heredoc were not single-quoted, $(echo PWNED) would expand to
		// "PWNED" and `id` would expand to the user id; neither should appear.
		const captured = readFileSync(captureFile, "utf-8");
		expect(captured).toContain("$(echo PWNED)");
		expect(captured).toContain("`id`");
		expect(captured).toContain("&& rm -rf /");
	});

	test("permission warning fires every run, matching CLI behavior", async () => {
		const manifestPath = CONSULT_PATH;
		const out = mkdtempSync(join(TMPDIR, "install-"));
		const stateDir = mkdtempSync(join(TMPDIR, "state-"));
		const r = installClaudeSkill({
			manifestPath,
			outputDir: out,
			runtimePath: PROJECT_ROOT,
			allowUnenforcedPermissions: true,
		});
		const body = extractBashBlock(readFileSync(r.skillMdPath, "utf-8")).replace(
			/\$ARGUMENTS/g,
			"hi",
		);
		const env: Record<string, string> = {
			...(process.env as Record<string, string>),
			PATH: `${FAKE_BIN_DIR}:${process.env.PATH ?? ""}`,
			CLAUDE_SESSION_ID: "another-session",
			CLAUDE_SKILL_DIR: r.skillDir,
			XDG_STATE_HOME: stateDir,
		};
		const first = await runBash(body, env, out);
		const second = await runBash(body, env, out);
		// `{ ... } 2>&1` folds the runtime's stderr into the captured stdout.
		expect(first.stdout).toContain("WARNING");
		expect(second.stdout).toContain("WARNING");
	});
});
