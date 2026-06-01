import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeCliAdapter } from "./claude-cli.ts";

// Fake claude shell script emitting stream-json (one JSON event per line ending
// in a `result` event), mirroring `claude --print --verbose --output-format
// stream-json --include-partial-messages`. Resume mode is detected by `--resume`
// in argv. The leading system/stream_event/assistant lines stand in for the
// observable event stream the adapter forwards to onEvent.
const FAKE_CLAUDE = `#!/bin/sh
IS_RESUME=0
for arg in "$@"; do
  if [ "$arg" = "--resume" ]; then IS_RESUME=1; fi
done

emit_stream() {
  echo '{"type":"system","subtype":"init","session_id":"'"$1"'"}'
  echo '{"type":"stream_event","event":{"type":"content_block_delta"}}'
  echo '{"type":"assistant","message":{"role":"assistant"}}'
}

if [ -n "$CHIT_TEST_SLEEP" ]; then
  cat > /dev/null
  # exec so the long-runner IS the spawned process (as the real claude binary
  # is), not an orphanable child: proc.kill() then terminates it and closes its
  # pipes. proc.kill() reaches only this direct child, not a descendant tree.
  exec sleep "$CHIT_TEST_SLEEP"
fi

if [ -n "$CHIT_TEST_FAKE_EXIT" ] && [ "$CHIT_TEST_FAKE_EXIT" != "0" ]; then
  cat > /dev/null
  echo "boom: claude error" >&2
  exit "$CHIT_TEST_FAKE_EXIT"
fi
# Emit a full stream-json prefix (system/stream_event/assistant, no result) and
# THEN exit non-zero, standing in for a claude that streamed observable work and
# then crashed. The adapter must still surface those events to onEvent before it
# throws on the non-zero exit code.
if [ -n "$CHIT_TEST_CLAUDE_EMIT_THEN_FAIL" ]; then
  cat > /dev/null
  emit_stream "fake-claude-session"
  echo "boom: claude crashed mid-stream" >&2
  exit 7
fi
# Liveness gate: emit the system line, then BLOCK until the test creates the wait
# file. The test creates it only from inside onEvent, so the process can finish
# only if the system event was surfaced to onEvent WHILE this process was still
# running. A buffered (post-exit) reader would deadlock here.
if [ -n "$CHIT_TEST_CLAUDE_WAIT_FILE" ]; then
  cat > /dev/null
  echo '{"type":"system","subtype":"init","session_id":"live-claude"}'
  while [ ! -f "$CHIT_TEST_CLAUDE_WAIT_FILE" ]; do sleep 0.02; done
  echo '{"type":"result","session_id":"live-claude","result":"LIVE: claude done","subtype":"success","is_error":false}'
  exit 0
fi
# Drip gate: emit a stream_event every ~120ms for ~5 lines (total well over a
# 400ms no-progress timeout), so the run only completes if the watchdog RESETS on
# each chunk. Without per-chunk reset it would fire mid-drip.
if [ -n "$CHIT_TEST_CLAUDE_DRIP" ]; then
  cat > /dev/null
  echo '{"type":"system","subtype":"init","session_id":"drip-claude"}'
  i=0
  while [ "$i" -lt 5 ]; do
    sleep 0.12
    echo '{"type":"stream_event","event":{"type":"content_block_delta"}}'
    i=$((i + 1))
  done
  echo '{"type":"result","session_id":"drip-claude","result":"DRIP: claude done","subtype":"success","is_error":false}'
  exit 0
fi
if [ -n "$CHIT_TEST_CLAUDE_ENV_FILE" ]; then
  printf 'CLAUDECODE=%s\\n' "$CLAUDECODE" > "$CHIT_TEST_CLAUDE_ENV_FILE"
fi
if [ -n "$CHIT_TEST_LAST_INPUT" ]; then
  cat > "$CHIT_TEST_LAST_INPUT"
else
  cat > /dev/null
fi
if [ -n "$CHIT_TEST_CLAUDE_BAD_JSON" ]; then
  echo "not json at all"
  exit 0
fi
if [ -n "$CHIT_TEST_CLAUDE_NO_RESULT" ]; then
  emit_stream "fake-claude-session"
  exit 0
fi
if [ -n "$CHIT_TEST_CLAUDE_IS_ERROR" ]; then
  emit_stream "fake-claude-session"
  echo '{"type":"result","is_error":true,"result":"claude blew up","subtype":"error_during_execution"}'
  exit 0
fi
if [ -n "$CHIT_TEST_CLAUDE_USAGE" ]; then
  emit_stream "fake-claude-session"
  echo '{"type":"result","session_id":"fake-claude-session","result":"OK","subtype":"success","is_error":false,"usage":{"input_tokens":6590,"output_tokens":4,"cache_read_input_tokens":17308,"cache_creation_input_tokens":3851},"total_cost_usd":0.0657}'
  exit 0
fi
if [ -n "$CHIT_TEST_CLAUDE_USAGE_BAD" ]; then
  emit_stream "fake-claude-session"
  echo '{"type":"result","session_id":"fake-claude-session","result":"OK","subtype":"success","is_error":false,"usage":{"input_tokens":-1,"output_tokens":1.5,"cache_read_input_tokens":2},"total_cost_usd":-0.5}'
  exit 0
fi

if [ "$IS_RESUME" = "1" ]; then
  emit_stream "resumed-session"
  echo '{"type":"result","session_id":"resumed-session","result":"RESUMED: claude received your prompt","subtype":"success","is_error":false}'
else
  emit_stream "fake-claude-session"
  echo '{"type":"result","session_id":"fake-claude-session","result":"OK: claude received your prompt","subtype":"success","is_error":false}'
fi
`;

const FAKE_CLAUDE_ARGS_RECORDER = `#!/bin/sh
if [ -n "$CHIT_TEST_ARGS_FILE" ]; then
  for arg in "$@"; do
    printf '%s\\n' "$arg" >> "$CHIT_TEST_ARGS_FILE"
  done
fi
cat > /dev/null
echo '{"type":"result","session_id":"fake","result":"OK","subtype":"success","is_error":false}'
`;

let TMPDIR: string;
let FAKE_BIN_DIR: string;
let savedPath: string | undefined;

beforeAll(() => {
	TMPDIR = mkdtempSync(join(tmpdir(), "chit-claude-"));
	FAKE_BIN_DIR = join(TMPDIR, "bin");
	mkdirSync(FAKE_BIN_DIR, { recursive: true });
	writeFakeBin("claude", FAKE_CLAUDE);
	savedPath = process.env.PATH;
	process.env.PATH = `${FAKE_BIN_DIR}:${savedPath}`;
});

afterAll(() => {
	if (savedPath !== undefined) process.env.PATH = savedPath;
	rmSync(TMPDIR, { recursive: true, force: true });
});

function writeFakeBin(name: string, body: string): void {
	const path = join(FAKE_BIN_DIR, name);
	writeFileSync(path, body);
	chmodSync(path, 0o755);
}

describe("ClaudeCliAdapter: stdin and parsing", () => {
	test("sends adapter input to claude stdin and returns the result field", async () => {
		const promptFile = join(TMPDIR, "last-input-1.txt");
		process.env.CHIT_TEST_LAST_INPUT = promptFile;
		try {
			const adapter = new ClaudeCliAdapter({});
			const result = await adapter.call({
				participantId: "claude",
				agentId: "claude",
				stepId: "ask",
				input: "Role:\nYou are an advisor\n\nTask:\nhello world",
				cwd: TMPDIR,
			});
			expect(result.output).toBe("OK: claude received your prompt");
			const received = readFileSync(promptFile, "utf-8");
			expect(received).toBe("Role:\nYou are an advisor\n\nTask:\nhello world");
		} finally {
			delete process.env.CHIT_TEST_LAST_INPUT;
		}
	});

	test("throws when claude exits non-zero", async () => {
		process.env.CHIT_TEST_FAKE_EXIT = "5";
		try {
			const adapter = new ClaudeCliAdapter({});
			await expect(
				adapter.call({
					participantId: "claude",
					agentId: "claude",
					stepId: "ask",
					input: "x",
					cwd: TMPDIR,
				}),
			).rejects.toThrow(/claude --print exited 5/);
		} finally {
			delete process.env.CHIT_TEST_FAKE_EXIT;
		}
	});

	test("throws when stdout has no parseable result event (garbage lines)", async () => {
		process.env.CHIT_TEST_CLAUDE_BAD_JSON = "1";
		try {
			const adapter = new ClaudeCliAdapter({});
			await expect(
				adapter.call({
					participantId: "claude",
					agentId: "claude",
					stepId: "ask",
					input: "x",
					cwd: TMPDIR,
				}),
			).rejects.toThrow(/no result event/);
		} finally {
			delete process.env.CHIT_TEST_CLAUDE_BAD_JSON;
		}
	});

	test("throws when the stream has events but no result event", async () => {
		process.env.CHIT_TEST_CLAUDE_NO_RESULT = "1";
		try {
			const adapter = new ClaudeCliAdapter({});
			await expect(
				adapter.call({
					participantId: "claude",
					agentId: "claude",
					stepId: "ask",
					input: "x",
					cwd: TMPDIR,
				}),
			).rejects.toThrow(/claude stream produced no result event/);
		} finally {
			delete process.env.CHIT_TEST_CLAUDE_NO_RESULT;
		}
	});

	test("throws when claude reports is_error/non-success subtype", async () => {
		process.env.CHIT_TEST_CLAUDE_IS_ERROR = "1";
		try {
			const adapter = new ClaudeCliAdapter({});
			await expect(
				adapter.call({
					participantId: "claude",
					agentId: "claude",
					stepId: "ask",
					input: "x",
					cwd: TMPDIR,
				}),
			).rejects.toThrow(/claude blew up/);
		} finally {
			delete process.env.CHIT_TEST_CLAUDE_IS_ERROR;
		}
	});
});

describe("ClaudeCliAdapter: usage extraction", () => {
	async function run(): Promise<Awaited<ReturnType<ClaudeCliAdapter["call"]>>> {
		return new ClaudeCliAdapter({}).call({
			participantId: "claude",
			agentId: "claude",
			stepId: "ask",
			input: "x",
			cwd: TMPDIR,
		});
	}

	test("maps the top-level usage block and total_cost_usd onto AdapterUsage", async () => {
		process.env.CHIT_TEST_CLAUDE_USAGE = "1";
		try {
			const result = await run();
			// cachedInputTokens = cache_read_input_tokens; cache_creation is not a
			// token field (its cost is already in the authoritative total_cost_usd);
			// claude reports no total or reasoning token, so those stay absent.
			expect(result.usage).toEqual({
				inputTokens: 6590,
				outputTokens: 4,
				cachedInputTokens: 17308,
				estimatedCostUsd: 0.0657,
			});
		} finally {
			delete process.env.CHIT_TEST_CLAUDE_USAGE;
		}
	});

	test("usage is absent when claude reports no usage block", async () => {
		const result = await run();
		expect(result.usage).toBeUndefined();
	});

	test("drops invalid token/cost values (negative, fractional) to stay schema-valid", async () => {
		process.env.CHIT_TEST_CLAUDE_USAGE_BAD = "1";
		try {
			const result = await run();
			// input_tokens -1 and output_tokens 1.5 and total_cost_usd -0.5 are all
			// dropped; only cache_read_input_tokens 2 (a non-negative integer) survives.
			expect(result.usage).toEqual({ cachedInputTokens: 2 });
		} finally {
			delete process.env.CHIT_TEST_CLAUDE_USAGE_BAD;
		}
	});
});

describe("ClaudeCliAdapter: env and command construction", () => {
	test("spawned process sees CLAUDECODE=0", async () => {
		const envFile = join(TMPDIR, "claude-env.txt");
		process.env.CHIT_TEST_CLAUDE_ENV_FILE = envFile;
		const savedCC = process.env.CLAUDECODE;
		process.env.CLAUDECODE = "1"; // parent says 1; adapter must override to 0
		try {
			const adapter = new ClaudeCliAdapter({});
			await adapter.call({
				participantId: "claude",
				agentId: "claude",
				stepId: "ask",
				input: "x",
				cwd: TMPDIR,
			});
			const recorded = readFileSync(envFile, "utf-8");
			expect(recorded.trim()).toBe("CLAUDECODE=0");
		} finally {
			delete process.env.CHIT_TEST_CLAUDE_ENV_FILE;
			if (savedCC === undefined) delete process.env.CLAUDECODE;
			else process.env.CLAUDECODE = savedCC;
		}
	});

	test("config.env cannot disable the CLAUDECODE=0 guard", async () => {
		const envFile = join(TMPDIR, "claude-env-2.txt");
		process.env.CHIT_TEST_CLAUDE_ENV_FILE = envFile;
		try {
			const adapter = new ClaudeCliAdapter({ env: { CLAUDECODE: "1" } });
			await adapter.call({
				participantId: "claude",
				agentId: "claude",
				stepId: "ask",
				input: "x",
				cwd: TMPDIR,
			});
			const recorded = readFileSync(envFile, "utf-8");
			expect(recorded.trim()).toBe("CLAUDECODE=0");
		} finally {
			delete process.env.CHIT_TEST_CLAUDE_ENV_FILE;
		}
	});

	test("passes --print --verbose stream-json flags and --model when configured", async () => {
		writeFakeBin("claude", FAKE_CLAUDE_ARGS_RECORDER);
		const argsFile = join(TMPDIR, "argv.txt");
		process.env.CHIT_TEST_ARGS_FILE = argsFile;
		try {
			const adapter = new ClaudeCliAdapter({ model: "opus" });
			await adapter.call({
				participantId: "claude",
				agentId: "claude",
				stepId: "ask",
				input: "x",
				cwd: TMPDIR,
			});
			const argv = readFileSync(argsFile, "utf-8").trim().split("\n");
			expect(argv).toContain("--print");
			expect(argv).toContain("--verbose");
			expect(argv).toContain("--output-format");
			expect(argv).toContain("stream-json");
			expect(argv).toContain("--include-partial-messages");
			expect(argv).toContain("--model");
			expect(argv).toContain("opus");
		} finally {
			delete process.env.CHIT_TEST_ARGS_FILE;
			writeFakeBin("claude", FAKE_CLAUDE);
		}
	});

	test("by default passes --strict-mcp-config and an empty-servers --mcp-config", async () => {
		writeFakeBin("claude", FAKE_CLAUDE_ARGS_RECORDER);
		const argsFile = join(TMPDIR, "argv-strict-mcp-default.txt");
		process.env.CHIT_TEST_ARGS_FILE = argsFile;
		try {
			const adapter = new ClaudeCliAdapter({});
			await adapter.call({
				participantId: "claude",
				agentId: "claude",
				stepId: "ask",
				input: "x",
				cwd: TMPDIR,
			});
			const argv = readFileSync(argsFile, "utf-8").trim().split("\n");
			expect(argv).toContain("--strict-mcp-config");
			expect(argv).toContain("--mcp-config");
			// The config value sits immediately after --mcp-config and declares no servers.
			const mcpConfig = argv[argv.indexOf("--mcp-config") + 1];
			expect(JSON.parse(mcpConfig)).toEqual({ mcpServers: {} });
		} finally {
			delete process.env.CHIT_TEST_ARGS_FILE;
			writeFakeBin("claude", FAKE_CLAUDE);
		}
	});

	test("strictMcp:false omits the strict-MCP flags (opt-out)", async () => {
		writeFakeBin("claude", FAKE_CLAUDE_ARGS_RECORDER);
		const argsFile = join(TMPDIR, "argv-strict-mcp-off.txt");
		process.env.CHIT_TEST_ARGS_FILE = argsFile;
		try {
			const adapter = new ClaudeCliAdapter({ strictMcp: false });
			await adapter.call({
				participantId: "claude",
				agentId: "claude",
				stepId: "ask",
				input: "x",
				cwd: TMPDIR,
			});
			const argv = readFileSync(argsFile, "utf-8").trim().split("\n");
			expect(argv).not.toContain("--strict-mcp-config");
			expect(argv).not.toContain("--mcp-config");
		} finally {
			delete process.env.CHIT_TEST_ARGS_FILE;
			writeFakeBin("claude", FAKE_CLAUDE);
		}
	});

	test("strict-MCP flags coexist with --resume and --model", async () => {
		writeFakeBin("claude", FAKE_CLAUDE_ARGS_RECORDER);
		const argsFile = join(TMPDIR, "argv-strict-mcp-resume.txt");
		process.env.CHIT_TEST_ARGS_FILE = argsFile;
		try {
			const adapter = new ClaudeCliAdapter({ model: "opus", passModelOnResume: true });
			await adapter.call({
				participantId: "claude",
				agentId: "claude",
				stepId: "ask",
				input: "x",
				cwd: TMPDIR,
				session: { sessionId: "prior" },
			});
			const argv = readFileSync(argsFile, "utf-8").trim().split("\n");
			expect(argv).toContain("--strict-mcp-config");
			expect(argv).toContain("--mcp-config");
			expect(argv).toContain("--resume");
			expect(argv).toContain("prior");
			expect(argv).toContain("--model");
			expect(argv).toContain("opus");
		} finally {
			delete process.env.CHIT_TEST_ARGS_FILE;
			writeFakeBin("claude", FAKE_CLAUDE);
		}
	});

	test("passes --effort <level> when reasoningEffort is configured", async () => {
		writeFakeBin("claude", FAKE_CLAUDE_ARGS_RECORDER);
		const argsFile = join(TMPDIR, "argv-effort.txt");
		process.env.CHIT_TEST_ARGS_FILE = argsFile;
		try {
			const adapter = new ClaudeCliAdapter({ reasoningEffort: "high" });
			await adapter.call({
				participantId: "claude",
				agentId: "claude",
				stepId: "ask",
				input: "x",
				cwd: TMPDIR,
			});
			const argv = readFileSync(argsFile, "utf-8").trim().split("\n");
			// The level sits immediately after --effort, passed through verbatim.
			expect(argv).toContain("--effort");
			expect(argv[argv.indexOf("--effort") + 1]).toBe("high");
		} finally {
			delete process.env.CHIT_TEST_ARGS_FILE;
			writeFakeBin("claude", FAKE_CLAUDE);
		}
	});

	test("passes --effort on resume too (effort is per-invocation, re-asserted)", async () => {
		writeFakeBin("claude", FAKE_CLAUDE_ARGS_RECORDER);
		const argsFile = join(TMPDIR, "argv-effort-resume.txt");
		process.env.CHIT_TEST_ARGS_FILE = argsFile;
		try {
			const adapter = new ClaudeCliAdapter({ reasoningEffort: "max" });
			await adapter.call({
				participantId: "claude",
				agentId: "claude",
				stepId: "ask",
				input: "x",
				cwd: TMPDIR,
				session: { sessionId: "prior" },
			});
			const argv = readFileSync(argsFile, "utf-8").trim().split("\n");
			expect(argv).toContain("--resume");
			expect(argv).toContain("--effort");
			expect(argv[argv.indexOf("--effort") + 1]).toBe("max");
		} finally {
			delete process.env.CHIT_TEST_ARGS_FILE;
			writeFakeBin("claude", FAKE_CLAUDE);
		}
	});

	test("omits --effort when reasoningEffort is unset", async () => {
		writeFakeBin("claude", FAKE_CLAUDE_ARGS_RECORDER);
		const argsFile = join(TMPDIR, "argv-no-effort.txt");
		process.env.CHIT_TEST_ARGS_FILE = argsFile;
		try {
			const adapter = new ClaudeCliAdapter({});
			await adapter.call({
				participantId: "claude",
				agentId: "claude",
				stepId: "ask",
				input: "x",
				cwd: TMPDIR,
			});
			const argv = readFileSync(argsFile, "utf-8").trim().split("\n");
			expect(argv).not.toContain("--effort");
		} finally {
			delete process.env.CHIT_TEST_ARGS_FILE;
			writeFakeBin("claude", FAKE_CLAUDE);
		}
	});

	test("adds --permission-mode plan when the participant is read_only", async () => {
		// Read-only enforcement: plan mode blocks writes inside claude. This is the
		// only place the flag is added; it pairs with the registry descriptor
		// flipping enforces_filesystem_read_only to true for claude-cli.
		writeFakeBin("claude", FAKE_CLAUDE_ARGS_RECORDER);
		const argsFile = join(TMPDIR, "argv-plan-readonly.txt");
		process.env.CHIT_TEST_ARGS_FILE = argsFile;
		try {
			const adapter = new ClaudeCliAdapter({});
			await adapter.call({
				participantId: "claude",
				agentId: "claude",
				stepId: "ask",
				input: "x",
				cwd: TMPDIR,
				filesystem: "read_only",
			});
			const argv = readFileSync(argsFile, "utf-8").trim().split("\n");
			expect(argv).toContain("--permission-mode");
			// The mode sits immediately after the flag.
			expect(argv[argv.indexOf("--permission-mode") + 1]).toBe("plan");
		} finally {
			delete process.env.CHIT_TEST_ARGS_FILE;
			writeFakeBin("claude", FAKE_CLAUDE);
		}
	});

	test("omits --permission-mode plan when the participant is write", async () => {
		// write is the permissive option: today's behavior, claude can write, so no
		// plan-mode flag is added.
		writeFakeBin("claude", FAKE_CLAUDE_ARGS_RECORDER);
		const argsFile = join(TMPDIR, "argv-plan-write.txt");
		process.env.CHIT_TEST_ARGS_FILE = argsFile;
		try {
			const adapter = new ClaudeCliAdapter({});
			await adapter.call({
				participantId: "claude",
				agentId: "claude",
				stepId: "ask",
				input: "x",
				cwd: TMPDIR,
				filesystem: "write",
			});
			const argv = readFileSync(argsFile, "utf-8").trim().split("\n");
			expect(argv).not.toContain("--permission-mode");
		} finally {
			delete process.env.CHIT_TEST_ARGS_FILE;
			writeFakeBin("claude", FAKE_CLAUDE);
		}
	});

	test("omits --permission-mode plan when no filesystem permission is passed", async () => {
		// An omitted permission keeps the permissive default (claude can write), so
		// callers/tests that don't thread it through are unaffected.
		writeFakeBin("claude", FAKE_CLAUDE_ARGS_RECORDER);
		const argsFile = join(TMPDIR, "argv-plan-unset.txt");
		process.env.CHIT_TEST_ARGS_FILE = argsFile;
		try {
			const adapter = new ClaudeCliAdapter({});
			await adapter.call({
				participantId: "claude",
				agentId: "claude",
				stepId: "ask",
				input: "x",
				cwd: TMPDIR,
			});
			const argv = readFileSync(argsFile, "utf-8").trim().split("\n");
			expect(argv).not.toContain("--permission-mode");
		} finally {
			delete process.env.CHIT_TEST_ARGS_FILE;
			writeFakeBin("claude", FAKE_CLAUDE);
		}
	});

	test("plan mode coexists with --resume on a read_only resume call", async () => {
		// Read-only enforcement is per-invocation like --effort, so it must also be
		// present on resume calls, not just the fresh call.
		writeFakeBin("claude", FAKE_CLAUDE_ARGS_RECORDER);
		const argsFile = join(TMPDIR, "argv-plan-resume.txt");
		process.env.CHIT_TEST_ARGS_FILE = argsFile;
		try {
			const adapter = new ClaudeCliAdapter({});
			await adapter.call({
				participantId: "claude",
				agentId: "claude",
				stepId: "ask",
				input: "x",
				cwd: TMPDIR,
				session: { sessionId: "prior" },
				filesystem: "read_only",
			});
			const argv = readFileSync(argsFile, "utf-8").trim().split("\n");
			expect(argv).toContain("--resume");
			expect(argv).toContain("--permission-mode");
			expect(argv[argv.indexOf("--permission-mode") + 1]).toBe("plan");
		} finally {
			delete process.env.CHIT_TEST_ARGS_FILE;
			writeFakeBin("claude", FAKE_CLAUDE);
		}
	});
});

describe("ClaudeCliAdapter: session resume", () => {
	test("fresh call returns session with sessionId from session_id", async () => {
		const adapter = new ClaudeCliAdapter({});
		const result = await adapter.call({
			participantId: "claude",
			agentId: "claude",
			stepId: "ask",
			input: "x",
			cwd: TMPDIR,
		});
		expect(result.session).toEqual({ sessionId: "fake-claude-session" });
	});

	test("resume call uses --resume <sessionId> syntax", async () => {
		writeFakeBin("claude", FAKE_CLAUDE_ARGS_RECORDER);
		const argsFile = join(TMPDIR, "argv-claude-resume.txt");
		process.env.CHIT_TEST_ARGS_FILE = argsFile;
		try {
			const adapter = new ClaudeCliAdapter({});
			await adapter.call({
				participantId: "claude",
				agentId: "claude",
				stepId: "ask",
				input: "x",
				cwd: TMPDIR,
				session: { sessionId: "prior-session-id" },
			});
			const argv = readFileSync(argsFile, "utf-8").trim().split("\n");
			expect(argv).toContain("--resume");
			expect(argv).toContain("prior-session-id");
		} finally {
			delete process.env.CHIT_TEST_ARGS_FILE;
			writeFakeBin("claude", FAKE_CLAUDE);
		}
	});

	test("resume call produces RESUMED output and the new sessionId", async () => {
		const adapter = new ClaudeCliAdapter({});
		const result = await adapter.call({
			participantId: "claude",
			agentId: "claude",
			stepId: "ask",
			input: "x",
			cwd: TMPDIR,
			session: { sessionId: "anything" },
		});
		expect(result.output).toBe("RESUMED: claude received your prompt");
		expect(result.session).toEqual({ sessionId: "resumed-session" });
	});

	test("passModelOnResume=true adds --model on resume", async () => {
		writeFakeBin("claude", FAKE_CLAUDE_ARGS_RECORDER);
		const argsFile = join(TMPDIR, "argv-claude-resume-with-model.txt");
		process.env.CHIT_TEST_ARGS_FILE = argsFile;
		try {
			const adapter = new ClaudeCliAdapter({ model: "opus", passModelOnResume: true });
			await adapter.call({
				participantId: "claude",
				agentId: "claude",
				stepId: "ask",
				input: "x",
				cwd: TMPDIR,
				session: { sessionId: "prior" },
			});
			const argv = readFileSync(argsFile, "utf-8").trim().split("\n");
			expect(argv).toContain("--resume");
			expect(argv).toContain("--model");
			expect(argv).toContain("opus");
		} finally {
			delete process.env.CHIT_TEST_ARGS_FILE;
			writeFakeBin("claude", FAKE_CLAUDE);
		}
	});

	test("passModelOnResume=false (default) omits --model on resume", async () => {
		writeFakeBin("claude", FAKE_CLAUDE_ARGS_RECORDER);
		const argsFile = join(TMPDIR, "argv-claude-resume-no-model.txt");
		process.env.CHIT_TEST_ARGS_FILE = argsFile;
		try {
			const adapter = new ClaudeCliAdapter({ model: "opus" });
			await adapter.call({
				participantId: "claude",
				agentId: "claude",
				stepId: "ask",
				input: "x",
				cwd: TMPDIR,
				session: { sessionId: "prior" },
			});
			const argv = readFileSync(argsFile, "utf-8").trim().split("\n");
			expect(argv).toContain("--resume");
			expect(argv).not.toContain("--model");
		} finally {
			delete process.env.CHIT_TEST_ARGS_FILE;
			writeFakeBin("claude", FAKE_CLAUDE);
		}
	});

	test("corrupt session payload is treated as fresh start", async () => {
		const adapter = new ClaudeCliAdapter({});
		const result = await adapter.call({
			participantId: "claude",
			agentId: "claude",
			stepId: "ask",
			input: "x",
			cwd: TMPDIR,
			session: 12345,
		});
		expect(result.output).toBe("OK: claude received your prompt");
		expect(result.session).toEqual({ sessionId: "fake-claude-session" });
	});
});

describe("ClaudeCliAdapter: raw event stream (onEvent)", () => {
	test("forwards every parseable stream-json line as {type, raw}", async () => {
		const events: { type: string; raw: string }[] = [];
		const adapter = new ClaudeCliAdapter({});
		const result = await adapter.call({
			participantId: "claude",
			agentId: "claude",
			stepId: "ask",
			input: "x",
			cwd: TMPDIR,
			onEvent: (e) => events.push(e),
		});
		// Every observable event in order, ending in the result event.
		expect(events.map((e) => e.type)).toEqual(["system", "stream_event", "assistant", "result"]);
		// raw is the verbatim JSONL line; its parsed type matches the event type.
		for (const e of events) {
			expect((JSON.parse(e.raw) as { type: string }).type).toBe(e.type);
		}
		// Surfacing events does not change the returned output/session.
		expect(result.output).toBe("OK: claude received your prompt");
		expect(result.session).toEqual({ sessionId: "fake-claude-session" });
	});

	test("output/session/usage are unchanged whether or not onEvent is supplied", async () => {
		process.env.CHIT_TEST_CLAUDE_USAGE = "1";
		try {
			const base = {
				participantId: "claude",
				agentId: "claude",
				stepId: "ask",
				input: "x",
				cwd: TMPDIR,
			} as const;
			const unaudited = await new ClaudeCliAdapter({}).call(base);
			const audited = await new ClaudeCliAdapter({}).call({ ...base, onEvent: () => {} });
			expect(audited.output).toBe(unaudited.output);
			expect(audited.session).toEqual(unaudited.session);
			expect(audited.usage).toEqual(unaudited.usage);
			expect(audited.usage).toEqual({
				inputTokens: 6590,
				outputTokens: 4,
				cachedInputTokens: 17308,
				estimatedCostUsd: 0.0657,
			});
		} finally {
			delete process.env.CHIT_TEST_CLAUDE_USAGE;
		}
	});

	test("emits the events that streamed before a failing result event", async () => {
		process.env.CHIT_TEST_CLAUDE_IS_ERROR = "1";
		const events: { type: string; raw: string }[] = [];
		try {
			const adapter = new ClaudeCliAdapter({});
			await expect(
				adapter.call({
					participantId: "claude",
					agentId: "claude",
					stepId: "ask",
					input: "x",
					cwd: TMPDIR,
					onEvent: (e) => events.push(e),
				}),
			).rejects.toThrow(/claude blew up/);
			// Events are surfaced BEFORE the failure check, so the stream that led up
			// to the error is preserved (including the failing result event itself).
			expect(events.map((e) => e.type)).toEqual(["system", "stream_event", "assistant", "result"]);
		} finally {
			delete process.env.CHIT_TEST_CLAUDE_IS_ERROR;
		}
	});

	test("emits the events that streamed before a non-zero process exit", async () => {
		// Distinct from the is_error case above: here claude streams events and the
		// PROCESS exits non-zero (no result event at all). The exit-code check is the
		// first failure branch, so this pins that events are surfaced even before it.
		process.env.CHIT_TEST_CLAUDE_EMIT_THEN_FAIL = "1";
		const events: { type: string; raw: string }[] = [];
		try {
			const adapter = new ClaudeCliAdapter({});
			await expect(
				adapter.call({
					participantId: "claude",
					agentId: "claude",
					stepId: "ask",
					input: "x",
					cwd: TMPDIR,
					onEvent: (e) => events.push(e),
				}),
			).rejects.toThrow(/claude --print exited 7/);
			expect(events.map((e) => e.type)).toEqual(["system", "stream_event", "assistant"]);
		} finally {
			delete process.env.CHIT_TEST_CLAUDE_EMIT_THEN_FAIL;
		}
	});

	test("the unaudited path (no onEvent) still returns a result", async () => {
		const adapter = new ClaudeCliAdapter({});
		const result = await adapter.call({
			participantId: "claude",
			agentId: "claude",
			stepId: "ask",
			input: "x",
			cwd: TMPDIR,
		});
		expect(result.output).toBe("OK: claude received your prompt");
	});

	test("surfaces an event to onEvent BEFORE the process completes (live, not post-exit)", async () => {
		// The fake emits the system line, then blocks until a wait file exists. We
		// create that file only from inside onEvent, so the call can complete only if
		// the system event reached onEvent while the child was still running. A
		// buffered (read-all-then-emit) implementation would deadlock and time out.
		const waitFile = join(TMPDIR, "claude-live-go.txt");
		rmSync(waitFile, { force: true });
		process.env.CHIT_TEST_CLAUDE_WAIT_FILE = waitFile;
		const events: { type: string; raw: string }[] = [];
		try {
			const result = await new ClaudeCliAdapter({}).call({
				participantId: "claude",
				agentId: "claude",
				stepId: "ask",
				input: "x",
				cwd: TMPDIR,
				onEvent: (e) => {
					events.push(e);
					if (e.type === "system") writeFileSync(waitFile, "go");
				},
			});
			expect(result.output).toBe("LIVE: claude done");
			expect(events.map((e) => e.type)).toEqual(["system", "result"]);
		} finally {
			delete process.env.CHIT_TEST_CLAUDE_WAIT_FILE;
			rmSync(waitFile, { force: true });
		}
	}, 15000);

	test("a throwing onEvent does not abort the drain or fail the call", async () => {
		// onEvent is observational: a handler that throws must not break the stdout
		// drain, the parse, or the run.
		const result = await new ClaudeCliAdapter({}).call({
			participantId: "claude",
			agentId: "claude",
			stepId: "ask",
			input: "x",
			cwd: TMPDIR,
			onEvent: () => {
				throw new Error("handler boom");
			},
		});
		expect(result.output).toBe("OK: claude received your prompt");
	});
});

describe("ClaudeCliAdapter: call timeout watchdog", () => {
	test("kills the child and rejects with a timeout error when callTimeoutMs elapses", async () => {
		// Fake claude sleeps 10s but the watchdog fires at 200ms. The reject can
		// only arrive quickly if the child was killed and the awaits unblocked.
		// The long-runner is `exec sleep` (the direct child), so proc.kill()
		// reaches it. NOTE: proc.kill() terminates only the DIRECT child, not a
		// deeper descendant tree - the same limitation the cancel path has.
		process.env.CHIT_TEST_SLEEP = "10";
		try {
			const adapter = new ClaudeCliAdapter({ callTimeoutMs: 200 });
			const started = Date.now();
			await expect(
				adapter.call({
					participantId: "claude",
					agentId: "claude",
					stepId: "ask",
					input: "hi",
					cwd: TMPDIR,
				}),
			).rejects.toThrow(/claude --print timed out after 200ms/);
			expect(Date.now() - started).toBeLessThan(4000);
		} finally {
			delete process.env.CHIT_TEST_SLEEP;
		}
	});
});

describe("ClaudeCliAdapter: no-progress watchdog", () => {
	test("kills the child and fails with a no-progress error when stdout stays silent", async () => {
		// The fake emits nothing and sleeps 10s; the no-progress watchdog fires at
		// 200ms. A fast reject proves the no-progress kill, distinct from the 15min
		// hard timeout. Off by default, so only this opted-in agent is affected.
		process.env.CHIT_TEST_SLEEP = "10";
		try {
			const started = Date.now();
			await expect(
				new ClaudeCliAdapter({ noProgressTimeoutMs: 200 }).call({
					participantId: "claude",
					agentId: "claude",
					stepId: "ask",
					input: "hi",
					cwd: TMPDIR,
				}),
			).rejects.toThrow(/made no progress for 200ms/);
			expect(Date.now() - started).toBeLessThan(4000);
		} finally {
			delete process.env.CHIT_TEST_SLEEP;
		}
	});

	test("does not fire while output keeps arriving (timer resets per chunk)", async () => {
		// The fake drips a stream_event every ~120ms for ~600ms total, longer than
		// the 400ms timeout. It can only complete if each chunk resets the watchdog;
		// without the per-chunk reset it would be killed mid-drip.
		process.env.CHIT_TEST_CLAUDE_DRIP = "1";
		try {
			const result = await new ClaudeCliAdapter({ noProgressTimeoutMs: 400 }).call({
				participantId: "claude",
				agentId: "claude",
				stepId: "ask",
				input: "hi",
				cwd: TMPDIR,
			});
			expect(result.output).toBe("DRIP: claude done");
		} finally {
			delete process.env.CHIT_TEST_CLAUDE_DRIP;
		}
	}, 15000);
});
