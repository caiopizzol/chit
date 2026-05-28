import { describe, expect, test } from "bun:test";
import type { NormalizedAgent, NormalizedParticipant } from "@chit/core";
import { computeFingerprint } from "./fingerprint.ts";

function agent(overrides: Partial<NormalizedAgent> = {}): NormalizedAgent {
	return {
		id: "codex",
		adapter: "codex-exec",
		model: "gpt-5.3-codex",
		passModelOnResume: false,
		builtIn: true,
		...overrides,
	};
}

function participant(overrides: Partial<NormalizedParticipant> = {}): NormalizedParticipant {
	return {
		agent: "codex",
		role: "advisor",
		session: "per_scope",
		permissions: { filesystem: "read_only" },
		...overrides,
	};
}

describe("computeFingerprint", () => {
	test("same inputs produce the same fingerprint", () => {
		const a = computeFingerprint({ agent: agent(), participant: participant() });
		const b = computeFingerprint({ agent: agent(), participant: participant() });
		expect(a).toBe(b);
	});

	test("different model produces different fingerprint", () => {
		const a = computeFingerprint({ agent: agent({ model: "gpt-5" }), participant: participant() });
		const b = computeFingerprint({ agent: agent({ model: "gpt-4" }), participant: participant() });
		expect(a).not.toBe(b);
	});

	test("different role produces different fingerprint", () => {
		const a = computeFingerprint({
			agent: agent(),
			participant: participant({ role: "diagnose root cause" }),
		});
		const b = computeFingerprint({
			agent: agent(),
			participant: participant({ role: "verify claims" }),
		});
		expect(a).not.toBe(b);
	});

	test("different permissions produce different fingerprint", () => {
		const a = computeFingerprint({
			agent: agent(),
			participant: participant({ permissions: { filesystem: "read_only" } }),
		});
		const b = computeFingerprint({
			agent: agent(),
			participant: participant({ permissions: { filesystem: "write" } }),
		});
		expect(a).not.toBe(b);
	});

	test("different base URL in env produces different fingerprint", () => {
		const a = computeFingerprint({
			agent: agent({ env: { ANTHROPIC_BASE_URL: "https://api.anthropic.com" } }),
			participant: participant(),
		});
		const b = computeFingerprint({
			agent: agent({ env: { ANTHROPIC_BASE_URL: "http://localhost:11434" } }),
			participant: participant(),
		});
		expect(a).not.toBe(b);
	});

	test("different passModelOnResume produces different fingerprint", () => {
		const a = computeFingerprint({
			agent: agent({ passModelOnResume: false }),
			participant: participant(),
		});
		const b = computeFingerprint({
			agent: agent({ passModelOnResume: true }),
			participant: participant(),
		});
		expect(a).not.toBe(b);
	});

	test("sensitive env values do not affect fingerprint", () => {
		const a = computeFingerprint({
			agent: agent({ env: { ANTHROPIC_AUTH_TOKEN: "secret-1" } }),
			participant: participant(),
		});
		const b = computeFingerprint({
			agent: agent({ env: { ANTHROPIC_AUTH_TOKEN: "secret-2" } }),
			participant: participant(),
		});
		expect(a).toBe(b);
	});

	test("fingerprint is a stable short hex string", () => {
		const fp = computeFingerprint({ agent: agent(), participant: participant() });
		expect(fp).toMatch(/^[0-9a-f]{16}$/);
	});

	test("different agent.id produces different fingerprint even with same config", () => {
		const a = computeFingerprint({ agent: agent({ id: "codex" }), participant: participant() });
		const b = computeFingerprint({
			agent: agent({ id: "codex-fast" }),
			participant: participant(),
		});
		expect(a).not.toBe(b);
	});
});
