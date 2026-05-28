// Boot-time path resolution for explicit `chit studio <path>` arguments.
// Different from the old apps/studio/src/paths.ts: there is no workspace-root
// boundary because the user is the authority for explicit paths. The "browser
// never names a filesystem path" rule still holds; this function is only
// called by the CLI at boot, never from an HTTP route handler.

import { existsSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

export type PathErrorReason = "not-found" | "not-file";

export class PathError extends Error {
	constructor(
		public reason: PathErrorReason,
		message: string,
	) {
		super(message);
		this.name = "PathError";
	}
}

// Canonicalize a user-supplied explicit path against the given cwd, then
// verify it points at a regular file. Returns the absolute canonical path.
// Outside-cwd paths are allowed; the user explicitly asked for them.
export function resolveExplicitPath(userPath: string, cwd: string): string {
	const candidate = isAbsolute(userPath) ? userPath : resolve(cwd, userPath);
	const canonical = resolve(candidate);
	if (!existsSync(canonical)) {
		throw new PathError("not-found", `path "${userPath}" does not exist`);
	}
	if (!statSync(canonical).isFile()) {
		throw new PathError("not-file", `path "${userPath}" is not a regular file`);
	}
	return canonical;
}
