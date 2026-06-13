#!/usr/bin/env bun
// The bin: wire the real world (claude CLI adapter, wall clock, random ids,
// stdout/stderr, cwd) into runCli and exit with its code.

import { claudeCliAdapter } from "./adapter.ts";
import { argvCheckRunner } from "./check-runner.ts";
import { runCli } from "./cli.ts";
import { gitWorktreeSandboxFactory } from "./sandbox.ts";

const code = await runCli(process.argv.slice(2), {
	cwd: process.cwd(),
	adapter: claudeCliAdapter,
	checkRunner: argvCheckRunner,
	sandboxFactory: gitWorktreeSandboxFactory,
	now: () => Date.now(),
	newRunId: () => `run-${crypto.randomUUID().slice(0, 8)}`,
	out: (line) => console.log(line),
	err: (line) => console.error(line),
});

process.exit(code);
