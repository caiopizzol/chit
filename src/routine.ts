// Resolve a named routine into the thing we can list, inspect, and run: the
// config entry joined to its bound, parsed manifest plus a content digest. The
// digest is the binding identity -- a small nod to the hardened runtime's
// approval model, surfaced by `inspect` so a reader can see exactly which bytes a
// run would execute.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { AgentConfig, ChitConfig } from "./config.ts";
import { type Manifest, parseManifest } from "./manifest.ts";

export interface ResolvedRoutine {
	id: string;
	description?: string;
	manifestPath: string;
	manifestAbs: string;
	manifest: Manifest;
	defaults?: { maxIterations?: number };
	digest: string;
	// Each participant's agent id bound to its config entry (adapter + model). Set by
	// resolveRoutine; inspect surfaces it. (Optional so hand-built test routines may omit it.)
	agents?: Record<string, AgentConfig>;
}

export class RoutineError extends Error {
	constructor(detail: string) {
		super(detail);
		this.name = "RoutineError";
	}
}

export function digestText(text: string): string {
	return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

type ReadFile = (absPath: string) => string;

const defaultReadFile: ReadFile = (p) => readFileSync(p, "utf-8");

export function resolveRoutine(
	config: ChitConfig,
	id: string,
	cwd: string,
	readFile: ReadFile = defaultReadFile,
): ResolvedRoutine {
	const entry = config.routines[id];
	if (entry === undefined) {
		const known = Object.keys(config.routines).sort();
		throw new RoutineError(
			`unknown routine ${JSON.stringify(id)}${known.length > 0 ? ` (known: ${known.join(", ")})` : " (none configured)"}`,
		);
	}
	const manifestAbs = isAbsolute(entry.manifestPath)
		? entry.manifestPath
		: resolve(cwd, entry.manifestPath);

	let text: string;
	try {
		text = readFile(manifestAbs);
	} catch (e) {
		throw new RoutineError(`could not read manifest for ${JSON.stringify(id)} at ${entry.manifestPath}: ${(e as Error).message}`);
	}

	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (e) {
		throw new RoutineError(`manifest for ${JSON.stringify(id)} is not valid JSON: ${(e as Error).message}`);
	}

	const manifest: Manifest = parseManifest(raw, entry.manifestPath);

	// Bind each participant's agent id to its config entry, so the run knows which
	// adapter/model backs it. A participant that references an undefined agent fails HERE,
	// at resolve, not mid-run.
	const agents: Record<string, AgentConfig> = {};
	for (const p of Object.values(manifest.participants)) {
		const agentCfg = config.agents[p.agent];
		if (agentCfg === undefined) {
			const known = Object.keys(config.agents).sort();
			throw new RoutineError(
				`routine ${JSON.stringify(id)} uses agent ${JSON.stringify(p.agent)}, which is not defined under "agents" in chit.config.json${known.length > 0 ? ` (configured: ${known.join(", ")})` : " (no agents configured)"}`,
			);
		}
		agents[p.agent] = agentCfg;
	}

	return {
		id,
		description: entry.description ?? manifest.description,
		manifestPath: entry.manifestPath,
		manifestAbs,
		manifest,
		...(entry.defaults !== undefined && { defaults: entry.defaults }),
		digest: digestText(text),
		agents,
	};
}
