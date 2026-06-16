// `chit init`: scaffold a runnable inline routine so a newcomer never hand-writes
// the JSON or creates a folder tree before they know what they need. The generated
// config is still a real, parseable, runnable routine. Users can extract a routine
// to a file later by replacing it with `{ "file": "routines/name.json" }`.
//
// Templates map to the three execution shapes a first routine is likely to want:
//   text   -- read-only call + format -> text output (runs in your cwd, no sandbox)
//   loop   -- builder + critic + a check, repeat until it passes (sandboxed)
//   check  -- a single check command, sandboxed, repeat until it passes

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseConfig } from "./config.ts";

export type Template = "text" | "loop" | "check";

export const TEMPLATES: Template[] = ["text", "loop", "check"];

// Same rule the config loader enforces, so a scaffolded id is always valid.
const ROUTINE_ID_RE = /^[a-z][a-z0-9-]*$/;

// A placeholder check that passes (so a fresh scaffold runs green) and documents, via
// its own argument, that the user should swap in a real command. `sh -c "true # ..."`
// runs `true` and treats the rest as a comment.
const PLACEHOLDER_CHECK = { command: "sh", args: ["-c", "true # replace with your real check, e.g. bun test"] };

function textManifest(): unknown {
	return {
		description: "Turn an input into text, grounded in the repo (read-only, runs in your cwd).",
		input: "topic",
		agents: {
			assistant: {
				profile: "claude",
				instructions: "You are a careful assistant. Inspect the repo at your cwd read-only to ground your answer. You write nothing.",
				filesystem: "read-only",
			},
		},
		steps: [
			{ id: "respond", call: "assistant", prompt: "Topic:\n{{ inputs.topic }}\n\nRespond concisely, grounded in the repo." },
			{ id: "out", format: "{{ steps.respond.output }}" },
		],
		output: "out",
	};
}

function loopManifest(): unknown {
	return {
		description: "Implement a change, review it, and verify with a check until it passes (sandboxed).",
		input: "task",
		agents: {
			builder: {
				profile: "claude",
				instructions: "You implement a small, well-scoped change and keep going until the check passes.",
				filesystem: "read-write",
			},
			critic: {
				profile: "claude",
				instructions: "You review the diff for correctness and scope. You do not edit files.",
				filesystem: "read-only",
			},
		},
		steps: [
			{
				id: "build",
				call: "builder",
				prompt: "Task:\n{{ inputs.task }}\n\nIteration {{ iteration }}.\nFailing check output:\n{{ steps.verify.output }}\n\nMake the smallest change toward passing the check.",
			},
			{ id: "critique", call: "critic", prompt: "Review the diff:\n{{ diff }}\n\nCall out correctness and scope problems. Be brief. Do not edit files." },
			{ id: "verify", check: [PLACEHOLDER_CHECK] },
		],
		repeat: { until: "checks-pass", maxIterations: 3 },
	};
}

function checkManifest(): unknown {
	return {
		description: "Run a check command in a sandbox until it passes.",
		inputs: {},
		steps: [{ id: "verify", check: [PLACEHOLDER_CHECK] }],
		repeat: { until: "checks-pass", maxIterations: 1 },
	};
}

function manifestFor(id: string, template: Template): unknown {
	if (template === "loop") return loopManifest();
	if (template === "check") return checkManifest();
	return textManifest();
}

export interface ScaffoldResult {
	routineRef: string; // e.g. chit.config.json#routines.review
	createdConfig: boolean;
	template: Template;
	inputHint?: string; // e.g. --input topic="..."
}

const INPUT_HINTS: Record<Template, string | undefined> = {
	text: '--input topic="..."',
	loop: '--input task="..."',
	check: undefined,
};

export function scaffoldRoutine(cwd: string, name: string, template: Template): ScaffoldResult {
	if (!ROUTINE_ID_RE.test(name)) {
		throw new Error(`routine name must be kebab-case and start with a letter (got ${JSON.stringify(name)})`);
	}

	// Load-or-create the config. An EXISTING config is validated with parseConfig BEFORE
	// anything is written, so init never extends a malformed config (which would leave the
	// scaffolded routine unrunnable) and never leaves a half-written state. We keep the raw
	// object (parseConfig has confirmed routines is a proper object) to preserve entries.
	const configPath = join(cwd, "chit.config.json");
	let config: { routines: Record<string, unknown>; profiles?: Record<string, unknown> };
	let createdConfig = false;
	if (existsSync(configPath)) {
		let raw: unknown;
		try {
			raw = JSON.parse(readFileSync(configPath, "utf-8"));
		} catch (e) {
			throw new Error(`chit.config.json is not valid JSON: ${(e as Error).message}`);
		}
		try {
			parseConfig(raw, "chit.config.json");
		} catch (e) {
			throw new Error(`existing chit.config.json is invalid, fix it before running init: ${(e as Error).message}`);
		}
		config = raw as { routines: Record<string, unknown>; profiles?: Record<string, unknown> };
	} else {
		config = { profiles: {}, routines: {} };
		createdConfig = true;
	}
	const routines = config.routines;
	if (routines[name] !== undefined) {
		throw new Error(`routine ${JSON.stringify(name)} already exists in chit.config.json`);
	}

	const manifest = manifestFor(name, template) as { description?: string };
	routines[name] = manifest;
	// The generated routine agents reference profile ids; make sure each is bound.
	const profileRegistry = config.profiles ?? (config.profiles = {});
	const participants = (manifest as { agents?: Record<string, { profile: string }> }).agents ?? {};
	for (const p of Object.values(participants)) {
		if (profileRegistry[p.profile] === undefined) profileRegistry[p.profile] = "claude";
	}
	writeFileSync(configPath, `${JSON.stringify(config, null, "\t")}\n`);

	return {
		routineRef: `chit.config.json#routines.${name}`,
		createdConfig,
		template,
		...(INPUT_HINTS[template] !== undefined && { inputHint: INPUT_HINTS[template] }),
	};
}
