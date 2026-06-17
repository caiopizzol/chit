#!/usr/bin/env bun
// The bin: wire the real world (claude CLI adapter, wall clock, random ids,
// stdout/stderr, cwd) into runCli and exit with its code.

import { createInterface, type Interface } from "node:readline";
import { claudeCliAdapter, codexCliAdapter, geminiCliAdapter } from "./adapter.ts";
import { argvCheckRunner } from "./check-runner.ts";
import { runCli } from "./cli.ts";
import { realDoctorProbes } from "./doctor.ts";
import { gitWorktreeSandboxFactory } from "./sandbox.ts";

// Ctrl-C cancellation: the first SIGINT aborts the signal, which kills the active
// claude call / check and stops the run at the next step (the executor writes a
// "cancelled" receipt and a sandboxed run discards its worktree in `finally`). A
// second SIGINT force-exits in case something is wedged.
const controller = new AbortController();
let interrupts = 0;
function requestCancel(source: "SIGINT" | "SIGTERM"): void {
	interrupts += 1;
	if (interrupts === 1) {
		process.stderr.write(
			source === "SIGINT"
				? "\n^C  cancelling -- stopping the active step, discarding any sandbox (Ctrl-C again to force-exit)…\n"
				: "\nSIGTERM  cancelling -- stopping the active step, discarding any sandbox…\n",
		);
		controller.abort();
	} else {
		process.stderr.write("\nforced exit.\n");
		process.exit(130);
	}
}
process.on("SIGINT", () => requestCancel("SIGINT"));
process.on("SIGTERM", () => requestCancel("SIGTERM"));

// Human-input seam for `ask` steps. The question and the `> ` prompt go to stderr (stdout
// is the result channel); the typed line is the answer. One shared readline for the run's
// lifetime; we process.exit at the end, so it needs no explicit teardown. Abort-aware: a
// Ctrl-C while waiting rejects the pending ask, so the run cancels instead of hanging.
let rl: Interface | undefined;
function askOnStdin(question: string): Promise<string> {
	rl ??= createInterface({ input: process.stdin, output: process.stderr });
	return new Promise((resolve, reject) => {
		if (controller.signal.aborted) return reject(new Error("cancelled"));
		const onAbort = () => reject(new Error("cancelled"));
		controller.signal.addEventListener("abort", onAbort, { once: true });
		rl?.question(`\n${question}\n> `, (answer) => {
			controller.signal.removeEventListener("abort", onAbort);
			resolve(answer);
		});
	});
}

const code = await runCli(process.argv.slice(2), {
	cwd: process.cwd(),
	// Adapter registry keyed by adapter type. Adding another backend is one more entry
	// here; the agent config picks which one each agent uses.
	adapters: { claude: claudeCliAdapter, gemini: geminiCliAdapter, codex: codexCliAdapter },
	checkRunner: argvCheckRunner,
	sandboxFactory: gitWorktreeSandboxFactory,
	now: () => Date.now(),
	newRunId: () => `run-${crypto.randomUUID().slice(0, 8)}`,
	out: (line) => console.log(line),
	err: (line) => console.error(line),
	// Live progress streams to stderr as it happens; the final result is on stdout.
	onProgress: (line) => process.stderr.write(`${line}\n`),
	signal: controller.signal,
	askUser: askOnStdin,
	doctorProbes: realDoctorProbes,
});

process.exit(code);
