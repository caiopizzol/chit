import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLock, LockError, ownsLock, releaseLock, withFileLock } from "./lock.ts";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "chit-lock-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("file lock", () => {
	test("acquire creates the lock with a token; release removes it", () => {
		const p = join(dir, "a.lock");
		const lock = acquireLock(p);
		expect(existsSync(p)).toBe(true);
		expect(readFileSync(p, "utf-8")).toBe(lock.token);
		expect(ownsLock(lock)).toBe(true);
		releaseLock(lock);
		expect(existsSync(p)).toBe(false);
		expect(ownsLock(lock)).toBe(false);
	});

	test("a second acquire on a held lock fails loudly after the retry window", () => {
		const p = join(dir, "b.lock");
		const held = acquireLock(p);
		expect(() => acquireLock(p, { retryMs: 1, maxAttempts: 2 })).toThrow(LockError);
		releaseLock(held);
		// once released, it can be acquired again
		const again = acquireLock(p, { retryMs: 1, maxAttempts: 2 });
		expect(ownsLock(again)).toBe(true);
		releaseLock(again);
	});

	test("release only removes a lock we still own (external re-acquire is left intact)", () => {
		const p = join(dir, "c.lock");
		const mine = acquireLock(p);
		// Another process reclaims it (overwrites with a different token).
		writeFileSync(p, "someone-elses-token");
		releaseLock(mine); // must NOT delete the other holder's lock
		expect(existsSync(p)).toBe(true);
		expect(readFileSync(p, "utf-8")).toBe("someone-elses-token");
	});

	test("withFileLock runs fn and releases even on throw", () => {
		const p = join(dir, "d.lock");
		expect(() =>
			withFileLock(p, () => {
				expect(existsSync(p)).toBe(true);
				throw new Error("boom");
			}),
		).toThrow("boom");
		expect(existsSync(p)).toBe(false);
	});
});
