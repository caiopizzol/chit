import type { NormalizedAgent } from "@chit-run/core";
import type { RuntimeAdapter } from "../runtime/types.ts";
import { ClaudeCliAdapter } from "./claude-cli.ts";
import { CodexExecAdapter } from "./codex-exec.ts";

export class AdapterError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AdapterError";
	}
}

export function buildAdapter(agent: NormalizedAgent): RuntimeAdapter {
	switch (agent.adapter) {
		case "codex-exec":
			return new CodexExecAdapter({
				model: agent.model,
				reasoningEffort: agent.reasoningEffort,
				env: agent.env,
				callTimeoutMs: agent.callTimeoutMs,
				noProgressTimeoutMs: agent.noProgressTimeoutMs,
			});
		case "claude-cli":
			return new ClaudeCliAdapter({
				model: agent.model,
				reasoningEffort: agent.reasoningEffort,
				passModelOnResume: agent.passModelOnResume,
				env: agent.env,
				strictMcp: agent.strictMcp,
				callTimeoutMs: agent.callTimeoutMs,
				noProgressTimeoutMs: agent.noProgressTimeoutMs,
			});
		default: {
			const exhaustive: never = agent.adapter;
			throw new AdapterError(`unknown adapter kind: ${exhaustive as string}`);
		}
	}
}
