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

	test("different passModelOnResume forks the fingerprint on claude-cli", () => {
		const a = computeFingerprint({
			agent: agent({ adapter: "claude-cli", passModelOnResume: false }),
			participant: participant(),
		});
		const b = computeFingerprint({
			agent: agent({ adapter: "claude-cli", passModelOnResume: true }),
			participant: participant(),
		});
		expect(a).not.toBe(b);
	});

	test("passModelOnResume has no fingerprint effect on a non-claude-cli adapter", () => {
		// It only changes claude-cli's resume behavior, so toggling it on a codex
		// agent must not spuriously fork the session.
		const a = computeFingerprint({
			agent: agent({ adapter: "codex-exec", passModelOnResume: false }),
			participant: participant(),
		});
		const b = computeFingerprint({
			agent: agent({ adapter: "codex-exec", passModelOnResume: true }),
			participant: participant(),
		});
		expect(a).toBe(b);
	});

	test("different reasoningEffort forks the fingerprint (effective on both adapters)", () => {
		// codex maps it to model_reasoning_effort, claude to --effort, so changing it
		// is a real behavior change on either adapter and must fork the session.
		const claudeLow = computeFingerprint({
			agent: agent({ adapter: "claude-cli", reasoningEffort: "low" }),
			participant: participant(),
		});
		const claudeHigh = computeFingerprint({
			agent: agent({ adapter: "claude-cli", reasoningEffort: "high" }),
			participant: participant(),
		});
		expect(claudeLow).not.toBe(claudeHigh);
		const codexLow = computeFingerprint({
			agent: agent({ adapter: "codex-exec", reasoningEffort: "low" }),
			participant: participant(),
		});
		const codexHigh = computeFingerprint({
			agent: agent({ adapter: "codex-exec", reasoningEffort: "high" }),
			participant: participant(),
		});
		expect(codexLow).not.toBe(codexHigh);
	});

	test("strictMcp undefined and true hash the same (both strict-on)", () => {
		const a = computeFingerprint({
			agent: agent({ adapter: "claude-cli", strictMcp: undefined }),
			participant: participant(),
		});
		const b = computeFingerprint({
			agent: agent({ adapter: "claude-cli", strictMcp: true }),
			participant: participant(),
		});
		expect(a).toBe(b);
	});

	test("strictMcp:false produces a different fingerprint (opt-out forks)", () => {
		const a = computeFingerprint({
			agent: agent({ adapter: "claude-cli", strictMcp: true }),
			participant: participant(),
		});
		const b = computeFingerprint({
			agent: agent({ adapter: "claude-cli", strictMcp: false }),
			participant: participant(),
		});
		expect(a).not.toBe(b);
	});

	test("strictMcp has no fingerprint effect on a non-claude-cli adapter", () => {
		const a = computeFingerprint({
			agent: agent({ adapter: "codex-exec", strictMcp: true }),
			participant: participant(),
		});
		const b = computeFingerprint({
			agent: agent({ adapter: "codex-exec", strictMcp: false }),
			participant: participant(),
		});
		expect(a).toBe(b);
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
