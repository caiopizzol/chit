import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
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

// The single session .json file in a base dir, guarded so a missing file fails
// loudly instead of producing an undefined path.
function onlyJsonFile(dir: string): string {
	const file = readdirSync(dir).find((f) => f.endsWith(".json"));
	if (!file) throw new Error("expected a session .json file");
	return join(dir, file);
}

const STORE_PATH = join(import.meta.dir, "store.ts");

let TMPDIR: string;
let store: FileSessionStore;

beforeEach(() => {
	TMPDIR = mkdtempSync(join(tmpdir(), "chit-store-"));
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

	test("sibling entries survive concurrent cross-process saves released from a barrier", async () => {
		// Real overlap needs separate OS processes (save() is synchronous, so two
		// calls in one thread never interleave) AND a start barrier, so the children
		// genuinely contend instead of happening to run one after another. Each child
		// parks until a `go` file appears, then all race to save a distinct
		// participant into the SAME (scope, manifestId) file. With the per-file lock
		// holding the whole read-modify-write every entry survives; a plain
		// read-modify-write would drop some (lost update).
		const childPath = join(TMPDIR, "concurrent-saver.ts");
		writeFileSync(
			childPath,
			`import { existsSync, writeFileSync } from "node:fs";
import { FileSessionStore } from ${JSON.stringify(STORE_PATH)};
const [dir, participantId, readyDir, goFile] = process.argv.slice(2);
writeFileSync(\`\${readyDir}/\${participantId}\`, "");
const spin = new Int32Array(new SharedArrayBuffer(4));
while (!existsSync(goFile)) Atomics.wait(spin, 0, 0, 1);
new FileSessionStore(dir, { lockRetryMs: 5, lockMaxAttempts: 4000 }).save(
	{ scope: "concurrent", manifestId: "shared", participantId, fingerprint: "fp" },
	{ id: participantId },
);
`,
		);

		const readyDir = join(TMPDIR, "ready");
		mkdirSync(readyDir);
		const goFile = join(TMPDIR, "go");
		const N = 8;
		const procs = Array.from({ length: N }, (_, i) =>
			Bun.spawn(["bun", childPath, TMPDIR, `p${i}`, readyDir, goFile], {
				stdout: "ignore",
				stderr: "pipe",
			}),
		);

		// Hold the start line until every child is parked at the barrier, then drop
		// the flag so they all wake and contend at once.
		while (readdirSync(readyDir).length < N) await Bun.sleep(5);
		writeFileSync(goFile, "");

		await Promise.all(procs.map((p) => p.exited));
		for (const p of procs) expect(p.exitCode).toBe(0);

		const probe = new FileSessionStore(TMPDIR);
		for (let i = 0; i < N; i++) {
			expect(
				probe.load({
					scope: "concurrent",
					manifestId: "shared",
					participantId: `p${i}`,
					fingerprint: "fp",
				}),
			).toEqual({ id: `p${i}` });
		}
	});

	test("an in-flight save already retrying succeeds once the held lock is released", async () => {
		// Prove the blocked saver is mid-retry when the lock drops, not merely that a
		// fresh save works afterward. A child enters save() against a lock we hold;
		// it must spin in the retry loop. We release only after it is provably
		// blocked, and it then completes and merges with the existing entry.
		const childPath = join(TMPDIR, "blocked-saver.ts");
		writeFileSync(
			childPath,
			`import { writeFileSync } from "node:fs";
import { FileSessionStore } from ${JSON.stringify(STORE_PATH)};
const [dir, startedFile] = process.argv.slice(2);
writeFileSync(startedFile, "");
new FileSessionStore(dir, { lockRetryMs: 5, lockMaxAttempts: 4000 }).save(
	{ scope: "test-scope", manifestId: "test-manifest", participantId: "blocked", fingerprint: "fp1" },
	{ id: "blocked" },
);
`,
		);

		// Seed a sibling so there is a file to lock and an entry the merge must keep.
		store.save(key(), { id: "base" });
		const lockPath = `${onlyJsonFile(TMPDIR)}.lock`;
		// Hold the lock. With no auto-reclaim by age, the child cannot take it; it
		// must block and retry until we remove it.
		writeFileSync(lockPath, "holder-token");

		const startedFile = join(TMPDIR, "started");
		const child = Bun.spawn(["bun", childPath, TMPDIR, startedFile], {
			stdout: "ignore",
			stderr: "pipe",
		});

		// Wait until the child has entered save() (so it is now spinning on our lock),
		// then let it churn through several retry intervals while still blocked.
		while (!existsSync(startedFile)) await Bun.sleep(2);
		await Bun.sleep(60);
		// Still blocked: it has written nothing.
		expect(store.load(key({ participantId: "blocked" }))).toBeUndefined();

		// Release; the already-retrying child acquires on its next attempt.
		rmSync(lockPath, { force: true });
		await child.exited;
		expect(child.exitCode).toBe(0);
		expect(store.load(key({ participantId: "blocked" }))).toEqual({ id: "blocked" });
		expect(store.load(key())).toEqual({ id: "base" });
	});

	test("a held non-stale lock makes a competing save throw without clobbering or deleting it", () => {
		// Tight budget so the blocked save gives up quickly and deterministically.
		const s = new FileSessionStore(TMPDIR, {
			lockRetryMs: 1,
			lockMaxAttempts: 3,
		});
		s.save(key(), { id: "base" });
		const lockPath = `${onlyJsonFile(TMPDIR)}.lock`;

		// A live holder owns the lock with its own token.
		writeFileSync(lockPath, "foreign-token");
		expect(() => s.save(key({ participantId: "other" }), { id: "other" })).toThrow(
			/could not acquire lock/,
		);
		// The blocked save wrote nothing: the base entry is untouched.
		expect(s.load(key())).toEqual({ id: "base" });
		expect(s.load(key({ participantId: "other" }))).toBeUndefined();
		// We never owned the lock, so we must not have deleted it (ownership-gated
		// release): the foreign holder's lock and token are intact.
		expect(existsSync(lockPath)).toBe(true);
		expect(readFileSync(lockPath, "utf-8")).toBe("foreign-token");
	});

	test("an abandoned lock is never auto-reclaimed by age: save fails loud, lock intact", () => {
		// There is no staleness/auto-reclaim by design (deciding a lock is stale and
		// deleting it is itself a lost-update race). Even an hour-old lock is NOT
		// silently removed: a competing save fails loudly with actionable guidance,
		// and the planted lock and existing data are left untouched for the operator.
		const s = new FileSessionStore(TMPDIR, { lockRetryMs: 1, lockMaxAttempts: 3 });
		s.save(key(), { id: "base" });
		const lockPath = `${onlyJsonFile(TMPDIR)}.lock`;

		// Plant a crashed holder's lock and backdate it an hour. Age must NOT matter.
		// Backdating via utimesSync keeps the test off the wall clock.
		writeFileSync(lockPath, "crashed-holder-token");
		const old = new Date(Date.now() - 3_600_000);
		utimesSync(lockPath, old, old);

		expect(() => s.save(key({ participantId: "after" }), { id: "after" })).toThrow(
			/could not acquire lock[\s\S]*remove the lock file/,
		);
		// Not reclaimed and not clobbered: the lock and its token survive, base is
		// intact, and the failed save wrote nothing.
		expect(existsSync(lockPath)).toBe(true);
		expect(readFileSync(lockPath, "utf-8")).toBe("crashed-holder-token");
		expect(s.load(key())).toEqual({ id: "base" });
		expect(s.load(key({ participantId: "after" }))).toBeUndefined();
	});

	test("a successful save leaves no tmp or lock sidecars", () => {
		store.save(key(), { id: "x" });
		store.save(key({ participantId: "y", fingerprint: "fp-y" }), { id: "y" });
		const files = readdirSync(TMPDIR);
		expect(files.some((f) => f.endsWith(".tmp"))).toBe(false);
		expect(files.some((f) => f.endsWith(".lock"))).toBe(false);
		expect(files.filter((f) => f.endsWith(".json")).length).toBe(1);
	});

	test("stray tmp sidecars are never read as session files", () => {
		store.save(key(), { id: "real" });
		const file = onlyJsonFile(TMPDIR);
		// A leftover temp file from an interrupted write, sitting next to the real
		// session file. load is addressed to the .json file, so the .tmp is ignored.
		writeFileSync(`${file}.orphan.tmp`, "{ partial not json");
		expect(store.load(key())).toEqual({ id: "real" });
		expect(existsSync(`${file}.orphan.tmp`)).toBe(true);
	});

	test("load returns undefined for corrupt JSON (tolerant behavior preserved)", () => {
		store.save(key(), { id: "ok" });
		writeFileSync(onlyJsonFile(TMPDIR), "{ this is not valid json");
		expect(store.load(key())).toBeUndefined();
	});
});
