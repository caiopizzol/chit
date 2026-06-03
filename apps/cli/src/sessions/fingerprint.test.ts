import { describe, expect, test } from "bun:test";
import type { NormalizedAgent, NormalizedParticipant } from "@chit-run/core";
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
		instructions: "advisor",
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
			participant: participant({ instructions: "diagnose root cause" }),
		});
		const b = computeFingerprint({
			agent: agent(),
			participant: participant({ instructions: "verify claims" }),
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

	test("codex-exec: write and read_only fork (effective sandbox differs)", () => {
		// codex-exec runs --sandbox workspace-write for a write participant and
		// --sandbox read-only otherwise; the fingerprint hashes that effective
		// sandbox so a write session can never resume under a read-only sandbox.
		const write = computeFingerprint({
			agent: agent({ adapter: "codex-exec" }),
			participant: participant({ permissions: { filesystem: "write" } }),
		});
		const readOnly = computeFingerprint({
			agent: agent({ adapter: "codex-exec" }),
			participant: participant({ permissions: { filesystem: "read_only" } }),
		});
		expect(write).not.toBe(readOnly);
	});

	test("non-codex material is unchanged: introducing the codex sandbox field must not fork claude sessions", () => {
		// The codex sandbox key is OMITTED for non-codex adapters, so a claude-cli
		// fingerprint is byte-identical to what it was before the field existed. This
		// golden hash is pinned to a fully-explicit claude-cli config (not the shared
		// fixtures) and matches the pre-field release's hash for the same input. If a
		// future change shifts non-codex material, this breaks loudly -- which is the
		// point: every existing claude per-scope session would otherwise be forced to
		// start fresh on upgrade.
		const fp = computeFingerprint({
			agent: {
				id: "claude",
				adapter: "claude-cli",
				model: "claude-opus-4-8",
				passModelOnResume: false,
				strictMcp: true,
				builtIn: true,
			},
			participant: {
				agent: "claude",
				instructions: "implementer",
				session: "per_scope",
				permissions: { filesystem: "read_only" },
			},
		});
		expect(fp).toBe("03eb60d957a7d9db");
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
