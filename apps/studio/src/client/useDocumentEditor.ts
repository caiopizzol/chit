// Editing state machine for an open document. Owns the draft, the
// server-confirmed raw/hash, the validation graphModel, and the async
// edit/preview/save lifecycle. Pure decision logic (dirty, canSave) lives in
// editor.ts; this hook is the React glue.

import type { GraphModel, SurfaceKind } from "@chit-run/core";
import { parseManifest } from "@chit-run/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { previewDocument, StudioApiError, saveDocument } from "./api.ts";
import {
	canSave as canSaveGate,
	insertReference,
	isDirty,
	removeReference,
	updateParticipantField,
	updateStepField,
} from "./editor.ts";
import type { OpenClientState } from "./state.ts";

const PREVIEW_DEBOUNCE_MS = 400;

export interface DocumentEditor {
	surface: SurfaceKind;
	graphModel: GraphModel;
	draftSource: Record<string, unknown>;
	raw: string;
	// Current on-disk hash; sent as baseHash on save and install.
	hash: string;
	dirty: boolean;
	previewPending: boolean;
	previewError: string | null;
	saving: boolean;
	conflict: { currentHash: string } | null;
	canSave: boolean;
	setDescription: (value: string) => void;
	setParticipantField: (
		participantId: string,
		field: "instructions" | "session" | "filesystem",
		value: string,
	) => void;
	setStepField: (stepId: string, field: "prompt" | "format", value: string) => void;
	connect: (targetStepId: string, token: string) => { ok: boolean; error?: string };
	disconnectMany: (
		refs: Array<{ targetStepId: string; refKind: "input" | "call" | "format"; refName: string }>,
	) => { ok: boolean; removed?: number; error?: string };
	changeSurface: (next: SurfaceKind) => Promise<void>;
	save: () => Promise<{ ok: boolean }>;
}

function errMessage(e: unknown): string {
	return e instanceof StudioApiError ? `${e.status}: ${e.message}` : (e as Error).message;
}

export function useDocumentEditor(initial: OpenClientState): DocumentEditor {
	const [surface, setSurface] = useState<SurfaceKind>(
		(initial.graphModel.surface?.kind as SurfaceKind) ?? "claude-skill",
	);
	const [graphModel, setGraphModel] = useState<GraphModel>(initial.graphModel);
	const [draftSource, setDraftSource] = useState<Record<string, unknown>>(initial.draftSource);
	const [raw, setRaw] = useState(initial.raw);
	const [hash, setHash] = useState(initial.hash);
	const [previewPending, setPreviewPending] = useState(false);
	const [previewError, setPreviewError] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	const [conflict, setConflict] = useState<{ currentHash: string } | null>(null);

	// Monotonic preview id. A preview only applies its result (and only clears
	// previewPending) if its captured id is still current when it settles.
	// runPreview READS this id; it does not advance it. Advancing happens in
	// invalidatePreview, called the moment a new draft/surface intent is
	// registered. That is what closes the stale-preview races: an in-flight
	// preview is invalidated as soon as a new edit is queued, not only when the
	// next request fires, so it can neither apply a stale graphModel nor clear
	// pending out from under a queued edit.
	const previewSeq = useRef(0);
	const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	const clearPendingPreview = useCallback(() => {
		if (debounceTimer.current) {
			clearTimeout(debounceTimer.current);
			debounceTimer.current = null;
		}
	}, []);

	// Invalidate any in-flight or queued preview: advance the sequence (so an
	// in-flight response no longer looks current) and cancel any not-yet-fired
	// timer. Call this whenever the draft or surface intent changes.
	const invalidatePreview = useCallback(() => {
		previewSeq.current += 1;
		clearPendingPreview();
	}, [clearPendingPreview]);

	// Invalidate on unmount so a returning in-flight preview cannot setState
	// after the component is gone, and a pending timer cannot fire.
	useEffect(() => invalidatePreview, [invalidatePreview]);

	// Run a preview for the given draft + surface. Captures the current id
	// (set by the preceding invalidatePreview); applies only if still current.
	// Returns whether it applied cleanly (changeSurface commits the surface
	// only on success).
	const runPreview = useCallback(
		async (draft: Record<string, unknown>, surf: SurfaceKind): Promise<boolean> => {
			const id = previewSeq.current;
			setPreviewPending(true);
			setPreviewError(null);
			try {
				const result = await previewDocument(initial.docId, draft, surf);
				if (id !== previewSeq.current) return false; // superseded, dropped
				if ("graphModel" in result) {
					setGraphModel(result.graphModel);
					return true;
				}
				setPreviewError(`draft no longer parses: ${result.document.parseError}`);
				return false;
			} catch (e) {
				if (id !== previewSeq.current) return false;
				setPreviewError(errMessage(e));
				return false;
			} finally {
				if (id === previewSeq.current) setPreviewPending(false);
			}
		},
		[initial.docId],
	);

	// Apply a fully-computed next draft: set it, mark pending immediately
	// (not after the debounce — otherwise canSave is briefly true against
	// stale validation), clear the prior error, invalidate any in-flight or
	// queued preview, and schedule a fresh debounced preview. All field
	// setters funnel through here so the edit lifecycle is identical
	// regardless of which field changed.
	const applyDraft = useCallback(
		(next: Record<string, unknown>, opts?: { immediate?: boolean }) => {
			setDraftSource(next);
			setPreviewPending(true);
			setPreviewError(null);
			invalidatePreview();
			if (opts?.immediate) {
				// Direct-manipulation edits (drag-to-connect) want the validated
				// graph back without the typing debounce.
				void runPreview(next, surface);
			} else {
				debounceTimer.current = setTimeout(() => {
					void runPreview(next, surface);
				}, PREVIEW_DEBOUNCE_MS);
			}
		},
		[runPreview, surface, invalidatePreview],
	);

	const setDescription = useCallback(
		(value: string) => {
			applyDraft({ ...draftSource, description: value });
		},
		[applyDraft, draftSource],
	);

	// Edit a participant's instructions / session / permissions.filesystem.
	// filesystem is nested under permissions; instructions and session are
	// top-level on the participant. Editing here edits the shared participant (a
	// participant can back several call steps).
	const setParticipantField = useCallback(
		(participantId: string, field: "instructions" | "session" | "filesystem", value: string) => {
			applyDraft(updateParticipantField(draftSource, participantId, field, value));
		},
		[applyDraft, draftSource],
	);

	const setStepField = useCallback(
		(stepId: string, field: "prompt" | "format", value: string) => {
			applyDraft(updateStepField(draftSource, stepId, field, value));
		},
		[applyDraft, draftSource],
	);

	// Drag-to-connect: append the reference token to the target step's
	// template and commit if valid. parseManifest runs locally (browser-safe,
	// no registry needed) as the accept/reject gate so a rejected connection
	// (unknown ref, cycle) leaves the draft unchanged — unlike field edits,
	// which commit optimistically. On accept, applyDraft commits and previews
	// immediately so the new edge renders without the typing debounce.
	const connect = useCallback(
		(targetStepId: string, token: string): { ok: boolean; error?: string } => {
			let candidate: Record<string, unknown>;
			try {
				candidate = insertReference(draftSource, targetStepId, token);
			} catch (e) {
				return { ok: false, error: (e as Error).message };
			}
			if (candidate === draftSource) return { ok: false, error: "already connected" };
			try {
				parseManifest(candidate);
			} catch (e) {
				return { ok: false, error: (e as Error).message };
			}
			applyDraft(candidate, { immediate: true });
			return { ok: true };
		},
		[draftSource, applyDraft],
	);

	// Delete one or more edges in a single event. React Flow's onEdgesDelete
	// hands back an Edge[]; all removals must reduce against ONE candidate
	// draft (not each against the same render's draftSource — that would keep
	// only the last). parseManifest gates once; applyDraft commits once with
	// an immediate preview. A removal that empties a required template makes
	// the candidate invalid, so the gate rejects the whole batch and the draft
	// is unchanged.
	const disconnectMany = useCallback(
		(
			refs: Array<{ targetStepId: string; refKind: "input" | "call" | "format"; refName: string }>,
		): { ok: boolean; removed?: number; error?: string } => {
			let candidate = draftSource;
			let total = 0;
			try {
				for (const r of refs) {
					const res = removeReference(candidate, r.targetStepId, r.refKind, r.refName);
					candidate = res.draft;
					total += res.removed;
				}
			} catch (e) {
				return { ok: false, error: (e as Error).message };
			}
			if (total === 0) return { ok: false, error: "no matching reference found" };
			try {
				parseManifest(candidate);
			} catch (e) {
				return { ok: false, error: (e as Error).message };
			}
			applyDraft(candidate, { immediate: true });
			return { ok: true, removed: total };
		},
		[draftSource, applyDraft],
	);

	const changeSurface = useCallback(
		async (next: SurfaceKind) => {
			if (next === surface) return;
			// Invalidate first: cancels a pending edit-preview timer (it targets
			// the old surface) and supersedes any in-flight preview.
			invalidatePreview();
			const ok = await runPreview(draftSource, next);
			if (ok) setSurface(next);
		},
		[surface, draftSource, runPreview, invalidatePreview],
	);

	const dirty = isDirty(draftSource, raw);
	const conflictActive = conflict !== null;
	const canSave =
		!saving &&
		canSaveGate({ dirty, previewPending, previewError, conflict: conflictActive, graphModel });

	const save = useCallback(async (): Promise<{ ok: boolean }> => {
		// A pending or in-flight preview is moot once we commit; invalidate so
		// neither can fire/apply mid-save. (canSave already blocks save while
		// pending, so this is defensive.)
		invalidatePreview();
		setSaving(true);
		try {
			const outcome = await saveDocument(initial.docId, draftSource, surface, hash);
			if (outcome.kind === "saved") {
				setRaw(outcome.response.canonicalRaw);
				setHash(outcome.response.hash);
				setGraphModel(outcome.response.graphModel);
				setConflict(null);
				setPreviewError(null);
				return { ok: true };
			}
			if (outcome.kind === "parse-error") {
				setPreviewError(`save rejected: ${outcome.response.document.parseError}`);
				return { ok: false };
			}
			// conflict: do not write, do not auto-refresh; surface it.
			setConflict({ currentHash: outcome.currentHash });
			return { ok: false };
		} catch (e) {
			setPreviewError(errMessage(e));
			return { ok: false };
		} finally {
			setSaving(false);
		}
	}, [initial.docId, draftSource, surface, hash, invalidatePreview]);

	return {
		surface,
		graphModel,
		draftSource,
		raw,
		hash,
		dirty,
		previewPending,
		previewError,
		saving,
		conflict,
		canSave,
		setDescription,
		setParticipantField,
		setStepField,
		connect,
		disconnectMany,
		changeSurface,
		save,
	};
}
