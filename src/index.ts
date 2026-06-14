#!/usr/bin/env bun
// The bin: wire the real world (claude CLI adapter, wall clock, random ids,
// stdout/stderr, cwd) into runCli and exit with its code.

import { claudeCliAdapter } from "./adapter.ts";
import { argvCheckRunner } from "./check-runner.ts";
import { runCli } from "./cli.ts";
import { gitWorktreeSandboxFactory } from "./sandbox.ts";

// Ctrl-C cancellation: the first SIGINT aborts the signal, which kills the active
// claude call / check and stops the run at the next step (the executor writes a
// "cancelled" receipt and a sandboxed run discards its worktree in `finally`). A
// second SIGINT force-exits in case something is wedged.
const controller = new AbortController();
let interrupts = 0;
process.on("SIGINT", () => {
	interrupts += 1;
	if (interrupts === 1) {
		process.stderr.write("\n^C  cancelling -- stopping the active step, discarding any sandbox (Ctrl-C again to force-exit)…\n");
		controller.abort();
	} else {
		process.stderr.write("\nforced exit.\n");
		process.exit(130);
	}
});

const code = await runCli(process.argv.slice(2), {
	cwd: process.cwd(),
	// Adapter registry keyed by adapter type. Adding another backend (e.g. a different
	// CLI or API) is one more entry here; the agent config picks which one each agent uses.
	adapters: { claude: claudeCliAdapter },
	checkRunner: argvCheckRunner,
	sandboxFactory: gitWorktreeSandboxFactory,
	now: () => Date.now(),
	newRunId: () => `run-${crypto.randomUUID().slice(0, 8)}`,
	out: (line) => console.log(line),
	err: (line) => console.error(line),
	// Live progress streams to stderr as it happens; the final result is on stdout.
	onProgress: (line) => process.stderr.write(`${line}\n`),
	signal: controller.signal,
});

process.exit(code);
