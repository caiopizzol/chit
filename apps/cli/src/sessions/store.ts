import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { SessionKey, SessionStore } from "./types.ts";

function isObject(v: unknown): v is Record<string, unknown> {
	return v !== null && typeof v === "object" && !Array.isArray(v);
}

// Filesystem-safe: only [a-zA-Z0-9._-], everything else becomes `_`.
function safeSegment(s: string): string {
	return s.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function entryKey(participantId: string, fingerprint: string): string {
	return `${participantId}--${fingerprint}`;
}

export function defaultSessionDir(): string {
	const xdg = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
	return join(xdg, "handoff", "sessions");
}

// File layout:
//   <baseDir>/<safe-scope>--<safe-manifestId>--<hash>.json
//
// `safe-*` are filesystem-sanitized renderings for human discoverability.
// `hash` is sha256(scope + "\\0" + manifestId), 12 hex chars. The hash makes
// the filename collision-free: two scopes that sanitize to the same string
// (e.g., "foo/bar" and "foo_bar") still produce distinct files.
//
// File contents:
//   { "<participantId>--<fingerprint>": <opaque payload>, ... }
export class FileSessionStore implements SessionStore {
	constructor(private readonly baseDir: string) {}

	load(key: SessionKey): unknown | undefined {
		const path = this.filePath(key);
		if (!existsSync(path)) return undefined;
		let raw: unknown;
		try {
			raw = JSON.parse(readFileSync(path, "utf-8"));
		} catch {
			return undefined;
		}
		if (!isObject(raw)) return undefined;
		return raw[entryKey(key.participantId, key.fingerprint)];
	}

	save(key: SessionKey, payload: unknown): void {
		const path = this.filePath(key);
		mkdirSync(dirname(path), { recursive: true });

		let data: Record<string, unknown> = {};
		if (existsSync(path)) {
			try {
				const raw = JSON.parse(readFileSync(path, "utf-8"));
				if (isObject(raw)) data = raw;
			} catch {
				data = {};
			}
		}
		data[entryKey(key.participantId, key.fingerprint)] = payload;
		writeFileSync(path, JSON.stringify(data, null, 2));
	}

	private filePath(key: SessionKey): string {
		const readable = `${safeSegment(key.scope)}--${safeSegment(key.manifestId)}`;
		const hash = createHash("sha256")
			.update(`${key.scope}\u0000${key.manifestId}`)
			.digest("hex")
			.slice(0, 12);
		return join(this.baseDir, `${readable}--${hash}.json`);
	}
}
