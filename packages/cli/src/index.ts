#!/usr/bin/env -S bun --no-env-file
// The bin: wire the real world (claude CLI adapter, wall clock, random ids,
// stdout/stderr, cwd) into runCli and exit with its code.

import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
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

function packageVersion(): string {
	try {
		const raw = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf-8")) as { version?: unknown };
		return typeof raw.version === "string" ? raw.version : "unknown";
	} catch {
		return "unknown";
	}
}

function runIdFactory(): () => string {
	const forcedRunId = process.env.CHIT_RUN_ID;
	let usedForcedRunId = false;
	return () => {
		if (forcedRunId !== undefined && forcedRunId !== "" && !usedForcedRunId) {
			usedForcedRunId = true;
			return forcedRunId;
		}
		return `run-${crypto.randomUUID().slice(0, 8)}`;
	};
}

function currentEnv(): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (typeof value === "string") env[key] = value;
	}
	return env;
}

const newRunId = runIdFactory();

function cliArgv(): string[] {
	const argvPath = process.env.CHIT_ARGV_PATH;
	if (argvPath === undefined || argvPath === "") return process.argv.slice(2);
	try {
		const value = JSON.parse(readFileSync(argvPath, "utf-8")) as unknown;
		if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
			throw new Error("must contain a JSON string array");
		}
		return value;
	} finally {
		rmSync(argvPath, { force: true });
	}
}

let argv: string[];
try {
	argv = cliArgv();
} catch (e) {
	console.error(`error: could not read background argv: ${(e as Error).message}`);
	process.exit(1);
}
delete process.env.CHIT_RUN_ID;
delete process.env.CHIT_ARGV_PATH;
delete process.env.CHIT_LOG_PATH;

const code = await runCli(argv, {
	cwd: process.cwd(),
	// CHIT_PROJECT points commands at another project dir from any cwd; a global --project arg
	// overrides it. Resolution + validation live in runCli so they are testable.
	...(process.env.CHIT_PROJECT !== undefined &&
		process.env.CHIT_PROJECT !== "" && { projectEnv: process.env.CHIT_PROJECT }),
	// Adapter registry keyed by adapter type. Adding another backend is one more entry
	// here; the agent config picks which one each agent uses.
	adapters: { claude: claudeCliAdapter, gemini: geminiCliAdapter, codex: codexCliAdapter },
	checkRunner: argvCheckRunner,
	sandboxFactory: gitWorktreeSandboxFactory,
	now: () => Date.now(),
	newRunId,
	out: (line) => console.log(line),
	err: (line) => console.error(line),
	// Live progress streams to stderr as it happens; the final result is on stdout.
	onProgress: (line) => process.stderr.write(`${line}\n`),
	signal: controller.signal,
	askUser: askOnStdin,
	doctorProbes: realDoctorProbes,
	runtime: { version: packageVersion(), entrypoint: Bun.main },
	backgroundSpawner: {
		spawn(args, opts) {
			// The child runs in opts.cwd (already the resolved project dir), so it must not
			// re-resolve a (possibly relative) CHIT_PROJECT against it -- strip it from the env.
			const env = { ...currentEnv(), ...opts.env };
			delete env.CHIT_PROJECT;
			const child = Bun.spawn(
				[
					"sh",
					"-c",
					'exec "$@" >> "$CHIT_LOG_PATH" 2>&1',
					"chit-background",
					process.execPath,
					"--no-env-file",
					Bun.main,
					...args,
				],
				{
					cwd: opts.cwd,
					env,
					stdin: "ignore",
					stdout: "ignore",
					stderr: "ignore",
					detached: true,
				},
			);
			child.unref();
			return { pid: child.pid };
		},
	},
});

process.exit(code);
