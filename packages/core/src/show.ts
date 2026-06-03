import type { ParticipantConfig } from "./agents/types.ts";
import type { GraphEdge, GraphModel, GraphNode } from "./graph-model.ts";
import { validationSeverity } from "./graph-model.ts";
import type { FilesystemPermission } from "./manifest/types.ts";

export type ShowFormat = "json" | "ascii" | "mermaid" | "html";

export interface ParticipantPermissionDisplay {
	filesystem: FilesystemPermission;
	readOnlyEnforcement: string;
	readOnlyEnforcementClass: "info" | "ok" | "warn";
}

export function participantPermissionDisplay(p: {
	permissions: { filesystem: FilesystemPermission };
	enforcesReadOnly: boolean;
}): ParticipantPermissionDisplay {
	if (p.permissions.filesystem === "read_only") {
		return {
			filesystem: "read_only",
			readOnlyEnforcement: p.enforcesReadOnly ? "enforced" : "NOT ENFORCED",
			readOnlyEnforcementClass: p.enforcesReadOnly ? "ok" : "warn",
		};
	}
	return {
		filesystem: "write",
		readOnlyEnforcement: p.enforcesReadOnly
			? "not requested (adapter supports)"
			: "not requested (adapter cannot enforce)",
		readOnlyEnforcementClass: "info",
	};
}

export function participantPermissionText(p: {
	permissions: { filesystem: FilesystemPermission };
	enforcesReadOnly: boolean;
}): string {
	const display = participantPermissionDisplay(p);
	return `filesystem=${display.filesystem}  read_only_enforcement=${display.readOnlyEnforcement}`;
}

// Effective participant config as ordered label/value pairs, shared by the ASCII
// and HTML renderers so the two never drift. "default" means the adapter/CLI
// default applies; "off" means the no-progress watchdog is disabled. strictMcp
// and passModelOnResume appear only when set (claude-cli). env shows redacted key
// names only.
export function configPairs(c: ParticipantConfig): Array<[string, string]> {
	const pairs: Array<[string, string]> = [
		["model", c.model ?? "default"],
		["effort", c.reasoningEffort ?? "default"],
		["callTimeout", c.callTimeoutMs !== undefined ? `${c.callTimeoutMs}ms` : "default"],
		["noProgress", c.noProgressTimeoutMs !== undefined ? `${c.noProgressTimeoutMs}ms` : "off"],
	];
	if (c.strictMcp !== undefined) pairs.push(["strictMcp", c.strictMcp ? "on" : "off"]);
	if (c.passModelOnResume !== undefined) {
		pairs.push(["passModelOnResume", c.passModelOnResume ? "yes" : "no"]);
	}
	if (c.envKeys && c.envKeys.length > 0) pairs.push(["env", `[${c.envKeys.join(", ")}]`]);
	return pairs;
}

export function renderShow(model: GraphModel, format: ShowFormat): string {
	switch (format) {
		case "json":
			return `${JSON.stringify(model, null, 2)}\n`;
		case "ascii":
			return renderAscii(model);
		case "mermaid":
			return renderMermaid(model);
		case "html":
			return renderHtml(model);
		default: {
			const exhaustive: never = format;
			throw new Error(`unknown format: ${exhaustive as string}`);
		}
	}
}

// ─── ASCII ───────────────────────────────────────────────────────────────

function renderAscii(m: GraphModel): string {
	const out: string[] = [];
	out.push(`manifest: ${m.manifest.id}`);
	out.push(`  ${m.manifest.description}`);
	out.push("");

	if (m.surface && m.validation) {
		out.push(`surface: ${m.surface.kind}`);
		const capOk = m.validation.capabilities.compatible ? "COMPATIBLE" : "INCOMPATIBLE";
		out.push(`  capabilities: ${capOk}`);
		for (const cap of m.validation.capabilities.missing) {
			out.push(`    - missing: ${cap}`);
		}
		const agentsLabel = m.validation.agents.resolved ? "RESOLVED" : "UNKNOWN AGENTS";
		out.push(`  agents:       ${agentsLabel}`);
		for (const u of m.validation.agents.unknown) {
			out.push(`    - participant "${u.participantId}" references unknown agent "${u.agentId}"`);
		}
		const permLabel = {
			ok: "OK",
			needs_override: "NEEDS OVERRIDE",
			blocked: "BLOCKED",
		}[m.validation.permissions.status];
		out.push(`  permissions:  ${permLabel}`);
		for (const gap of m.validation.permissions.gaps) {
			out.push(
				`    - participant "${gap.participantId}" requires ${gap.permission}; adapter "${m.participants[gap.participantId]?.adapter ?? gap.agentId}" cannot enforce`,
			);
		}
		if (m.surface.notes.length > 0) {
			out.push("  notes:");
			for (const note of m.surface.notes) {
				out.push(`    - ${note}`);
			}
		}
		out.push("");
	}

	out.push("inputs:");
	for (const [name, schema] of Object.entries(m.inputs)) {
		out.push(`  ${name}  ${schema.type}${schema.optional ? "  (optional)" : ""}`);
	}
	out.push("");

	out.push("participants:");
	for (const [pid, p] of Object.entries(m.participants)) {
		out.push(
			`  ${pid}  agent=${p.agentId}  session=${p.session}  ${participantPermissionText(p)}  adapter=${p.adapter}`,
		);
		// An unknown agent has no resolvable config; rendering default/off labels
		// would read like a runnable agent, so say it is unresolved instead.
		if (p.adapter === "unknown") {
			out.push("    config  unresolved (unknown agent)");
		} else {
			out.push(
				`    config  ${configPairs(p.config)
					.map(([k, v]) => `${k}=${v}`)
					.join("  ")}`,
			);
		}
	}
	out.push("");

	out.push("execution:");
	for (let level = 0; level < m.executionOrder.length; level++) {
		const stepIds = m.executionOrder[level] ?? [];
		const tag =
			level === m.executionOrder.length - 1
				? "[final]"
				: stepIds.length > 1
					? "[parallel]"
					: "[step]";
		out.push(`  level ${level}  ${tag}`);
		for (const stepId of stepIds) {
			const node = m.nodes.find((n) => n.id === stepId);
			if (!node) continue;
			if (node.kind === "call") {
				const refs = node.refs.length > 0 ? `  refs: ${node.refs.join(", ")}` : "";
				out.push(`    [call]   ${stepId}  participant=${node.participantId}${refs}`);
			} else if (node.kind === "format") {
				const refs = node.refs.length > 0 ? `  refs: ${node.refs.join(", ")}` : "";
				const tag2 = node.isOutput ? " (output)" : "";
				out.push(`    [format] ${stepId}${tag2}${refs}`);
			}
		}
	}
	out.push("");

	out.push("requires:");
	const declaredList = Object.keys(m.requires.declared).sort();
	const inferredList = Object.keys(m.requires.inferred).sort();
	out.push(`  declared: ${declaredList.length ? declaredList.join(", ") : "(none)"}`);
	out.push(`  inferred: ${inferredList.length ? inferredList.join(", ") : "(none)"}`);

	return `${out.join("\n")}\n`;
}

// ─── Mermaid ─────────────────────────────────────────────────────────────

function renderMermaid(m: GraphModel): string {
	const lines: string[] = ["graph LR"];
	for (const node of m.nodes) {
		lines.push(`  ${mermaidId(node.id)}${mermaidNodeShape(node)}`);
	}
	for (const edge of m.edges) {
		lines.push(`  ${mermaidId(edge.from)} --> ${mermaidId(edge.to)}`);
	}
	return `${lines.join("\n")}\n`;
}

function mermaidId(id: string): string {
	// Mermaid node identifiers must be safe; replace `:` and other punctuation.
	return id.replace(/[^A-Za-z0-9_]/g, "_");
}

function mermaidNodeShape(n: GraphNode): string {
	const safe = (s: string) => s.replace(/"/g, "'");
	if (n.kind === "input") return `[/"input: ${safe(n.inputName)}"/]`;
	if (n.kind === "call") return `["${safe(n.id)}<br/>${safe(n.participantId)}"]`;
	const label = n.isOutput ? `format: ${safe(n.id)} (output)` : `format: ${safe(n.id)}`;
	return `{{"${label}"}}`;
}

// ─── HTML ────────────────────────────────────────────────────────────────

function renderHtml(m: GraphModel): string {
	const validation = m.validation;
	const numLevels = m.executionOrder.length;

	const validationBlock = (() => {
		if (!validation) return "";
		const overall = validationSeverity(validation);
		const capMsg = validation.capabilities.compatible
			? '<strong class="ok">Capabilities OK</strong>'
			: `<strong class="error">Missing capabilities:</strong> ${validation.capabilities.missing.map(escapeHtml).join(", ")}`;
		const agentsMsg = validation.agents.resolved
			? '<strong class="ok">Agents resolved</strong>'
			: `<strong class="error">Unknown agents:</strong> ${validation.agents.unknown.map((u) => `<code>${escapeHtml(u.agentId)}</code>`).join(", ")}`;
		const permStatus = validation.permissions.status;
		const permLabel = permStatus === "ok" ? "Permissions OK" : `Permissions: ${permStatus}`;
		const permClass = permStatus === "ok" ? "ok" : "warn";
		const gaps = validation.permissions.gaps
			.map(
				(g) =>
					`<li>participant <code>${escapeHtml(g.participantId)}</code> requires <code>${escapeHtml(g.permission)}</code>; adapter <code>${escapeHtml(m.participants[g.participantId]?.adapter ?? g.agentId)}</code> cannot enforce</li>`,
			)
			.join("");
		const unknownItems = validation.agents.unknown
			.map(
				(u) =>
					`<li>participant <code>${escapeHtml(u.participantId)}</code> references unknown agent <code>${escapeHtml(u.agentId)}</code></li>`,
			)
			.join("");
		return `<section class="validation ${overall}">
  <div>${capMsg}</div>
  <div>${agentsMsg}</div>
  ${unknownItems ? `<ul>${unknownItems}</ul>` : ""}
  <div><strong class="${permClass}">${escapeHtml(permLabel)}</strong></div>
  ${gaps ? `<ul>${gaps}</ul>` : ""}
</section>`;
	})();

	const inputColumn = renderInputColumn(m);
	const levelColumns: string[] = [];
	for (let level = 0; level < numLevels; level++) {
		levelColumns.push(renderLevelColumn(m, level));
	}

	const participantsSection = Object.entries(m.participants)
		.map(([pid, p]) => {
			const permission = participantPermissionDisplay(p);
			// An unknown agent has no resolvable config; show it as unresolved rather
			// than default/off labels that would read like a runnable agent.
			const configBadges =
				p.adapter === "unknown"
					? '<span class="badge warn">config: unresolved (unknown agent)</span>'
					: configPairs(p.config)
							.map(([k, v]) => `<span class="badge info">${escapeHtml(k)}: ${escapeHtml(v)}</span>`)
							.join("\n    ");
			return `<div class="participant">
  <h3>${escapeHtml(pid)}</h3>
  <div class="participant-meta">
    <span class="badge info">agent: ${escapeHtml(p.agentId)}</span>
    <span class="badge info">adapter: ${escapeHtml(p.adapter)}</span>
    <span class="badge info">session: ${escapeHtml(p.session)}</span>
    <span class="badge info">filesystem: ${escapeHtml(permission.filesystem)}</span>
    <span class="badge ${permission.readOnlyEnforcementClass}">read_only enforcement: ${escapeHtml(permission.readOnlyEnforcement)}</span>
  </div>
  <div class="participant-config">
    ${configBadges}
  </div>
  <p class="instructions">${escapeHtml(p.instructions)}</p>
</div>`;
		})
		.join("\n");

	const surfaceHeader = m.surface
		? `<div class="meta">surface: <code>${escapeHtml(m.surface.kind)}</code> · capabilities: ${m.surface.capabilities.map((c) => `<code>${escapeHtml(c)}</code>`).join(" ")}${
				m.surface.notes.length > 0
					? `<div class="surface-notes">${m.surface.notes.map((n) => `<div>note: ${escapeHtml(n)}</div>`).join("")}</div>`
					: ""
			}</div>`
		: '<div class="meta">no surface selected (pass <code>--surface</code> for validation)</div>';

	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>chit: ${escapeHtml(m.manifest.id)}</title>
<style>
  body { font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; padding: 24px; max-width: 1400px; margin: 0 auto; color: #1f2328; background: #fff; }
  h1 { margin: 0 0 4px 0; font-size: 20px; }
  .description { color: #57606a; margin-bottom: 8px; }
  .meta { color: #57606a; font-size: 12px; margin-bottom: 16px; }
  .meta code { background: #f6f8fa; padding: 1px 4px; border-radius: 3px; font-size: 11px; }
  section { margin-bottom: 24px; }
  section h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.5px; color: #57606a; margin: 0 0 12px 0; }
  .validation { padding: 12px 16px; border-radius: 6px; }
  .validation.ok { background: #ddf4ff; border: 1px solid #54aeff; }
  .validation.warn { background: #fff8c5; border: 1px solid #d4a72c; }
  .validation.error { background: #ffebe9; border: 1px solid #cf222e; }
  .validation ul { margin: 4px 0 8px 0; padding-left: 20px; }
  .surface-notes { font-size: 11px; color: #57606a; margin-top: 4px; }
  .ok { color: #1f883d; }
  .warn { color: #9a6700; }
  .error { color: #cf222e; }
  .graph { display: grid; grid-template-columns: repeat(${numLevels + 1}, minmax(180px, 1fr)); gap: 16px; align-items: start; }
  .column { display: flex; flex-direction: column; gap: 8px; }
  .column-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: #57606a; margin-bottom: 4px; }
  .node { background: #fff; border: 1px solid #d0d7de; border-radius: 6px; padding: 10px 12px; }
  .node.input { background: #f6f8fa; }
  .node.call { border-color: #54aeff; }
  .node.format { border-color: #1f883d; }
  .node.format.output { border-width: 2px; box-shadow: 0 0 0 2px #aceebb55; }
  .node .id { font-weight: 600; font-size: 13px; margin-bottom: 4px; }
  .node .kind { font-size: 11px; color: #57606a; text-transform: uppercase; }
  .node .refs { font-size: 11px; color: #57606a; margin-top: 6px; }
  .badge { display: inline-block; padding: 1px 7px; border-radius: 10px; font-size: 10px; line-height: 1.6; margin-right: 4px; margin-top: 2px; }
  .badge.info { background: #f6f8fa; color: #57606a; }
  .badge.ok { background: #ddf4ff; color: #0a3069; }
  .badge.warn { background: #fff8c5; color: #9a6700; }
  .participants { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 12px; }
  .participant { background: #f6f8fa; padding: 12px 14px; border-radius: 6px; }
  .participant h3 { margin: 0 0 6px 0; font-size: 14px; }
  .participant-meta { margin-bottom: 6px; }
  .participant-config { margin-bottom: 6px; }
  .instructions { margin: 0; font-size: 12px; color: #57606a; }
  .requires-list { font-family: ui-monospace, monospace; font-size: 12px; color: #57606a; }
</style>
</head>
<body>
<h1>${escapeHtml(m.manifest.id)}</h1>
<p class="description">${escapeHtml(m.manifest.description)}</p>
${surfaceHeader}

${validationBlock}

<section>
  <h2>Execution graph</h2>
  <div class="graph">
    ${inputColumn}
    ${levelColumns.join("\n    ")}
  </div>
</section>

<section>
  <h2>Participants</h2>
  <div class="participants">
    ${participantsSection}
  </div>
</section>

<section>
  <h2>Requires</h2>
  <div class="requires-list">
    declared: ${escapeHtml(Object.keys(m.requires.declared).sort().join(", ") || "(none)")}<br>
    inferred: ${escapeHtml(Object.keys(m.requires.inferred).sort().join(", ") || "(none)")}
  </div>
</section>
</body>
</html>
`;
}

function renderInputColumn(m: GraphModel): string {
	const inputNodes = m.nodes.filter((n) => n.kind === "input");
	if (inputNodes.length === 0)
		return '<div class="column"><div class="column-label">inputs</div></div>';
	const cards = inputNodes
		.map((n) =>
			n.kind === "input"
				? `<div class="node input">
        <div class="id">input: ${escapeHtml(n.inputName)}</div>
        <div class="kind">${escapeHtml(m.inputs[n.inputName]?.type ?? "string")}</div>
      </div>`
				: "",
		)
		.join("\n      ");
	return `<div class="column"><div class="column-label">inputs</div>${cards}</div>`;
}

function renderLevelColumn(m: GraphModel, level: number): string {
	const stepIds = m.executionOrder[level] ?? [];
	const cards = stepIds
		.map((stepId) => {
			const node = m.nodes.find((n) => n.id === stepId);
			if (!node) return "";
			if (node.kind === "call") {
				return `<div class="node call">
        <div class="id">${escapeHtml(node.id)}</div>
        <div class="kind">call → ${escapeHtml(node.participantId)}</div>
        ${node.refs.length > 0 ? `<div class="refs">refs: ${node.refs.map(escapeHtml).join(", ")}</div>` : ""}
      </div>`;
			}
			if (node.kind === "format") {
				return `<div class="node format${node.isOutput ? " output" : ""}">
        <div class="id">${escapeHtml(node.id)}${node.isOutput ? " (output)" : ""}</div>
        <div class="kind">format</div>
        ${node.refs.length > 0 ? `<div class="refs">refs: ${node.refs.map(escapeHtml).join(", ")}</div>` : ""}
      </div>`;
			}
			return "";
		})
		.join("\n      ");
	const tag =
		stepIds.length > 1 ? "parallel" : level === m.executionOrder.length - 1 ? "final" : "";
	return `<div class="column"><div class="column-label">level ${level}${tag ? ` · ${tag}` : ""}</div>${cards}</div>`;
}

function escapeHtml(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

// Edge accessor isn't used by current renderers (refs on nodes carry the
// information visually), but the model still exposes them for richer UIs.
// Keeping this export so future renderers can pull from a clear API.
export type { GraphEdge };
