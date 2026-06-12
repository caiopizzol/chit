// Pure helpers for the declared-routines view. The component stays focused on
// rendering while this module owns keys, body selection, and canvas shaping.

import type { DeclaredRoutine, LiveActivity, RoutineParticipant } from "../server/types.ts";
import { flattenRows } from "./live.ts";

// Namespaced so routine selection cannot collide with live row keys.
export function routineKey(routine: { id: string }): string {
	return `routine:${routine.id}`;
}

// Classify by participant id and resolved config role. Both show up in real
// manifests, and abbreviated ids like impl/rev are common.
export function participantRole(
	p: RoutineParticipant,
): "implementer" | "reviewer" | "checks" | "other" {
	const hay = `${p.id} ${p.role ?? ""}`.toLowerCase();
	if (hay.includes("impl") || hay.includes("plan")) return "implementer";
	if (hay.includes("rev")) return "reviewer";
	if (hay.includes("check")) return "checks";
	return "other";
}

export interface RoutineBlockView {
	role: "implementer" | "reviewer" | "checks" | "you";
	label: string;
	present: boolean;
	agentId?: string;
	detail?: string;
}

// Governance one-liner for a participant block: session and filesystem permission,
// the same safe facts the config panel shows for a role.
function governance(p: RoutineParticipant): string {
	return `${p.session} / ${p.filesystem}`;
}

function participantBlock(
	role: "implementer" | "reviewer",
	participant: RoutineParticipant | undefined,
): RoutineBlockView {
	if (participant === undefined) {
		return { role, label: role, present: false, detail: "not declared" };
	}
	return {
		role,
		label: role,
		present: true,
		agentId: participant.agentId,
		detail: governance(participant),
	};
}

function checksBlock(routine: DeclaredRoutine): RoutineBlockView {
	const checks = routine.manifest?.requiredChecks;
	if (checks === undefined) {
		return { role: "checks", label: "checks", present: false, detail: "unknown" };
	}
	if (checks.length === 0) {
		return {
			role: "checks",
			label: "checks",
			present: false,
			agentId: "chit",
			detail: "no required checks",
		};
	}
	const names = checks.map((c) => c.name ?? c.command).join(", ");
	return {
		role: "checks",
		label: "checks",
		present: true,
		agentId: "chit",
		detail: `${checks.length} required / ${names}`,
	};
}

// The at-rest routine canvas keeps the converge loop shape even when the manifest
// summary is unavailable, with unknown blocks marked as placeholders.
export function routineCanvas(routine: DeclaredRoutine): RoutineBlockView[] {
	const participants = routine.manifest?.participants ?? [];
	const implementer =
		participants.find((p) => participantRole(p) === "implementer") ??
		participants.find((p) => participantRole(p) === "other");
	const reviewer = participants.find((p) => participantRole(p) === "reviewer");
	return [
		participantBlock("implementer", implementer),
		participantBlock("reviewer", reviewer),
		checksBlock(routine),
		{
			role: "you",
			label: "you",
			present: true,
			agentId: "operator",
			detail: "approves and monitors",
		},
	];
}

export type TowerBody = "empty" | "empty-with-console" | "grid";

export function towerBody(
	activity: LiveActivity,
	routineCount: number,
	logCount: number,
): TowerBody {
	if (flattenRows(activity).length > 0 || routineCount > 0) return "grid";
	return logCount > 0 ? "empty-with-console" : "empty";
}
