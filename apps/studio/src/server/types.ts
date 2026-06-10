// Wire types shared between the server and (eventually) the client. These
// match the Studio wire contract. Kept here for now because the
// server is the only consumer in sub-unit 1.0; the client will import the
// same module from across the workspace once it lands.

import type {
	FilesystemPermission,
	GraphModel,
	LoopStopStatus,
	NormalizedConfig,
	ResolvedManifest,
	SessionPolicy,
} from "@chit-run/core";

export type ParsedStudioDocument = {
	id: string;
	relPath: string;
	raw: string;
	status: "parsed";
	// The server resolves every draft (parseManifest -> resolveManifest) before it
	// builds the graph model, so what crosses the wire is a ResolvedManifest, not a
	// bare parse. Typed accordingly so the contract does not under-claim (clients may
	// read participant provenance); resolution errors surface as the `error` variant.
	manifest: ResolvedManifest;
};

export type ErrorStudioDocument = {
	id: string;
	relPath: string;
	raw: string;
	status: "error";
	parseError: string;
};

export type StudioDocument = ParsedStudioDocument | ErrorStudioDocument;

export type DocumentDetail =
	| { document: ParsedStudioDocument; graphModel: GraphModel; hash: string }
	| { document: ErrorStudioDocument; hash: string };

// POST /api/documents/:docId/preview. The client sends an editable
// draft (file-shape JSON, not NormalizedManifest); the server validates
// via parseManifest, builds the graph model, and returns what would
// land on disk if the draft were saved. No disk write happens here.
// `canonicalRaw` is the exact bytes the server would write on save:
// JSON.stringify(draft, null, "\t") preserves the example file style.
//
// Same response shape as DocumentDetail for the union variants, plus
// `canonicalRaw` on the parsed variant so a later sub-unit can render
// the diff against the on-disk raw.

export interface PreviewRequest {
	draft: unknown;
	surface?: string;
}

export type PreviewResponse =
	| { document: ParsedStudioDocument; graphModel: GraphModel; canonicalRaw: string }
	| { document: ErrorStudioDocument };

// PUT /api/documents/:docId. The client sends an editable draft plus
// the baseHash it had at load time. The server reads the current
// on-disk hash; if it matches baseHash, the server validates and
// writes canonicalRaw to disk, returning the new hash. If the disk
// hash has drifted (another editor / git checkout / external change),
// the server returns 409 with the current hash so the client can
// resolve. Parse failures on the draft return the error variant with
// no write.

export interface SaveRequest {
	draft: unknown;
	surface?: string;
	baseHash: string;
}

export interface SavedSaveResponse {
	document: ParsedStudioDocument;
	graphModel: GraphModel;
	canonicalRaw: string;
	hash: string;
}

export interface ErrorSaveResponse {
	document: ErrorStudioDocument;
}

export type SaveResponse = SavedSaveResponse | ErrorSaveResponse;

// Sent with HTTP 409 status.
export interface ConflictResponse {
	kind: "conflict";
	currentHash: string;
}

// Install / list / uninstall surface. The actual node-side lifecycle code
// lives in apps/cli (installClaudeSkill, listInstalled, uninstall) and cannot
// be imported here without a workspace cycle, so the CLI injects an
// implementation of StudioLifecycle into startStudio (dependency injection,
// the same way it already injects the registry). Wire shapes below omit
// absolute paths; the client sees names/surfaces/timestamps only.

export interface InstalledSummary {
	name: string; // install folder + SKILL.md name (marker.installName)
	surface: string;
	manifestId: string;
	installedAt: string; // ISO-8601
}

export interface InstallSummary {
	name: string;
	surface: string;
	// Permission gaps that required an override (warnings, not failures).
	enforcementGaps: Array<{ participantId: string; agentId: string; permission: string }>;
}

export interface UninstallSummary {
	name: string;
}

// What the studio server asks the host to install. The host (CLI) fills in
// outputDir / runtimePath defaults; the server passes the resolved manifest
// path (from the docId table) plus the surface and user options.
export interface StudioInstallParams {
	manifestPath: string;
	surface: string;
	force?: boolean;
	overrideName?: string;
	allowUnenforcedPermissions?: boolean;
}

export interface StudioLifecycle {
	list(): InstalledSummary[];
	install(params: StudioInstallParams): InstallSummary;
	uninstall(name: string): UninstallSummary;
}

// POST /api/install request body. docId resolves to the manifest path
// server-side; the manifest must be saved to disk first (install reads the
// file, not the in-memory draft). baseHash is the hash the client last saw;
// the server rejects with 409 if disk has drifted, so a stale tab or an
// external change cannot install a different chit than the user is looking at
// (same conflict philosophy as PUT).
export interface InstallRequest {
	docId: string;
	surface: string;
	baseHash: string;
	force?: boolean;
	overrideName?: string;
	allowUnenforcedPermissions?: boolean;
}

// Read-only convergence-log view. GET /api/loops returns
// LoopSummary[]; GET /api/loops/:loopId returns LoopRecord[] (the @chit-run/core
// type). loopId is the validated, safe-slug file basename.
export interface LoopSummary {
	loopId: string;
	scope: string;
	task: string;
	status: LoopStopStatus | "in-progress";
	iterations: number;
	totalElapsedMs: number | null;
	startedAt: string;
}

// GET /api/live. A compact, read-only snapshot of what is live across Chit right
// now, for the future visual control tower (a session rail plus a selected run's
// detail). The data is produced by the HOST (the CLI), which owns the Chit state
// readers, and injected as a StudioLiveSource -- the same host-injection pattern
// used for lifecycle and loopsDir, so @chit-run/studio never imports CLI
// internals. A standalone Studio with no host returns an empty LiveActivity, not
// an error.
//
// Two sources, kept visibly distinct -- separate arrays AND a `source` tag on
// every row:
//   - foreground: in-flight foreground loop iterations mirrored from the
//     cross-process foreground registry (live, ephemeral; a crashed or idle run
//     drops out).
//   - background: durable background jobs from the JobStore (cross-session;
//     queued/running only, with `stale` derived for a dead worker).
//
// Every row is a GLANCE summary, safe to hand a browser: ids, a bounded
// scope/task one-liner, phase/display, ages derived against the reader's clock,
// iteration counters and timeout/budget numbers (iteration, iterationsCompleted,
// maxIterations, callTimeoutMs -- plain numbers, nothing more), the current
// iteration's phase timeline (phase names and durations only, foreground rows
// only), agent+adapter participants, a compact statusLine, and a managed
// worktree path only when already safe to expose. `taskFull` is the explicit
// local detail payload for the selected-run prompt disclosure. A row NEVER
// carries model outputs, review prose, config/env values, or audit blobs.

// The one safe participant pair the rail/detail shows: which agent ran and via
// which adapter. The full provenance (permissions, config, env keys) is
// deliberately omitted -- it lives in the audit run and the richer status views.
// `model` and `reasoningEffort` are the only config fields that cross: they
// answer "which model is running" and are present only when the persisted
// snapshot carried them. Env keys and the rest of the config stay out.
export interface LiveParticipant {
	agentId: string;
	adapter: string;
	model?: string;
	reasoningEffort?: string;
}

// The recipe identity of a live run, rebuilt field-by-field from the run's
// RecipeReceipt (never spread) so only the safe naming/budget facts cross: which
// named recipe and where it was defined, plus the loop budgets it carried. The
// receipt's origin PATH is dropped -- only the layer (builtin/global/repo) crosses.
export interface LiveRecipeIdentity {
	id: string;
	origin?: ConfigOriginSource;
	mode: "converge";
	maxIterations?: number;
	callTimeoutMs?: number;
}

// The execution surface of a live run: which recipe and bound manifest it runs.
// A privacy-safe identity strip, not a receipt -- recipe id/origin/budgets plus
// the manifest path and content digest the run was bound to. No prompts, model
// outputs, config values, or env. Present only when the host actually knows these
// (a background loop launched from a recipe / digest-bound approval); a row
// without execution identity omits the field and the detail renders nothing.
export interface LiveExecutionIdentity {
	recipe?: LiveRecipeIdentity;
	manifestPath?: string;
	manifestDigest?: string;
}

// The event vocabulary of a live tail entry. Mirrors the host's LiveEventKind;
// kept as a local union (like ConfigOriginSource / JobStateName) so the wire
// contract stays explicit and free of CLI imports.
export type LiveEventKind = "step.started" | "step.completed" | "step.failed" | "adapter.event";

// One entry of a row's bounded live-event tail: a privacy-safe digest of a
// runtime event (step boundary or adapter event TYPE). The label is built
// host-side from structural facts only -- ids and event types, never a prompt,
// output, error text, or raw adapter line -- so it is safe to render verbatim.
// `ageMs` is derived against the reader's clock at snapshot time (stored
// timestamps never cross the wire), same convention as the row-level ages.
export interface LiveEventView {
	ageMs: number;
	kind: LiveEventKind;
	label: string;
	stepId?: string;
	participantId?: string;
	agentId?: string;
}

// One in-flight foreground loop iteration mirrored from the cross-process
// registry. `source` is the literal "foreground" so a flattened list stays
// self-describing alongside background rows.
export interface ForegroundLiveRow {
	source: "foreground";
	runId: string;
	scope: string;
	task: string;
	taskFull?: string;
	phase: string;
	statusLine: string;
	// Structured iteration/budget counters so the client never parses statusLine:
	// the iteration now running, the run's iteration budget, and the per-call
	// timeout override (ms) it was launched with. Plain numbers only.
	iteration?: number;
	maxIterations?: number;
	callTimeoutMs?: number;
	// A chit-managed worktree path, present only for an isolated run (already safe
	// to expose -- the same path the loop/run views surface).
	worktreePath?: string;
	// Ages derived against the reader's clock (omitted when not derivable).
	elapsedMs?: number;
	phaseElapsedMs?: number;
	lastActivityAgeMs?: number;
	// The current iteration's phase timeline: completed phases in order (durations
	// fixed by their stored marks) plus at most one trailing active entry whose
	// elapsedMs is derived against the reader's clock. Phase names and durations
	// only -- never model output or config. Omitted when nothing is derivable
	// (e.g. the pre-phase "starting" spin-up). Foreground rows only.
	phases?: Array<{ phase: string; status: "completed" | "active"; elapsedMs: number }>;
	// The current iteration's bounded live-event tail, oldest first (kind/label/ids
	// plus a reader-clock age -- see LiveEventView). Omitted when empty.
	recentEvents?: LiveEventView[];
	participants?: Record<string, LiveParticipant>;
}

// One durable background job. `display` is the lifecycle state with `stale`
// derived (a running job whose worker is gone or silent), the same legible signal
// the operator status surfaces.
export interface BackgroundLiveRow {
	source: "background";
	runId: string;
	scope: string;
	// Loop-only one-liner; a one-shot background run has no converge task.
	task?: string;
	// Full loop task for the selected-run prompt disclosure. Still local and
	// token-gated, separate from model output or audit blobs.
	taskFull?: string;
	display: string;
	phase?: string;
	statusLine: string;
	// Structured iteration/budget counters for a LOOP job (one-shot jobs have no
	// loop identity, so all four stay undefined): current/last iteration, completed
	// count, the iteration budget, and the per-call timeout override (ms). Plain
	// numbers only.
	iteration?: number;
	iterationsCompleted?: number;
	maxIterations?: number;
	callTimeoutMs?: number;
	worktreePath?: string;
	elapsedMs?: number;
	phaseElapsedMs?: number;
	lastHeartbeatAgeMs?: number;
	// The worker's bounded live-event tail, oldest first -- the background mirror
	// of the foreground tail (kind/label/ids plus a reader-clock age, see
	// LiveEventView). Omitted when empty.
	recentEvents?: LiveEventView[];
	participants?: Record<string, LiveParticipant>;
	// The run's execution surface: recipe + bound manifest identity. Background
	// loops only -- foreground snapshots cannot know a recipe or manifest digest, so
	// they never carry it. Omitted when the run has no execution identity.
	execution?: LiveExecutionIdentity;
}

export type LiveActivityRow = ForegroundLiveRow | BackgroundLiveRow;

export interface LiveActivity {
	foreground: ForegroundLiveRow[];
	background: BackgroundLiveRow[];
}

export interface StudioLiveSource {
	live(): LiveActivity;
}

// POST /api/live/cancel request body. Cancels a live run through the
// host-injected action handler. `source` is required and validated: only
// "background" is accepted. A foreground request is refused (422) -- Studio
// mirrors the cross-process foreground snapshots but does NOT own the MCP
// foreground controller, so it cannot honestly cancel a foreground run; offering
// a real cancel there would be a lie. `runId` is validated as a safe slug before
// it reaches the host (it becomes a JobStore filesystem key).
export interface LiveCancelRequest {
	runId: string;
	source: string;
}

// The host's cancel outcome, intent-first (matching chit_cancel): a
// queued/running job gets `cancelRequestedAt` persisted -- and a running job also
// gets phase `cancelling` -- BEFORE any worker signal, so the intent survives a
// worker restart or stale detection. `signaled` reports whether a live worker was
// actually signaled (a stale/already-exited worker is not). A terminal job is
// reported already-finished, never re-signaled; an unknown id is not-found.
export type LiveCancelResult =
	| { status: "requested"; state: "queued" | "running"; signaled: boolean }
	| { status: "already-finished"; state: JobStateName }
	| { status: "not-found" };

// The terminal+live job states the cancel result reports. Kept as a local string
// union (not an import of the CLI's JobState) so @chit-run/studio stays free of
// CLI internals; the host maps its JobState onto this.
export type JobStateName = "queued" | "running" | "completed" | "cancelled" | "failed";

// Mutating counterpart to StudioLiveSource, injected by the host (the CLI), which
// owns JobStore and the worker signaling. The only action in this slice is
// cancelling a BACKGROUND job. Absent means POST /api/live/cancel returns 501 (a
// read-only / standalone Studio). The handler is never asked to cancel a
// foreground run -- the route rejects that with 422 first.
export interface StudioLiveActions {
	cancelBackground(runId: string): LiveCancelResult;
}

// GET /api/config. A read-only view of the EFFECTIVE config for the Studio
// target repo: which agents, roles, and recipes Chit would use there, and where
// each definition came from. Produced by mapping the host's NormalizedConfig through
// effectiveConfigView (config.ts), which owns the redaction: env VALUES never
// cross this surface (key names only), and role instructions are cut to a
// bounded preview so a huge persona never ships by default. The config is
// re-read per request via StudioConfigSource, so the view observes current
// disk state, not a boot snapshot.

// Which layer defined an effective entity. Mirrors core's ConfigOrigin.source;
// kept as a local union so the wire contract is explicit about its vocabulary.
export type ConfigOriginSource = "builtin" | "global" | "repo";

export interface EffectiveAgentView {
	id: string;
	adapter: string;
	origin: ConfigOriginSource;
	model?: string;
	reasoningEffort?: string;
	// Effective values, present only for the claude-cli adapter where they mean
	// something (same convention as core's ParticipantConfig).
	strictMcp?: boolean;
	passModelOnResume?: boolean;
	callTimeoutMs?: number;
	noProgressTimeoutMs?: number;
	description?: string;
	// Env KEY NAMES only, sorted; values are redacted server-side and never
	// appear anywhere in the response.
	envKeys?: string[];
}

export interface EffectiveRoleView {
	id: string;
	origin: ConfigOriginSource;
	// The role's optional default agent; absent for a model-agnostic role.
	agent?: string;
	session: SessionPolicy;
	filesystem: FilesystemPermission;
	// Whitespace-collapsed, bounded preview of the instructions plus the full
	// length, so the panel can show "what kind of persona" without dumping it.
	instructionsPreview: string;
	instructionsLength: number;
}

// A recipe is a named, reusable converge preset: a manifest to run plus the
// loop knobs a run would inherit. Field-by-field rebuilt server-side (never
// spread from NormalizedRecipe) so the wire view stays an explicit contract.
export interface EffectiveRecipeView {
	id: string;
	origin: ConfigOriginSource;
	// Only "converge" exists today; kept as an explicit literal like the other
	// wire unions so the contract states its vocabulary.
	mode: "converge";
	manifestPath: string;
	maxIterations?: number;
	callTimeoutMs?: number;
	description?: string;
}

export interface EffectiveConfigView {
	// The global / repo config files that were actually read; absent when the
	// file does not exist (defaults-only config has neither).
	configPath?: string;
	repoConfigPath?: string;
	agents: EffectiveAgentView[];
	roles: EffectiveRoleView[];
	recipes: EffectiveRecipeView[];
}

// Host-injected config reader, same injection pattern as lifecycle/liveSource:
// the CLI owns loadConfig (node-side, git-aware repo-root discovery) and Studio
// must not import CLI internals. load() is called PER REQUEST and must re-read
// disk, so the route reports the config a run launched now would actually use.
// Absent (standalone Studio with no host) means GET /api/config returns 501.
export interface StudioConfigSource {
	load(): NormalizedConfig;
}

export type Bootstrap =
	| {
			mode: "open";
			docId: string;
			document: ParsedStudioDocument;
			graphModel: GraphModel;
			hash: string;
	  }
	| {
			mode: "open";
			docId: string;
			document: ErrorStudioDocument;
			hash: string;
	  }
	| {
			mode: "picker";
			candidates: Array<{
				docId: string;
				relPath: string;
				status: "parsed" | "error";
			}>;
	  }
	| {
			mode: "empty";
	  };
