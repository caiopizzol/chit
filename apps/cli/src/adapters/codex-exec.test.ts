import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdapterEvent } from "../runtime/types.ts";
import { CodexExecAdapter } from "./codex-exec.ts";

// Fake codex shell script. Behavior gates via env vars:
//   HANDOFF_TEST_FAKE_EXIT       - exit with this code, write "boom" to stderr
//   HANDOFF_TEST_LAST_INPUT      - capture stdin to this path
//   HANDOFF_TEST_NO_AGENT_MSG    - emit thread.started but no agent_message
//   HANDOFF_TEST_RESUME_NO_THREAD_STARTED - on resume, omit thread.started
// Resume mode is detected by the presence of "resume" in argv.
const FAKE_CODEX = `#!/bin/sh
IS_RESUME=0
for arg in "$@"; do
  if [ "$arg" = "resume" ]; then IS_RESUME=1; fi
done

if [ -n "$HANDOFF_TEST_SLEEP" ]; then
  cat > /dev/null
  # exec so the long-runner IS the spawned process (as the real codex binary is),
  # not an orphanable child: proc.kill() then terminates it and closes its pipes.
  exec sleep "$HANDOFF_TEST_SLEEP"
fi

if [ -n "$HANDOFF_TEST_FAKE_EXIT" ] && [ "$HANDOFF_TEST_FAKE_EXIT" != "0" ]; then
  cat > /dev/null
  echo "boom: codex error" >&2
  exit "$HANDOFF_TEST_FAKE_EXIT"
fi
if [ -n "$HANDOFF_TEST_EMIT_THEN_FAIL" ]; then
  cat > /dev/null
  echo '{"type":"thread.started","thread_id":"fail-1"}'
  echo "boom: codex error" >&2
  exit 3
fi
# Liveness gate: emit thread.started, then BLOCK until the test creates the wait
# file. The test only creates it from inside onEvent, so the process can finish
# only if thread.started was surfaced to onEvent WHILE this process was still
# running. A buffered (post-exit) reader would deadlock here.
if [ -n "$HANDOFF_TEST_WAIT_FILE" ]; then
  cat > /dev/null
  echo '{"type":"thread.started","thread_id":"live-1"}'
  while [ ! -f "$HANDOFF_TEST_WAIT_FILE" ]; do sleep 0.02; done
  echo '{"type":"item.completed","item":{"type":"agent_message","text":"LIVE: done"}}'
  echo '{"type":"turn.completed"}'
  exit 0
fi
if [ -n "$HANDOFF_TEST_LAST_INPUT" ]; then
  cat > "$HANDOFF_TEST_LAST_INPUT"
else
  cat > /dev/null
fi
if [ -n "$HANDOFF_TEST_NO_AGENT_MSG" ]; then
  echo '{"type":"thread.started","thread_id":"fake-1"}'
  exit 0
fi

if [ "$IS_RESUME" = "1" ]; then
  if [ -z "$HANDOFF_TEST_RESUME_NO_THREAD_STARTED" ]; then
    echo '{"type":"thread.started","thread_id":"fake-1"}'
  fi
  echo '{"type":"item.completed","item":{"type":"agent_message","text":"RESUMED: prompt received"}}'
else
  echo '{"type":"thread.started","thread_id":"fake-1"}'
  echo '{"type":"item.completed","item":{"type":"agent_message","text":"OK: prompt received"}}'
fi
if [ -n "$HANDOFF_TEST_EMIT_USAGE" ]; then
  echo '{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":40,"output_tokens":20,"reasoning_output_tokens":5}}'
fi
if [ -n "$HANDOFF_TEST_EMIT_USAGE_2" ]; then
  echo '{"type":"turn.completed","usage":{"input_tokens":7,"output_tokens":3}}'
fi
if [ -n "$HANDOFF_TEST_EMIT_USAGE_BAD" ]; then
  echo '{"type":"turn.completed","usage":{"input_tokens":-1,"cached_input_tokens":1.5,"output_tokens":2,"reasoning_output_tokens":3}}'
fi
`;

// Fake codex variant that records its argv to $HANDOFF_TEST_ARGS_FILE for
// asserting flag construction. Same JSONL output as above.
const FAKE_CODEX_ARGS_RECORDER = `#!/bin/sh
if [ -n "$HANDOFF_TEST_ARGS_FILE" ]; then
  for arg in "$@"; do
    printf '%s\\n' "$arg" >> "$HANDOFF_TEST_ARGS_FILE"
  done
fi
cat > /dev/null
echo '{"type":"thread.started","thread_id":"fake-1"}'
echo '{"type":"item.completed","item":{"type":"agent_message","text":"OK"}}'
`;

let TMPDIR: string;
let FAKE_BIN_DIR: string;
let savedPath: string | undefined;

beforeAll(() => {
	TMPDIR = mkdtempSync(join(tmpdir(), "handoff-codex-"));
	FAKE_BIN_DIR = join(TMPDIR, "bin");
	mkdirSyncSafe(FAKE_BIN_DIR);
	writeFakeBin("codex", FAKE_CODEX);
	savedPath = process.env.PATH;
	process.env.PATH = `${FAKE_BIN_DIR}:${savedPath}`;
});

afterAll(() => {
	if (savedPath !== undefined) process.env.PATH = savedPath;
	rmSync(TMPDIR, { recursive: true, force: true });
});

function mkdirSyncSafe(p: string): void {
	try {
		require("node:fs").mkdirSync(p, { recursive: true });
	} catch {
		// ignore
	}
}

function writeFakeBin(name: string, body: string): void {
	const path = join(FAKE_BIN_DIR, name);
	writeFileSync(path, body);
	chmodSync(path, 0o755);
}

describe("CodexExecAdapter: stdin and parsing", () => {
	test("sends adapter input to codex stdin and returns agent_message text", async () => {
		const promptFile = join(TMPDIR, "last-input-1.txt");
		process.env.HANDOFF_TEST_LAST_INPUT = promptFile;
		try {
			const adapter = new CodexExecAdapter({});
			const result = await adapter.call({
				participantId: "codex",
				agentId: "codex",
				stepId: "ask",
				input: "Role:\nyou are an advisor\n\nTask:\nhello world",
				cwd: TMPDIR,
			});
			expect(result.output).toBe("OK: prompt received");
			const received = readFileSync(promptFile, "utf-8");
			expect(received).toBe("Role:\nyou are an advisor\n\nTask:\nhello world");
		} finally {
			delete process.env.HANDOFF_TEST_LAST_INPUT;
		}
	});

	test("throws when codex exits non-zero, with stderr tail in message", async () => {
		process.env.HANDOFF_TEST_FAKE_EXIT = "3";
		try {
			const adapter = new CodexExecAdapter({});
			await expect(
				adapter.call({
					participantId: "codex",
					agentId: "codex",
					stepId: "ask",
					input: "x",
					cwd: TMPDIR,
				}),
			).rejects.toThrow(/codex exec exited 3/);
		} finally {
			delete process.env.HANDOFF_TEST_FAKE_EXIT;
		}
	});

	test("throws when codex emits no agent_message", async () => {
		process.env.HANDOFF_TEST_NO_AGENT_MSG = "1";
		try {
			const adapter = new CodexExecAdapter({});
			await expect(
				adapter.call({
					participantId: "codex",
					agentId: "codex",
					stepId: "ask",
					input: "x",
					cwd: TMPDIR,
				}),
			).rejects.toThrow(/no agent_message/);
		} finally {
			delete process.env.HANDOFF_TEST_NO_AGENT_MSG;
		}
	});
});

describe("CodexExecAdapter: onEvent (raw JSONL preservation)", () => {
	test("surfaces each parseable JSONL line to onEvent, output unchanged", async () => {
		const events: AdapterEvent[] = [];
		const result = await new CodexExecAdapter({}).call({
			participantId: "codex",
			agentId: "codex",
			stepId: "ask",
			input: "x",
			cwd: TMPDIR,
			onEvent: (e) => events.push(e),
		});
		// The final output/session are unchanged by event surfacing.
		expect(result.output).toBe("OK: prompt received");
		// Every parseable line is surfaced verbatim, in order.
		expect(events.map((e) => e.type)).toEqual(["thread.started", "item.completed"]);
		const started = events.find((e) => e.type === "thread.started");
		expect(JSON.parse(started?.raw ?? "{}").thread_id).toBe("fake-1");
	});

	test("works with no onEvent (unaudited path), output unchanged", async () => {
		const result = await new CodexExecAdapter({}).call({
			participantId: "codex",
			agentId: "codex",
			stepId: "ask",
			input: "x",
			cwd: TMPDIR,
		});
		expect(result.output).toBe("OK: prompt received");
	});

	test("surfaces JSONL emitted before a non-zero exit, and still throws", async () => {
		process.env.HANDOFF_TEST_EMIT_THEN_FAIL = "1";
		const events: AdapterEvent[] = [];
		try {
			await expect(
				new CodexExecAdapter({}).call({
					participantId: "codex",
					agentId: "codex",
					stepId: "ask",
					input: "x",
					cwd: TMPDIR,
					onEvent: (e) => events.push(e),
				}),
			).rejects.toThrow(/exited 3/);
			// The events Codex wrote before failing are preserved for the audit.
			expect(events.map((e) => e.type)).toEqual(["thread.started"]);
		} finally {
			delete process.env.HANDOFF_TEST_EMIT_THEN_FAIL;
		}
	});

	test("a throwing onEvent does not abort the drain or fail the call", async () => {
		// onEvent is observational: a handler that throws must not break the stdout
		// drain, the parse, or the run. With live reading this matters more than with
		// the old post-read pass, so it is pinned.
		const result = await new CodexExecAdapter({}).call({
			participantId: "codex",
			agentId: "codex",
			stepId: "ask",
			input: "x",
			cwd: TMPDIR,
			onEvent: () => {
				throw new Error("handler boom");
			},
		});
		expect(result.output).toBe("OK: prompt received");
	});

	test("surfaces an event to onEvent BEFORE the process completes (live, not post-exit)", async () => {
		// The fake emits thread.started, then blocks until a wait file exists. We
		// create that file only from inside onEvent, so the call can complete only if
		// thread.started reached onEvent while the child was still running. A buffered
		// (read-all-then-emit) implementation would deadlock and time out here.
		const waitFile = join(TMPDIR, "live-go.txt");
		rmSync(waitFile, { force: true });
		process.env.HANDOFF_TEST_WAIT_FILE = waitFile;
		const events: AdapterEvent[] = [];
		try {
			const result = await new CodexExecAdapter({}).call({
				participantId: "codex",
				agentId: "codex",
				stepId: "ask",
				input: "x",
				cwd: TMPDIR,
				onEvent: (e) => {
					events.push(e);
					if (e.type === "thread.started") writeFileSync(waitFile, "go");
				},
			});
			expect(result.output).toBe("LIVE: done");
			expect(events.map((e) => e.type)).toEqual([
				"thread.started",
				"item.completed",
				"turn.completed",
			]);
		} finally {
			delete process.env.HANDOFF_TEST_WAIT_FILE;
			rmSync(waitFile, { force: true });
		}
	}, 15000);
});

describe("CodexExecAdapter: usage extraction", () => {
	async function run(): Promise<Awaited<ReturnType<CodexExecAdapter["call"]>>> {
		return new CodexExecAdapter({}).call({
			participantId: "codex",
			agentId: "codex",
			stepId: "ask",
			input: "x",
			cwd: TMPDIR,
		});
	}

	test("maps a turn.completed usage block onto AdapterUsage", async () => {
		process.env.HANDOFF_TEST_EMIT_USAGE = "1";
		try {
			const result = await run();
			expect(result.usage).toEqual({
				inputTokens: 100,
				cachedInputTokens: 40,
				outputTokens: 20,
				reasoningTokens: 5,
			});
		} finally {
			delete process.env.HANDOFF_TEST_EMIT_USAGE;
		}
	});

	test("sums usage across multiple turn.completed events", async () => {
		process.env.HANDOFF_TEST_EMIT_USAGE = "1";
		process.env.HANDOFF_TEST_EMIT_USAGE_2 = "1";
		try {
			const result = await run();
			// turn 1: in 100 / cached 40 / out 20 / reasoning 5; turn 2: in 7 / out 3.
			expect(result.usage).toEqual({
				inputTokens: 107,
				cachedInputTokens: 40,
				outputTokens: 23,
				reasoningTokens: 5,
			});
		} finally {
			delete process.env.HANDOFF_TEST_EMIT_USAGE;
			delete process.env.HANDOFF_TEST_EMIT_USAGE_2;
		}
	});

	test("omits fields a turn did not report (absent is not zero)", async () => {
		process.env.HANDOFF_TEST_EMIT_USAGE_2 = "1"; // only {input_tokens, output_tokens}
		try {
			const result = await run();
			expect(result.usage).toEqual({ inputTokens: 7, outputTokens: 3 });
		} finally {
			delete process.env.HANDOFF_TEST_EMIT_USAGE_2;
		}
	});

	test("usage is absent when codex emits no turn.completed", async () => {
		const result = await run();
		expect(result.usage).toBeUndefined();
	});

	test("drops invalid token values (negative, fractional) to stay schema-valid", async () => {
		process.env.HANDOFF_TEST_EMIT_USAGE_BAD = "1";
		try {
			const result = await run();
			// input_tokens -1 and cached_input_tokens 1.5 are dropped; only the
			// non-negative integers output 2 and reasoning 3 survive.
			expect(result.usage).toEqual({ outputTokens: 2, reasoningTokens: 3 });
		} finally {
			delete process.env.HANDOFF_TEST_EMIT_USAGE_BAD;
		}
	});
});

describe("CodexExecAdapter: command construction", () => {
	test("passes -m, -c, and the read-only sandbox flags on fresh calls", async () => {
		writeFakeBin("codex", FAKE_CODEX_ARGS_RECORDER);
		const argsFile = join(TMPDIR, "argv-1.txt");
		process.env.HANDOFF_TEST_ARGS_FILE = argsFile;
		try {
			const adapter = new CodexExecAdapter({
				model: "gpt-5.3-codex",
				reasoningEffort: "xhigh",
			});
			await adapter.call({
				participantId: "codex",
				agentId: "codex",
				stepId: "ask",
				input: "x",
				cwd: TMPDIR,
			});
			const argv = readFileSync(argsFile, "utf-8").trim().split("\n");
			expect(argv).toContain("exec");
			expect(argv).toContain("--json");
			expect(argv).toContain("-m");
			expect(argv).toContain("gpt-5.3-codex");
			expect(argv).toContain("-c");
			expect(argv).toContain('model_reasoning_effort="xhigh"');
			expect(argv).toContain("--sandbox");
			expect(argv).toContain("read-only");
			expect(argv).toContain("--skip-git-repo-check");
			expect(argv[argv.length - 1]).toBe("-");
		} finally {
			delete process.env.HANDOFF_TEST_ARGS_FILE;
			writeFakeBin("codex", FAKE_CODEX);
		}
	});
});

describe("CodexExecAdapter: session resume", () => {
	test("fresh call returns session with threadId from thread.started", async () => {
		const adapter = new CodexExecAdapter({});
		const result = await adapter.call({
			participantId: "codex",
			agentId: "codex",
			stepId: "ask",
			input: "x",
			cwd: TMPDIR,
		});
		expect(result.session).toEqual({ threadId: "fake-1" });
	});

	test("resume uses 'exec resume <threadId>' with --skip-git-repo-check, drops other flags", async () => {
		writeFakeBin("codex", FAKE_CODEX_ARGS_RECORDER);
		const argsFile = join(TMPDIR, "argv-resume.txt");
		process.env.HANDOFF_TEST_ARGS_FILE = argsFile;
		try {
			const adapter = new CodexExecAdapter({
				model: "gpt-5.3-codex",
				reasoningEffort: "xhigh",
			});
			await adapter.call({
				participantId: "codex",
				agentId: "codex",
				stepId: "ask",
				input: "x",
				cwd: TMPDIR,
				session: { threadId: "prior-thread-id" },
			});
			const argv = readFileSync(argsFile, "utf-8").trim().split("\n");
			expect(argv).toContain("exec");
			expect(argv).toContain("resume");
			expect(argv).toContain("prior-thread-id");
			expect(argv[argv.length - 1]).toBe("-");
			// Resume DOES carry --skip-git-repo-check (without it, resume fails
			// outside a trusted git directory)
			expect(argv).toContain("--skip-git-repo-check");
			// Resume drops the other fresh-only flags
			expect(argv).not.toContain("--sandbox");
			expect(argv).not.toContain("-m");
			expect(argv).not.toContain("-c");
		} finally {
			delete process.env.HANDOFF_TEST_ARGS_FILE;
			writeFakeBin("codex", FAKE_CODEX);
		}
	});

	test("resume call produces RESUMED output and returns the captured threadId", async () => {
		const adapter = new CodexExecAdapter({});
		const result = await adapter.call({
			participantId: "codex",
			agentId: "codex",
			stepId: "ask",
			input: "x",
			cwd: TMPDIR,
			session: { threadId: "any-thread" },
		});
		expect(result.output).toBe("RESUMED: prompt received");
		expect(result.session).toEqual({ threadId: "fake-1" });
	});

	test("preserves prior threadId when resume output emits no thread.started", async () => {
		process.env.HANDOFF_TEST_RESUME_NO_THREAD_STARTED = "1";
		try {
			const adapter = new CodexExecAdapter({});
			const result = await adapter.call({
				participantId: "codex",
				agentId: "codex",
				stepId: "ask",
				input: "x",
				cwd: TMPDIR,
				session: { threadId: "preserved-thread" },
			});
			expect(result.session).toEqual({ threadId: "preserved-thread" });
		} finally {
			delete process.env.HANDOFF_TEST_RESUME_NO_THREAD_STARTED;
		}
	});

	test("corrupt session payload is treated as fresh start (no error)", async () => {
		const adapter = new CodexExecAdapter({});
		const result = await adapter.call({
			participantId: "codex",
			agentId: "codex",
			stepId: "ask",
			input: "x",
			cwd: TMPDIR,
			session: "this-is-a-string-not-an-object",
		});
		expect(result.output).toBe("OK: prompt received");
		expect(result.session).toEqual({ threadId: "fake-1" });
	});
});

describe("CodexExecAdapter: cancellation", () => {
	test("aborting the signal kills the child and rejects fast", async () => {
		// Fake codex sleeps 10s; without honoring the abort, the call would hang
		// that long. We abort after 100ms and assert it rejects well under 10s,
		// which can only happen if the child was killed and the await unblocked.
		process.env.HANDOFF_TEST_SLEEP = "10";
		try {
			const adapter = new CodexExecAdapter({});
			const controller = new AbortController();
			const started = Date.now();
			const p = adapter.call({
				participantId: "p",
				agentId: "codex",
				stepId: "s",
				input: "hi",
				cwd: TMPDIR,
				signal: controller.signal,
			});
			setTimeout(() => controller.abort(), 100);
			await expect(p).rejects.toThrow();
			expect(Date.now() - started).toBeLessThan(4000);
		} finally {
			delete process.env.HANDOFF_TEST_SLEEP;
		}
	});
});

describe("CodexExecAdapter: call timeout watchdog", () => {
	test("kills the child and rejects with a timeout error when callTimeoutMs elapses", async () => {
		// Fake codex sleeps 10s but the watchdog fires at 200ms. The reject can
		// only arrive quickly if the child was killed and the awaits unblocked.
		// The long-runner is `exec sleep` (the direct child), so proc.kill()
		// reaches it; a wrapping shell would orphan it and keep the pipe open.
		// NOTE: proc.kill() terminates only the DIRECT child, not a deeper
		// descendant tree - the same limitation the cancel path has.
		process.env.HANDOFF_TEST_SLEEP = "10";
		try {
			const adapter = new CodexExecAdapter({ callTimeoutMs: 200 });
			const started = Date.now();
			await expect(
				adapter.call({
					participantId: "codex",
					agentId: "codex",
					stepId: "ask",
					input: "hi",
					cwd: TMPDIR,
				}),
			).rejects.toThrow(/codex exec timed out after 200ms/);
			expect(Date.now() - started).toBeLessThan(4000);
		} finally {
			delete process.env.HANDOFF_TEST_SLEEP;
		}
	});
});
