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
});
