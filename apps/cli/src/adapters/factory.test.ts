import { describe, expect, test } from "bun:test";
import type { NormalizedAgent } from "@chit/core";
import { ClaudeCliAdapter } from "./claude-cli.ts";
import { CodexExecAdapter } from "./codex-exec.ts";
import { buildAdapter } from "./factory.ts";

function agent(
	overrides: Partial<NormalizedAgent> & { adapter: NormalizedAgent["adapter"] },
): NormalizedAgent {
	return {
		id: "test",
		passModelOnResume: false,
		builtIn: false,
		...overrides,
	};
}

describe("buildAdapter", () => {
	test("constructs a CodexExecAdapter for codex-exec agents", () => {
		const adapter = buildAdapter(agent({ adapter: "codex-exec", model: "gpt-5.3-codex" }));
		expect(adapter).toBeInstanceOf(CodexExecAdapter);
	});

	test("constructs a ClaudeCliAdapter for claude-cli agents", () => {
		const adapter = buildAdapter(agent({ adapter: "claude-cli", id: "claude", model: "opus" }));
		expect(adapter).toBeInstanceOf(ClaudeCliAdapter);
	});

	test("forwards agent.strictMcp into the ClaudeCliAdapter config", () => {
		const adapter = buildAdapter(
			agent({ adapter: "claude-cli", id: "needs-mcp", strictMcp: false }),
		);
		// strictMcp must reach ClaudeCliConfig so the opt-out is reachable from
		// real user config, not just the adapter constructor.
		const config = (adapter as unknown as { config: { strictMcp?: boolean } }).config;
		expect(config.strictMcp).toBe(false);
	});

	test("forwards agent.callTimeoutMs into the CodexExecAdapter config", () => {
		const adapter = buildAdapter(agent({ adapter: "codex-exec", callTimeoutMs: 1234 }));
		const config = (adapter as unknown as { config: { callTimeoutMs?: number } }).config;
		expect(config.callTimeoutMs).toBe(1234);
	});

	test("forwards agent.callTimeoutMs into the ClaudeCliAdapter config", () => {
		const adapter = buildAdapter(
			agent({ adapter: "claude-cli", id: "claude", callTimeoutMs: 5678 }),
		);
		const config = (adapter as unknown as { config: { callTimeoutMs?: number } }).config;
		expect(config.callTimeoutMs).toBe(5678);
	});

	test("forwards agent.reasoningEffort into the ClaudeCliAdapter config", () => {
		// Without this mapping, effort set on a claude agent in the registry would be
		// silently dropped (the footgun this slice fixes); the adapter then turns it
		// into --effort.
		const adapter = buildAdapter(
			agent({ adapter: "claude-cli", id: "claude", reasoningEffort: "high" }),
		);
		const config = (adapter as unknown as { config: { reasoningEffort?: string } }).config;
		expect(config.reasoningEffort).toBe("high");
	});

	test("forwards agent.noProgressTimeoutMs into both adapter configs", () => {
		// Without this the no-progress watchdog would be unreachable from agents.json
		// (the registry accepts it, but it must reach the adapter to take effect).
		const codex = buildAdapter(agent({ adapter: "codex-exec", noProgressTimeoutMs: 90000 }));
		expect(
			(codex as unknown as { config: { noProgressTimeoutMs?: number } }).config.noProgressTimeoutMs,
		).toBe(90000);
		const claude = buildAdapter(
			agent({ adapter: "claude-cli", id: "claude", noProgressTimeoutMs: 90000 }),
		);
		expect(
			(claude as unknown as { config: { noProgressTimeoutMs?: number } }).config
				.noProgressTimeoutMs,
		).toBe(90000);
	});
});
