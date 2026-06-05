// The running MCP server's own version, plus a binary-skew check for chit_status.
//
// Why this exists: the server process is long-lived. A global `chit` install can
// be upgraded while an old server keeps running the pre-upgrade binary, so a
// dogfood unknowingly runs against a stale server. chit_status' overview surfaces
// the running version and warns when the on-disk binary is newer (a reconnect is
// needed to pick it up).
//
// The running version is captured ONCE at module load (RUNNING_VERSION below): at
// process start the file on disk is exactly what is executing, so the startup read
// IS the running version. The handler re-reads resolveOwnVersion() to see the live
// disk state and compares the two.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

// How far up to walk looking for the CLI package.json. Covers both layouts: the
// published bundle (<pkg>/dist/chit.js, package.json one level up) and the repo
// source (apps/cli/src/surfaces/mcp, package.json three levels up). The name check
// is what disambiguates them, not the depth -- this is just a safety bound.
const MAX_WALK_LEVELS = 6;

const CLI_PACKAGE_NAME = "@chit-run/cli";

// Walk UPWARD from startDir looking for a package.json whose "name" is the CLI
// package, and return its "version". Returns undefined when nothing matches within
// the walk, or the matching file is unreadable / invalid JSON / missing a string
// version. NEVER throws: a status poll must not fail because the package metadata
// is absent or malformed.
//
// The name check (not a fixed dirname count) is what makes both the published
// bundle and the repo source resolve correctly; see the module header.
export function resolveOwnVersion(startDir: string = import.meta.dir): string | undefined {
	let dir = startDir;
	for (let level = 0; level < MAX_WALK_LEVELS; level++) {
		const candidate = join(dir, "package.json");
		try {
			const pkg: unknown = JSON.parse(readFileSync(candidate, "utf-8"));
			if (
				pkg !== null &&
				typeof pkg === "object" &&
				(pkg as { name?: unknown }).name === CLI_PACKAGE_NAME
			) {
				const version = (pkg as { version?: unknown }).version;
				return typeof version === "string" ? version : undefined;
			}
		} catch {
			// No package.json here (or it is unreadable / invalid JSON): keep walking.
		}
		const parent = dirname(dir);
		if (parent === dir) break; // reached the filesystem root
		dir = parent;
	}
	return undefined;
}

// The version of the binary that was executing when this module first loaded --
// the running server's version. Captured once, at startup, on purpose.
export const RUNNING_VERSION: string | undefined = resolveOwnVersion();

// The chit_status `server` block: the running version, plus skew fields only when
// the on-disk binary differs from the running process.
export interface ServerVersionInfo {
	version: string;
	installedVersion?: string;
	note?: string;
}

// PURE. Reports the running version, and -- ONLY when both versions are known and
// differ -- the installed version plus a note that the server must be reconnected
// to pick up the on-disk binary. When the running version is unknown we never
// claim skew (there is nothing to compare against).
export function describeServerVersion(
	running: string | undefined,
	installedNow: string | undefined,
): ServerVersionInfo {
	const version = running ?? "unknown";
	if (running !== undefined && installedNow !== undefined && running !== installedNow) {
		return {
			version,
			installedVersion: installedNow,
			note: `The running MCP server is version ${running}, but the installed chit binary on disk is version ${installedNow}. Reconnect (restart) the MCP server to run the installed binary.`,
		};
	}
	return { version };
}
