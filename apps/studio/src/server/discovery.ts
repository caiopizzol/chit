// Cwd-scoped, parse-based discovery. Explicit path wins (and may live outside
// cwd). Without an explicit path, scan cwd (no recursion) for `*.json` files
// and run each through parseManifest. Files that fail parseManifest are
// silently dropped, not surfaced as errors: cwd commonly contains
// package.json, tsconfig.json, etc.

import { readdirSync, readFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { parseManifest } from "@chit/core";
import { resolveExplicitPath } from "./paths.ts";

export type DiscoveryResult =
	| { kind: "open"; absolutePath: string; relPath: string }
	| { kind: "picker"; candidates: Array<{ absolutePath: string; relPath: string }> }
	| { kind: "empty" };

export interface DiscoverOptions {
	cwd: string;
	explicitPath?: string;
}

function safeParseChit(absolutePath: string): boolean {
	try {
		const raw = JSON.parse(readFileSync(absolutePath, "utf-8"));
		parseManifest(raw);
		return true;
	} catch {
		return false;
	}
}

function relPathFromCwd(absolutePath: string, cwd: string): string {
	const rel = relative(cwd, absolutePath);
	return rel === "" || rel.startsWith("..") ? basename(absolutePath) : rel;
}

export function discover(opts: DiscoverOptions): DiscoveryResult {
	if (opts.explicitPath !== undefined && opts.explicitPath !== "") {
		const absolutePath = resolveExplicitPath(opts.explicitPath, opts.cwd);
		return {
			kind: "open",
			absolutePath,
			relPath: relPathFromCwd(absolutePath, opts.cwd),
		};
	}

	const entries = readdirSync(opts.cwd, { withFileTypes: true });
	const candidates: Array<{ absolutePath: string; relPath: string }> = [];
	for (const entry of entries) {
		if (!entry.isFile()) continue;
		if (!entry.name.endsWith(".json")) continue;
		const absolutePath = join(opts.cwd, entry.name);
		if (!safeParseChit(absolutePath)) continue;
		candidates.push({
			absolutePath,
			relPath: relPathFromCwd(absolutePath, opts.cwd),
		});
	}

	if (candidates.length === 0) return { kind: "empty" };
	if (candidates.length === 1) {
		const only = candidates[0];
		if (!only) return { kind: "empty" };
		return { kind: "open", absolutePath: only.absolutePath, relPath: only.relPath };
	}
	// Stable order so the picker is deterministic across runs.
	candidates.sort((a, b) => a.relPath.localeCompare(b.relPath));
	return { kind: "picker", candidates };
}
