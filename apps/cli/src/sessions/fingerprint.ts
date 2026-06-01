import { createHash } from "node:crypto";
import type { NormalizedAgent, NormalizedParticipant } from "@chit-run/core";

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
		// The OS sandbox codex-exec runs under is derived from the participant's
		// filesystem permission (write -> workspace-write, else read-only) on the
		// FRESH call; a resume omits --sandbox and inherits whatever the original
		// call established. Hash that effective sandbox so a session never resumes
		// under a sandbox that no longer matches the declared permission -- in
		// particular, a codex `write` session created before write was honored (when
		// codex always ran read-only) must not resume read-only now. The key is
		// OMITTED for non-codex adapters (not hashed as null) so introducing it does
		// not shift their material and spuriously fork existing claude sessions.
		...(agent.adapter === "codex-exec" && {
			codexSandbox:
				participant.permissions.filesystem === "write" ? "workspace-write" : "read-only",
		}),
		baseUrl,
		role: participant.role,
		session: participant.session,
		permissions: participant.permissions,
	});

	return createHash("sha256").update(material).digest("hex").slice(0, 16);
}
