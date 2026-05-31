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

if [ -n "$HANDOFF_TEST_SLEEP" ]; then
  cat > /dev/null
  # exec so the long-runner IS the spawned process (as the real claude binary
  # is), not an orphanable child: proc.kill() then terminates it and closes its
  # pipes. proc.kill() reaches only this direct child, not a descendant tree.
  exec sleep "$HANDOFF_TEST_SLEEP"
fi

if [ -n "$HANDOFF_TEST_FAKE_EXIT" ] && [ "$HANDOFF_TEST_FAKE_EXIT" != "0" ]; then
  cat > /dev/null
  echo "boom: claude error" >&2
  exit "$HANDOFF_TEST_FAKE_EXIT"
fi
if [ -n "$HANDOFF_TEST_CLAUDE_ENV_FILE" ]; then
  printf 'CLAUDECODE=%s\\n' "$CLAUDECODE" > "$HANDOFF_TEST_CLAUDE_ENV_FILE"
fi
if [ -n "$HANDOFF_TEST_LAST_INPUT" ]; then
  cat > "$HANDOFF_TEST_LAST_INPUT"
else
  cat > /dev/null
fi
if [ -n "$HANDOFF_TEST_CLAUDE_BAD_JSON" ]; then
  echo "not json at all"
  exit 0
fi
if [ -n "$HANDOFF_TEST_CLAUDE_NO_RESULT" ]; then
  emit_stream "fake-claude-session"
  exit 0
fi
if [ -n "$HANDOFF_TEST_CLAUDE_IS_ERROR" ]; then
  emit_stream "fake-claude-session"
  echo '{"type":"result","is_error":true,"result":"claude blew up","subtype":"error_during_execution"}'
  exit 0
fi
if [ -n "$HANDOFF_TEST_CLAUDE_USAGE" ]; then
  emit_stream "fake-claude-session"
  echo '{"type":"result","session_id":"fake-claude-session","result":"OK","subtype":"success","is_error":false,"usage":{"input_tokens":6590,"output_tokens":4,"cache_read_input_tokens":17308,"cache_creation_input_tokens":3851},"total_cost_usd":0.0657}'
  exit 0
fi
if [ -n "$HANDOFF_TEST_CLAUDE_USAGE_BAD" ]; then
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
if [ -n "$HANDOFF_TEST_ARGS_FILE" ]; then
  for arg in "$@"; do
    printf '%s\\n' "$arg" >> "$HANDOFF_TEST_ARGS_FILE"
  done
fi
cat > /dev/null
echo '{"type":"result","session_id":"fake","result":"OK","subtype":"success","is_error":false}'
`;

let TMPDIR: string;
let FAKE_BIN_DIR: string;
let savedPath: string | undefined;

beforeAll(() => {
	TMPDIR = mkdtempSync(join(tmpdir(), "handoff-claude-"));
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
		process.env.HANDOFF_TEST_LAST_INPUT = promptFile;
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
			delete process.env.HANDOFF_TEST_LAST_INPUT;
		}
	});

	test("throws when claude exits non-zero", async () => {
		process.env.HANDOFF_TEST_FAKE_EXIT = "5";
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
			delete process.env.HANDOFF_TEST_FAKE_EXIT;
		}
	});

	test("throws when stdout has no parseable result event (garbage lines)", async () => {
		process.env.HANDOFF_TEST_CLAUDE_BAD_JSON = "1";
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
			delete process.env.HANDOFF_TEST_CLAUDE_BAD_JSON;
		}
	});

	test("throws when the stream has events but no result event", async () => {
		process.env.HANDOFF_TEST_CLAUDE_NO_RESULT = "1";
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
			delete process.env.HANDOFF_TEST_CLAUDE_NO_RESULT;
		}
	});

	test("throws when claude reports is_error/non-success subtype", async () => {
		process.env.HANDOFF_TEST_CLAUDE_IS_ERROR = "1";
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
			delete process.env.HANDOFF_TEST_CLAUDE_IS_ERROR;
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
		process.env.HANDOFF_TEST_CLAUDE_USAGE = "1";
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
			delete process.env.HANDOFF_TEST_CLAUDE_USAGE;
		}
	});

	test("usage is absent when claude reports no usage block", async () => {
		const result = await run();
		expect(result.usage).toBeUndefined();
	});

	test("drops invalid token/cost values (negative, fractional) to stay schema-valid", async () => {
		process.env.HANDOFF_TEST_CLAUDE_USAGE_BAD = "1";
		try {
			const result = await run();
			// input_tokens -1 and output_tokens 1.5 and total_cost_usd -0.5 are all
			// dropped; only cache_read_input_tokens 2 (a non-negative integer) survives.
			expect(result.usage).toEqual({ cachedInputTokens: 2 });
		} finally {
			delete process.env.HANDOFF_TEST_CLAUDE_USAGE_BAD;
		}
	});
});

describe("ClaudeCliAdapter: env and command construction", () => {
	test("spawned process sees CLAUDECODE=0", async () => {
		const envFile = join(TMPDIR, "claude-env.txt");
		process.env.HANDOFF_TEST_CLAUDE_ENV_FILE = envFile;
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
			delete process.env.HANDOFF_TEST_CLAUDE_ENV_FILE;
			if (savedCC === undefined) delete process.env.CLAUDECODE;
			else process.env.CLAUDECODE = savedCC;
		}
	});

	test("config.env cannot disable the CLAUDECODE=0 guard", async () => {
		const envFile = join(TMPDIR, "claude-env-2.txt");
		process.env.HANDOFF_TEST_CLAUDE_ENV_FILE = envFile;
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
			delete process.env.HANDOFF_TEST_CLAUDE_ENV_FILE;
		}
	});

	test("passes --print --verbose stream-json flags and --model when configured", async () => {
		writeFakeBin("claude", FAKE_CLAUDE_ARGS_RECORDER);
		const argsFile = join(TMPDIR, "argv.txt");
		process.env.HANDOFF_TEST_ARGS_FILE = argsFile;
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
			delete process.env.HANDOFF_TEST_ARGS_FILE;
			writeFakeBin("claude", FAKE_CLAUDE);
		}
	});

	test("by default passes --strict-mcp-config and an empty-servers --mcp-config", async () => {
		writeFakeBin("claude", FAKE_CLAUDE_ARGS_RECORDER);
		const argsFile = join(TMPDIR, "argv-strict-mcp-default.txt");
		process.env.HANDOFF_TEST_ARGS_FILE = argsFile;
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
			delete process.env.HANDOFF_TEST_ARGS_FILE;
			writeFakeBin("claude", FAKE_CLAUDE);
		}
	});

	test("strictMcp:false omits the strict-MCP flags (opt-out)", async () => {
		writeFakeBin("claude", FAKE_CLAUDE_ARGS_RECORDER);
		const argsFile = join(TMPDIR, "argv-strict-mcp-off.txt");
		process.env.HANDOFF_TEST_ARGS_FILE = argsFile;
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
			delete process.env.HANDOFF_TEST_ARGS_FILE;
			writeFakeBin("claude", FAKE_CLAUDE);
		}
	});

	test("strict-MCP flags coexist with --resume and --model", async () => {
		writeFakeBin("claude", FAKE_CLAUDE_ARGS_RECORDER);
		const argsFile = join(TMPDIR, "argv-strict-mcp-resume.txt");
		process.env.HANDOFF_TEST_ARGS_FILE = argsFile;
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
			delete process.env.HANDOFF_TEST_ARGS_FILE;
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
		process.env.HANDOFF_TEST_ARGS_FILE = argsFile;
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
			delete process.env.HANDOFF_TEST_ARGS_FILE;
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
		process.env.HANDOFF_TEST_ARGS_FILE = argsFile;
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
			delete process.env.HANDOFF_TEST_ARGS_FILE;
			writeFakeBin("claude", FAKE_CLAUDE);
		}
	});

	test("passModelOnResume=false (default) omits --model on resume", async () => {
		writeFakeBin("claude", FAKE_CLAUDE_ARGS_RECORDER);
		const argsFile = join(TMPDIR, "argv-claude-resume-no-model.txt");
		process.env.HANDOFF_TEST_ARGS_FILE = argsFile;
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
			delete process.env.HANDOFF_TEST_ARGS_FILE;
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
		process.env.HANDOFF_TEST_CLAUDE_USAGE = "1";
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
			delete process.env.HANDOFF_TEST_CLAUDE_USAGE;
		}
	});

	test("emits the events that streamed before a failing result event", async () => {
		process.env.HANDOFF_TEST_CLAUDE_IS_ERROR = "1";
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
			delete process.env.HANDOFF_TEST_CLAUDE_IS_ERROR;
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
});

describe("ClaudeCliAdapter: call timeout watchdog", () => {
	test("kills the child and rejects with a timeout error when callTimeoutMs elapses", async () => {
		// Fake claude sleeps 10s but the watchdog fires at 200ms. The reject can
		// only arrive quickly if the child was killed and the awaits unblocked.
		// The long-runner is `exec sleep` (the direct child), so proc.kill()
		// reaches it. NOTE: proc.kill() terminates only the DIRECT child, not a
		// deeper descendant tree - the same limitation the cancel path has.
		process.env.HANDOFF_TEST_SLEEP = "10";
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
			delete process.env.HANDOFF_TEST_SLEEP;
		}
	});
});
