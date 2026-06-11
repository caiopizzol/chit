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
		processBootPayload({ token: "abc123" }, storage);
		expect(storage.getItem(TOKEN_STORAGE_KEY)).toBe("abc123");
	});

	test("overwrites a stale token on a second boot", () => {
		const storage = new MemoryStorage();
		processBootPayload({ token: "old" }, storage);
		processBootPayload({ token: "new" }, storage);
		expect(storage.getItem(TOKEN_STORAGE_KEY)).toBe("new");
	});
});
