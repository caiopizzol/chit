import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSessionStore } from "./store.ts";
import type { SessionKey } from "./types.ts";

function key(overrides: Partial<SessionKey> = {}): SessionKey {
	return {
		scope: "test-scope",
		manifestId: "test-manifest",
		participantId: "test-participant",
		fingerprint: "fp1",
		...overrides,
	};
}

let TMPDIR: string;
let store: FileSessionStore;

beforeEach(() => {
	TMPDIR = mkdtempSync(join(tmpdir(), "handoff-store-"));
	store = new FileSessionStore(TMPDIR);
});

afterEach(() => {
	rmSync(TMPDIR, { recursive: true, force: true });
});

describe("FileSessionStore", () => {
	test("load returns undefined when no file exists", () => {
		expect(store.load(key())).toBeUndefined();
	});

	test("save then load round-trips the payload", () => {
		store.save(key(), { threadId: "abc-123" });
		expect(store.load(key())).toEqual({ threadId: "abc-123" });
	});

	test("save updates existing entry without dropping siblings", () => {
		store.save(key({ participantId: "alice", fingerprint: "fp-a" }), { id: "a-1" });
		store.save(key({ participantId: "bob", fingerprint: "fp-b" }), { id: "b-1" });
		store.save(key({ participantId: "alice", fingerprint: "fp-a" }), { id: "a-2" });

		expect(store.load(key({ participantId: "alice", fingerprint: "fp-a" }))).toEqual({ id: "a-2" });
		expect(store.load(key({ participantId: "bob", fingerprint: "fp-b" }))).toEqual({ id: "b-1" });
	});

	test("different fingerprints for the same participant are isolated", () => {
		store.save(key({ fingerprint: "fp-old" }), { id: "old" });
		store.save(key({ fingerprint: "fp-new" }), { id: "new" });
		expect(store.load(key({ fingerprint: "fp-old" }))).toEqual({ id: "old" });
		expect(store.load(key({ fingerprint: "fp-new" }))).toEqual({ id: "new" });
	});

	test("different scopes write to different files", () => {
		store.save(key({ scope: "scope-a" }), { id: "a" });
		store.save(key({ scope: "scope-b" }), { id: "b" });
		const files = readdirSync(TMPDIR);
		expect(files.length).toBe(2);
		expect(store.load(key({ scope: "scope-a" }))).toEqual({ id: "a" });
		expect(store.load(key({ scope: "scope-b" }))).toEqual({ id: "b" });
	});

	test("different manifestIds for the same scope write to different files", () => {
		store.save(key({ manifestId: "consult" }), { id: "c" });
		store.save(key({ manifestId: "investigate" }), { id: "i" });
		const files = readdirSync(TMPDIR).sort();
		expect(files.length).toBe(2);
		expect(store.load(key({ manifestId: "consult" }))).toEqual({ id: "c" });
		expect(store.load(key({ manifestId: "investigate" }))).toEqual({ id: "i" });
	});

	test("file contents are pretty-printed JSON keyed by participant--fingerprint", () => {
		store.save(key({ participantId: "alice", fingerprint: "fpa" }), { id: "a" });
		store.save(key({ participantId: "bob", fingerprint: "fpb" }), { id: "b" });
		const files = readdirSync(TMPDIR);
		expect(files.length).toBe(1);
		const file = files[0];
		if (!file) throw new Error("expected one file");
		const raw = JSON.parse(readFileSync(join(TMPDIR, file), "utf-8"));
		expect(raw).toEqual({
			"alice--fpa": { id: "a" },
			"bob--fpb": { id: "b" },
		});
	});

	test("scope segments unsafe for filesystem are sanitized", () => {
		store.save(key({ scope: "/path/with/slashes" }), { id: "x" });
		const files = readdirSync(TMPDIR);
		expect(files.length).toBe(1);
		const file = files[0] ?? "";
		expect(file).not.toContain("/");
		expect(file).toContain("_path_with_slashes");
	});

	test("scopes that sanitize to the same string don't collide", () => {
		// "foo/bar" and "foo_bar" both become "foo_bar" after sanitization;
		// the hash suffix must keep them in distinct files.
		store.save(key({ scope: "foo/bar" }), { id: "slashed" });
		store.save(key({ scope: "foo_bar" }), { id: "underscored" });
		const files = readdirSync(TMPDIR);
		expect(files.length).toBe(2);
		expect(store.load(key({ scope: "foo/bar" }))).toEqual({ id: "slashed" });
		expect(store.load(key({ scope: "foo_bar" }))).toEqual({ id: "underscored" });
	});

	test("missing parent directory is created on save", () => {
		const nested = join(TMPDIR, "nested", "deeper");
		const nestedStore = new FileSessionStore(nested);
		expect(existsSync(nested)).toBe(false);
		nestedStore.save(key(), { id: "x" });
		expect(existsSync(nested)).toBe(true);
		expect(nestedStore.load(key())).toEqual({ id: "x" });
	});
});

describe("FileSessionStore: legacy fallback", () => {
	test("reads the legacy dir when the new dir misses, and migrates on save", () => {
		const newDir = join(TMPDIR, "new");
		const legacyDir = join(TMPDIR, "legacy");
		// A session written before the chit-path migration lives only in legacy.
		new FileSessionStore(legacyDir).save(key(), { threadId: "legacy-1" });
		const store = new FileSessionStore(newDir, legacyDir);
		expect(store.load(key())).toEqual({ threadId: "legacy-1" });
		// Save writes the new dir; the legacy file is left as-is.
		store.save(key(), { threadId: "migrated-1" });
		expect(new FileSessionStore(newDir).load(key())).toEqual({ threadId: "migrated-1" });
		expect(new FileSessionStore(legacyDir).load(key())).toEqual({ threadId: "legacy-1" });
	});

	test("prefers the new dir over the legacy dir", () => {
		const newDir = join(TMPDIR, "new");
		const legacyDir = join(TMPDIR, "legacy");
		new FileSessionStore(newDir).save(key(), { threadId: "new-1" });
		new FileSessionStore(legacyDir).save(key(), { threadId: "legacy-1" });
		expect(new FileSessionStore(newDir, legacyDir).load(key())).toEqual({ threadId: "new-1" });
	});

	test("the legacy fallback is per-entry, so a multi-participant scope keeps legacy-only entries", () => {
		const newDir = join(TMPDIR, "new");
		const legacyDir = join(TMPDIR, "legacy");
		const a = key({ participantId: "alice", fingerprint: "fp-a" });
		const b = key({ participantId: "bob", fingerprint: "fp-b" });
		// Both participants are in legacy; only alice has been re-saved to new.
		new FileSessionStore(legacyDir).save(a, { id: "a-legacy" });
		new FileSessionStore(legacyDir).save(b, { id: "b-legacy" });
		const store = new FileSessionStore(newDir, legacyDir);
		store.save(a, { id: "a-new" });
		expect(store.load(a)).toEqual({ id: "a-new" }); // new
		expect(store.load(b)).toEqual({ id: "b-legacy" }); // still resolved from legacy
	});
});
