export type AdapterKind = "codex-exec" | "claude-cli";

export interface AdapterCapability {
	enforces_filesystem_read_only: boolean;
}

export interface AdapterDescriptor {
	kind: AdapterKind;
	capabilities: AdapterCapability;
}

export interface NormalizedAgent {
	id: string;
	adapter: AdapterKind;
	model?: string;
	reasoningEffort?: string;
	passModelOnResume: boolean;
	description?: string;
	env?: Record<string, string>;
	// Strict MCP isolation for the claude-cli adapter. Undefined means "use the
	// adapter default" (on); set false to let an advisor that needs MCP opt out.
	strictMcp?: boolean;
	// Hard per-call timeout in ms for the adapter (positive integer). Undefined
	// means "use the adapter default" (15 min). Execution governance, not session
	// identity, so it is NOT part of the session fingerprint.
	callTimeoutMs?: number;
	// No-progress watchdog in ms (positive integer): kill the child if no stdout
	// arrives for this long, catching a wedged session before the hard timeout.
	// Undefined means off. Execution governance, NOT part of the fingerprint.
	noProgressTimeoutMs?: number;
	builtIn: boolean;
}

export interface NormalizedRegistry {
	agents: Record<string, NormalizedAgent>;
	configPath?: string;
}

// The effective agent config resolved for a participant, for display and audit.
// An undefined field means the adapter / CLI default applies (e.g. no model
// pinned). strictMcp and passModelOnResume are only meaningful for claude-cli and
// are omitted for other adapters. env is REDACTED to its key names only; values
// never appear here. Lives here (not in graph-model) so the audit schema can
// reuse it without depending on the graph renderer.
export interface ParticipantConfig {
	model?: string;
	reasoningEffort?: string;
	strictMcp?: boolean;
	passModelOnResume?: boolean;
	callTimeoutMs?: number;
	noProgressTimeoutMs?: number;
	envKeys?: string[];
}
