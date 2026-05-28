// Path discipline for chit-studio.
//
// Two responsibilities:
// 1. Resolve user-supplied paths from a stable base (the workspace root), so
//    the same query string works no matter what cwd Studio was launched in.
// 2. Refuse paths that escape the workspace root (path-traversal). Even for a
//    read-only viewer, a localhost server is reachable via DNS rebinding;
//    early discipline prevents adding writes on a permissive base later.

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

let cachedRoot: string | null = null;

// Walk up from `start` looking for a package.json whose `workspaces` field
// is set. That marks the monorepo root. Throws if none found.
export function findWorkspaceRoot(start: string): string {
	if (cachedRoot) return cachedRoot;
	let dir = start;
	while (dir !== dirname(dir)) {
		const pkgPath = join(dir, "package.json");
		if (existsSync(pkgPath)) {
			try {
				const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { workspaces?: unknown };
				if (pkg.workspaces) {
					cachedRoot = dir;
					return dir;
				}
			} catch {
				// unparseable package.json, keep walking
			}
		}
		dir = dirname(dir);
	}
	throw new Error(`chit-studio: could not find workspace root walking up from ${start}`);
}

export type PathErrorReason = "outside-workspace" | "not-found" | "not-file";

export class PathError extends Error {
	constructor(
		public reason: PathErrorReason,
		message: string,
	) {
		super(message);
		this.name = "PathError";
	}
}

// Resolve `userPath` to an absolute path that is guaranteed to live inside
// `workspaceRoot`. Relative paths are joined to the workspace root (NOT to
// process.cwd()), so quick-links work regardless of how Studio was launched.
// Absolute paths are accepted only if they resolve inside the workspace root.
// Path-traversal sequences (`..`) that escape the workspace are rejected.
// The returned path is verified to point at an existing regular file.
export function resolveSafePath(userPath: string, workspaceRoot: string): string {
	const candidate = isAbsolute(userPath) ? userPath : join(workspaceRoot, userPath);
	const resolved = resolve(candidate);
	const inside = resolved === workspaceRoot || resolved.startsWith(workspaceRoot + sep);
	if (!inside) {
		throw new PathError(
			"outside-workspace",
			`path "${userPath}" resolves outside the workspace root`,
		);
	}
	if (!existsSync(resolved)) {
		throw new PathError("not-found", `path "${userPath}" does not exist`);
	}
	if (!statSync(resolved).isFile()) {
		throw new PathError("not-file", `path "${userPath}" is not a regular file`);
	}
	return resolved;
}
