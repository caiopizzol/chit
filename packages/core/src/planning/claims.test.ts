import { describe, expect, test } from "bun:test";
import { ClaimError, normalizeClaimedPath } from "./claims.ts";

// The one shared claim normalizer used by both the batch planner and the draft
// compiler. These pin the canonical form and the rejections; the CLI batch tests
// (apps/cli/src/batches/plan.test.ts) and the draft compiler tests both depend on
// this exact behavior, so it lives here as the single source of truth.

describe("normalizeClaimedPath", () => {
	test("canonicalizes ./, //, and trailing markers", () => {
		expect(normalizeClaimedPath("./src//x.ts")).toBe("src/x.ts");
		expect(normalizeClaimedPath("src/**")).toBe("src/**");
		expect(normalizeClaimedPath("src//")).toBe("src/");
		expect(normalizeClaimedPath("a/./b/**")).toBe("a/b/**");
	});

	test("rejects absolute paths", () => {
		expect(() => normalizeClaimedPath("/etc/passwd")).toThrow(ClaimError);
		expect(() => normalizeClaimedPath("/etc/passwd")).toThrow(/repo-relative/);
	});

	test("rejects .. traversal", () => {
		expect(() => normalizeClaimedPath("../escape")).toThrow(/\.\./);
		expect(() => normalizeClaimedPath("a/../../b")).toThrow(/\.\./);
	});

	test("rejects empty and whitespace-only claims", () => {
		expect(() => normalizeClaimedPath("")).toThrow(/empty/);
		expect(() => normalizeClaimedPath("   ")).toThrow(/empty/);
		expect(() => normalizeClaimedPath("./")).toThrow(/empty/);
	});
});
