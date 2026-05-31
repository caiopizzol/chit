// Browser-safe registry module. Contains the pure parts of the agent
// registry: built-in agents, adapter capability descriptors, validation,
// and the in-memory parseRegistry. NO node imports, NO file IO.
//
// File-backed loading (reading ~/.config/chit/agents.json) lives in
// src/agents/parse.ts so consumers that only need metadata (graph-model,
// shared validators, future Studio web UI) don't transitively pull
// node:fs/os/path into a browser bundle.

import type {
	AdapterDescriptor,
	AdapterKind,
	NormalizedAgent,
	NormalizedRegistry,
} from "./types.ts";

export class RegistryError extends Error {
	constructor(
		public readonly path: string,
		message: string,
	) {
		super(`${path}: ${message}`);
		this.name = "RegistryError";
	}
}

const ADAPTERS: Record<AdapterKind, AdapterDescriptor> = {
	"codex-exec": {
		kind: "codex-exec",
		// Hard OS sandbox: codex exec always runs with `--sandbox read-only`.
		capabilities: { enforces_filesystem_read_only: true },
	},
	"claude-cli": {
		kind: "claude-cli",
		// Enforced by claude PLAN-MODE PERMISSIONS, not an OS/filesystem sandbox: a
		// read_only participant is run with `--permission-mode plan`, which blocks
		// every write (file edits and write-capable Bash) while allowing reads and
		// read-only shell. Codex remains the hard sandbox; this is a softer,
		// permission-level guarantee.
		capabilities: { enforces_filesystem_read_only: true },
	},
};
const ADAPTER_KINDS: ReadonlySet<string> = new Set(Object.keys(ADAPTERS));

const BUILT_IN_AGENTS: Readonly<Record<string, NormalizedAgent>> = {
	// Built-in profiles deliberately pin no model / reasoning effort: they
	// defer to the user's local CLI default so smoke runs stay fast and
	// resume calls inherit the original session config. Users wanting a
	// specific profile (e.g., gpt-5.3-codex + xhigh) add a custom agent
	// like `codex-deep` in ~/.config/chit/agents.json and reference
	// that id from their manifests.
	codex: {
		id: "codex",
		adapter: "codex-exec",
		passModelOnResume: false,
		description: "OpenAI Codex via the codex CLI; uses your local default model and effort.",
		builtIn: true,
	},
	claude: {
		id: "claude",
		adapter: "claude-cli",
		passModelOnResume: false,
		description: "Claude via `claude --print`; uses your local default model.",
		builtIn: true,
	},
};
const BUILT_IN_IDS: ReadonlySet<string> = new Set(Object.keys(BUILT_IN_AGENTS));

const ALLOWED_TOP_KEYS = new Set(["agents"]);
const ALLOWED_ENTRY_KEYS = new Set([
	"adapter",
	"model",
	"reasoningEffort",
	"passModelOnResume",
	"description",
	"env",
	"strictMcp",
	"callTimeoutMs",
	"noProgressTimeoutMs",
]);
const AGENT_ID_RE = /^[a-z][a-z0-9-]*$/;

export function getAdapterDescriptor(kind: string): AdapterDescriptor | undefined {
	return ADAPTERS[kind as AdapterKind];
}

export function isBuiltInAgent(id: string): boolean {
	return BUILT_IN_IDS.has(id);
}

function isObject(v: unknown): v is Record<string, unknown> {
	return v !== null && typeof v === "object" && !Array.isArray(v);
}

function builtIns(): Record<string, NormalizedAgent> {
	const out: Record<string, NormalizedAgent> = {};
	for (const [id, agent] of Object.entries(BUILT_IN_AGENTS)) {
		out[id] = { ...agent };
	}
	return out;
}

function parseEnv(raw: unknown, path: string): Record<string, string> {
	if (!isObject(raw)) throw new RegistryError(path, "must be a JSON object");
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(raw)) {
		if (typeof v !== "string") {
			throw new RegistryError(`${path}.${k}`, `must be a string (got ${typeof v})`);
		}
		out[k] = v;
	}
	return out;
}

function parseAgent(id: string, raw: unknown, configPath: string): NormalizedAgent {
	const path = `${configPath}: agents.${id}`;
	if (!isObject(raw)) throw new RegistryError(path, "must be a JSON object");

	for (const k of Object.keys(raw)) {
		if (!ALLOWED_ENTRY_KEYS.has(k)) throw new RegistryError(path, `unknown field "${k}"`);
	}

	const adapter = raw.adapter;
	if (typeof adapter !== "string" || !ADAPTER_KINDS.has(adapter)) {
		throw new RegistryError(`${path}.adapter`, `must be one of: ${[...ADAPTER_KINDS].join(", ")}`);
	}

	const out: NormalizedAgent = {
		id,
		adapter: adapter as AdapterKind,
		passModelOnResume: false,
		builtIn: false,
	};

	if (raw.model !== undefined) {
		if (typeof raw.model !== "string" || !raw.model) {
			throw new RegistryError(`${path}.model`, "must be a non-empty string");
		}
		out.model = raw.model;
	}
	if (raw.reasoningEffort !== undefined) {
		if (typeof raw.reasoningEffort !== "string" || !raw.reasoningEffort) {
			throw new RegistryError(`${path}.reasoningEffort`, "must be a non-empty string");
		}
		out.reasoningEffort = raw.reasoningEffort;
	}
	if (raw.passModelOnResume !== undefined) {
		if (typeof raw.passModelOnResume !== "boolean") {
			throw new RegistryError(`${path}.passModelOnResume`, "must be a boolean");
		}
		out.passModelOnResume = raw.passModelOnResume;
	}
	if (raw.description !== undefined) {
		if (typeof raw.description !== "string") {
			throw new RegistryError(`${path}.description`, "must be a string");
		}
		out.description = raw.description;
	}
	if (raw.env !== undefined) {
		out.env = parseEnv(raw.env, `${path}.env`);
	}
	if (raw.strictMcp !== undefined) {
		if (typeof raw.strictMcp !== "boolean") {
			throw new RegistryError(`${path}.strictMcp`, "must be a boolean");
		}
		out.strictMcp = raw.strictMcp;
	}
	if (raw.callTimeoutMs !== undefined) {
		if (
			typeof raw.callTimeoutMs !== "number" ||
			!Number.isInteger(raw.callTimeoutMs) ||
			raw.callTimeoutMs <= 0
		) {
			throw new RegistryError(`${path}.callTimeoutMs`, "must be a positive integer");
		}
		out.callTimeoutMs = raw.callTimeoutMs;
	}
	if (raw.noProgressTimeoutMs !== undefined) {
		if (
			typeof raw.noProgressTimeoutMs !== "number" ||
			!Number.isInteger(raw.noProgressTimeoutMs) ||
			raw.noProgressTimeoutMs <= 0
		) {
			throw new RegistryError(`${path}.noProgressTimeoutMs`, "must be a positive integer");
		}
		out.noProgressTimeoutMs = raw.noProgressTimeoutMs;
	}

	return out;
}

export function parseRegistry(raw: unknown, configPath = "<inline>"): NormalizedRegistry {
	const agents = builtIns();

	if (raw === undefined || raw === null) {
		return { agents };
	}
	if (!isObject(raw)) {
		throw new RegistryError(configPath, "top-level must be a JSON object");
	}

	for (const k of Object.keys(raw)) {
		if (!ALLOWED_TOP_KEYS.has(k)) {
			throw new RegistryError(configPath, `unknown top-level field "${k}"`);
		}
	}

	const userAgents = raw.agents;
	if (userAgents === undefined) {
		return { agents };
	}
	if (!isObject(userAgents)) {
		throw new RegistryError(`${configPath}: agents`, "must be a JSON object");
	}

	for (const [id, entry] of Object.entries(userAgents)) {
		if (BUILT_IN_IDS.has(id)) {
			throw new RegistryError(
				`${configPath}: agents.${id}`,
				"built-in agent id cannot be redefined by user config",
			);
		}
		if (!AGENT_ID_RE.test(id)) {
			throw new RegistryError(
				`${configPath}: agents.${id}`,
				"agent id must be kebab-case (lowercase letters, digits, hyphens; starts with a letter)",
			);
		}
		agents[id] = parseAgent(id, entry, configPath);
	}

	return { agents };
}
