// Pure helpers for the declared-routines view. The component stays focused on
// rendering while this module owns keys, body selection, and canvas shaping.

import type { DeclaredRoutine, LiveActivity, RoutineParticipant } from "../server/types.ts";
import { flattenRows, formatAge, shortDigest } from "./live.ts";

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
	role: string;
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

function participantForStep(
	routine: DeclaredRoutine,
	stepId: string,
): RoutineParticipant | undefined {
	const step = routine.manifest?.steps.find((s) => s.id === stepId && s.kind === "call");
	if (step?.participantId === undefined) return undefined;
	return routine.manifest?.participants.find((p) => p.id === step.participantId);
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

function convergeCanvas(routine: DeclaredRoutine): RoutineBlockView[] {
	const policy = routine.manifest?.policy;
	const participants = routine.manifest?.participants ?? [];
	const implementer =
		policy?.kind === "loop"
			? (participantForStep(routine, policy.implementStep) ??
				participants.find((p) => participantRole(p) === "implementer") ??
				participants.find((p) => participantRole(p) === "other"))
			: undefined;
	const reviewer =
		policy?.kind === "loop"
			? (participantForStep(routine, policy.reviewStep) ??
				participants.find((p) => participantRole(p) === "reviewer"))
			: undefined;
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

function oneShotCanvas(routine: DeclaredRoutine): RoutineBlockView[] {
	const steps = routine.manifest?.steps ?? [];
	if (steps.length === 0) {
		return [
			{ role: "manifest", label: "manifest", present: false, detail: "not resolved" },
			{
				role: "you",
				label: "you",
				present: true,
				agentId: "operator",
				detail: "runs and reads output",
			},
		];
	}
	return [
		...steps.map((step): RoutineBlockView => {
			if (step.kind === "format") {
				return {
					role: step.id,
					label: step.id,
					present: true,
					agentId: "chit",
					detail: "formats output",
				};
			}
			const detail =
				step.session !== undefined && step.filesystem !== undefined
					? `call ${step.participantId} / ${step.session} / ${step.filesystem}`
					: step.participantId !== undefined
						? `call ${step.participantId}`
						: "call";
			return {
				role: step.id,
				label: step.id,
				present: true,
				agentId: step.agentId,
				detail,
			};
		}),
		{
			role: "you",
			label: "you",
			present: true,
			agentId: "operator",
			detail: "runs and reads output",
		},
	];
}

// The at-rest routine canvas keeps the converge loop shape for converge recipes
// and uses the manifest's own ordered steps for one-shot routines.
export function routineCanvas(routine: DeclaredRoutine): RoutineBlockView[] {
	return routine.mode === "converge" ? convergeCanvas(routine) : oneShotCanvas(routine);
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

export interface RoutineTickerView {
	key: string;
	text: string;
	tail: string;
}

function formatCost(cost: number | undefined): string | undefined {
	if (cost === undefined || !Number.isFinite(cost) || cost < 0) return undefined;
	return `$${cost.toFixed(4)}`;
}

function runRef(routine: DeclaredRoutine): string {
	const lastRun = routine.lastRun;
	if (lastRun?.auditRef) return `audit ${lastRun.auditRef}`;
	if (lastRun?.traceRef) return `trace ${lastRun.traceRef}`;
	return "receipt";
}

export function routineTicker(routine: DeclaredRoutine): RoutineTickerView {
	const lastRun = routine.lastRun;
	if (lastRun !== undefined) {
		const parts = [
			[lastRun.status, lastRun.verdict].filter(Boolean).join(" / "),
			`${lastRun.iterationsCompleted} ${lastRun.iterationsCompleted === 1 ? "iter" : "iters"}`,
			lastRun.ageMs !== undefined ? `${formatAge(lastRun.ageMs)} ago` : undefined,
			lastRun.elapsedMs !== undefined ? `elapsed ${formatAge(lastRun.elapsedMs)}` : undefined,
			formatCost(lastRun.estimatedCostUsd),
		].filter((part): part is string => part !== undefined && part.length > 0);
		return { key: "last run", text: parts.join(" / "), tail: runRef(routine) };
	}
	return {
		key: "declared",
		text: `${routine.mode} / ${routine.manifestPath}${
			routine.manifest?.manifestDigest ? ` / ${shortDigest(routine.manifest.manifestDigest)}` : ""
		}`,
		tail: routine.error ? "unresolved" : "ready",
	};
}
