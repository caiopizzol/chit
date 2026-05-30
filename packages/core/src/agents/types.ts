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
	builtIn: boolean;
}

export interface NormalizedRegistry {
	agents: Record<string, NormalizedAgent>;
	configPath?: string;
}
