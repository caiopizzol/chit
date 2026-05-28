// processBootPayload is the pure half of the boot flow. The runtime
// consumeBoot wraps it with window/sessionStorage; that wrapper is exercised
// by the live verification, not unit tests.

import { describe, expect, test } from "bun:test";
import { processBootPayload, TOKEN_STORAGE_KEY, type TokenStorage } from "./boot.ts";

class MemoryStorage implements TokenStorage {
	store = new Map<string, string>();
	setItem(k: string, v: string) {
		this.store.set(k, v);
	}
	getItem(k: string) {
		return this.store.get(k) ?? null;
	}
}

describe("processBootPayload", () => {
	test("stores the token under the expected key", () => {
		const storage = new MemoryStorage();
		processBootPayload({ token: "abc123", bootstrap: { mode: "empty" } }, storage);
		expect(storage.getItem(TOKEN_STORAGE_KEY)).toBe("abc123");
	});

	test("returns the bootstrap unchanged", () => {
		const storage = new MemoryStorage();
		const bootstrap = { mode: "empty" } as const;
		const result = processBootPayload({ token: "t", bootstrap }, storage);
		expect(result).toBe(bootstrap);
	});

	test("overwrites a stale token on a second boot", () => {
		const storage = new MemoryStorage();
		processBootPayload({ token: "old", bootstrap: { mode: "empty" } }, storage);
		processBootPayload({ token: "new", bootstrap: { mode: "empty" } }, storage);
		expect(storage.getItem(TOKEN_STORAGE_KEY)).toBe("new");
	});
});
