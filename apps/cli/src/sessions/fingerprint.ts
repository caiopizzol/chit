import { createHash } from "node:crypto";
import type { NormalizedAgent, NormalizedParticipant } from "@chit/core";

export interface FingerprintInput {
	agent: NormalizedAgent;
	participant: NormalizedParticipant;
}

// Inputs that, when changed, mean a resumed session no longer matches what
// the participant declared. A mismatch means we start fresh instead of
// resuming a session belonging to a previous configuration.
//
// We deliberately do NOT include sensitive env values (API keys/tokens).
// Only the base URL is included because changing endpoints is a meaningful
// boundary change. Adapter-specific resume policies (e.g., passModelOnResume)
// are included so toggling them invalidates prior sessions.
export function computeFingerprint(input: FingerprintInput): string {
	const { agent, participant } = input;
	const baseUrl =
		agent.env?.ANTHROPIC_BASE_URL ?? agent.env?.OPENAI_BASE_URL ?? agent.env?.OLLAMA_HOST ?? "";

	const material = JSON.stringify({
		// agentId is included so switching a participant from one agent to
		// another (e.g., "codex" -> "codex-fast") invalidates the session,
		// even if the two agents happen to share adapter/model/etc.
		agentId: agent.id,
		adapter: agent.adapter,
		model: agent.model ?? null,
		// reasoningEffort affects BOTH adapters (codex: model_reasoning_effort;
		// claude: --effort), so it hashes unconditionally: changing effort forks the
		// session on either.
		reasoningEffort: agent.reasoningEffort ?? null,
		// Hash EFFECTIVE behavior, not raw config. passModelOnResume only changes
		// claude-cli's resume behavior; on other adapters it has no runtime effect, so
		// it hashes as null there (a codex agent toggling it must not spuriously fork).
		passModelOnResume: agent.adapter === "claude-cli" ? agent.passModelOnResume : null,
		// Same rule for strictMcp: for claude-cli, undefined and true both mean
		// strict-on, so only an explicit false differs (no spurious fork); on other
		// adapters strictMcp has no runtime effect, so it hashes as null.
		strictMcp: agent.adapter === "claude-cli" ? agent.strictMcp !== false : null,
		baseUrl,
		role: participant.role,
		session: participant.session,
		permissions: participant.permissions,
	});

	return createHash("sha256").update(material).digest("hex").slice(0, 16);
}
