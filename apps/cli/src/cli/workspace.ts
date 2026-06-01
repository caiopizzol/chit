// Classify a git working-tree snapshot into the task's changed files vs non-task
// workspace conditions ("workspace dirt"). This is the durable contract behind
// the converge loop record:
//   - changedFiles    = files the agent changed as part of the task.
//   - workspaceWarnings = untracked generated artifacts, surfaced (not hidden)
//     so they stay visible to the operator/reviewer without polluting
//     changedFiles.
//   - chit-owned control-plane state is dropped from BOTH: loop logs no longer
//     live in the repo, but a legacy in-repo log would otherwise leak in.
//
// Pure: the git shelling lives in converge.ts and passes the file lists in, so
// the classification is unit-testable without a working tree.

// chit-owned control-plane state inside the repo (a legacy in-repo loop log).
export function isChitOwned(path: string): boolean {
	return path === ".chit" || path.startsWith(".chit/");
}

// Generated artifacts a build or test step can drop into the tree. A small,
// documented set; extend as real cases appear. This is NOT a general gitignore
// engine: gitignored files are already excluded upstream (the caller passes
// `git ls-files --others --exclude-standard`). It catches common artifacts in a
// repo that simply lacks a matching ignore rule, which is exactly what made a
// trivial converge slice revise on a stray __pycache__/*.pyc.
export function isGeneratedArtifact(path: string): boolean {
	const base = path.slice(path.lastIndexOf("/") + 1);
	return (
		path === "__pycache__" ||
		path.startsWith("__pycache__/") ||
		path.includes("/__pycache__/") ||
		path.endsWith(".pyc") ||
		path.endsWith(".pyo") ||
		base === ".DS_Store"
	);
}

export interface WorkspaceSnapshot {
	// Tracked files with unstaged or staged changes (task work on existing files).
	tracked: string[];
	// Untracked, non-ignored files (new files the implementer may have created).
	untracked: string[];
}

export interface WorkspaceClassification {
	changedFiles: string[];
	workspaceWarnings: string[];
}

// changedFiles = tracked task edits + untracked real source (new files that are
// neither chit state nor a recognized artifact). workspaceWarnings = untracked
// generated artifacts, labeled. chit-owned paths are dropped from both. Order is
// stable: tracked first (in input order, deduped), then untracked real source.
export function classifyWorkspace(snap: WorkspaceSnapshot): WorkspaceClassification {
	const changed = new Set<string>();
	for (const f of snap.tracked) {
		if (!isChitOwned(f)) changed.add(f);
	}
	const workspaceWarnings: string[] = [];
	for (const f of snap.untracked) {
		if (isChitOwned(f)) continue;
		if (isGeneratedArtifact(f)) workspaceWarnings.push(`untracked generated artifact: ${f}`);
		else changed.add(f);
	}
	return { changedFiles: [...changed], workspaceWarnings };
}
