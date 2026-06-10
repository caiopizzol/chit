import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type NormalizedConfig, parseConfigLayers } from "@chit-run/core";
import { realGit } from "../batches/worktree.ts";
import {
	digestManifestText,
	ManifestBindingError,
	normalizeManifestReference,
	readJobManifest,
	resolveManifestBindingWith,
	resolveRecipe,
} from "./binding.ts";

// Binding resolution against a REAL git repo: the digest of a repo-relative
// manifest comes from the git tree at the bound commit (never the working tree),
// symlink objects and repo escapes are rejected before any read, an absolute path
// reads the filesystem, and the later filesystem read (the worker) re-verifies the
// digest and refuses symlink escapes.

const roots: string[] = [];
afterAll(() => {
	for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function run(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf-8" });
}

// A minimal valid loop manifest whose body embeds `marker` so two versions differ.
function manifestText(marker: string): string {
	return JSON.stringify(
		{
			schema: 1,
			id: "bind-test",
			description: `binding fixture ${marker}`,
			inputs: {
				task: { type: "string" },
				prior_review: { type: "string", optional: true },
			},
			participants: {
				implementer: {
					agent: "claude",
					instructions: "implement",
					session: "per_scope",
					permissions: { filesystem: "write" },
				},
				reviewer: {
					agent: "codex",
					instructions: "review",
					session: "per_scope",
					permissions: { filesystem: "read_only" },
				},
			},
			steps: {
				implement: { call: "implementer", prompt: "{{ inputs.task }}" },
				review: { call: "reviewer", prompt: "{{ steps.implement.output }}" },
				out: { format: "{{ steps.review.output }}" },
			},
			output: "out",
			policy: { kind: "loop", implementStep: "implement", reviewStep: "review" },
		},
		null,
		"\t",
	);
}

// A real repo with manifests/converge.json committed; returns the repo and the sha.
function makeRepo(): { repo: string; sha: string; committedText: string } {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "chit-binding-")));
	roots.push(root);
	const repo = join(root, "repo");
	mkdirSync(join(repo, "manifests"), { recursive: true });
	run(root, ["init", "-q", repo]);
	run(repo, ["config", "user.email", "test@example.com"]);
	run(repo, ["config", "user.name", "Test"]);
	const committedText = manifestText("v1");
	writeFileSync(join(repo, "manifests", "converge.json"), committedText);
	run(repo, ["add", "-A"]);
	run(repo, ["commit", "-q", "-m", "base"]);
	const sha = run(repo, ["rev-parse", "HEAD"]).trim();
	return { repo, sha, committedText };
}

// Built-ins only: claude + codex resolve, roles/recipes empty.
function config(raw?: Record<string, unknown>): NormalizedConfig {
	return parseConfigLayers(
		raw !== undefined ? [{ raw, path: "/tmp/config.json", source: "global" }] : [],
	);
}

describe("normalizeManifestReference", () => {
	test("a relative path becomes repo-root relative (source git)", () => {
		const { repo } = makeRepo();
		expect(normalizeManifestReference("manifests/converge.json", repo, repo)).toEqual({
			manifestPath: "manifests/converge.json",
			source: "git",
		});
		// Resolved against a subdirectory cwd, still repo-root relative.
		expect(normalizeManifestReference("converge.json", join(repo, "manifests"), repo)).toEqual({
			manifestPath: "manifests/converge.json",
			source: "git",
		});
	});

	test("an absolute path stays itself (source file)", () => {
		const { repo } = makeRepo();
		const abs = join(repo, "manifests", "converge.json");
		expect(normalizeManifestReference(abs, repo, repo)).toEqual({
			manifestPath: abs,
			source: "file",
		});
	});

	test("a relative path escaping the repo is rejected", () => {
		const { repo } = makeRepo();
		expect(() => normalizeManifestReference("../outside.json", repo, repo)).toThrow(
			ManifestBindingError,
		);
	});
});

describe("resolveManifestBindingWith (repo-relative: the git tree is the read point)", () => {
	test("digests the COMMITTED content, not the dirty working tree", () => {
		const { repo, sha, committedText } = makeRepo();
		// Dirty the working tree AFTER the commit: the binding must not see this.
		writeFileSync(join(repo, "manifests", "converge.json"), manifestText("dirty-edit"));
		const binding = resolveManifestBindingWith(
			{ manifestPath: "manifests/converge.json", baseSha: sha, gitCwd: repo, configCwd: repo },
			{ git: realGit, config: config() },
		);
		expect(binding.source).toBe("git");
		expect(binding.manifestDigest).toBe(digestManifestText(committedText));
		expect(binding.manifestDigest).not.toBe(digestManifestText(manifestText("dirty-edit")));
	});

	test("a commit that edits the manifest changes the digest at the new sha", () => {
		const { repo, sha } = makeRepo();
		writeFileSync(join(repo, "manifests", "converge.json"), manifestText("v2"));
		run(repo, ["add", "-A"]);
		run(repo, ["commit", "-q", "-m", "edit manifest"]);
		const sha2 = run(repo, ["rev-parse", "HEAD"]).trim();
		const at = (s: string) =>
			resolveManifestBindingWith(
				{ manifestPath: "manifests/converge.json", baseSha: s, gitCwd: repo, configCwd: repo },
				{ git: realGit, config: config() },
			).manifestDigest;
		expect(at(sha2)).not.toBe(at(sha));
	});

	test("the participant summary is safe: ids, agents, adapters, permissions; no instructions or prompts", () => {
		const { repo, sha } = makeRepo();
		const binding = resolveManifestBindingWith(
			{ manifestPath: "manifests/converge.json", baseSha: sha, gitCwd: repo, configCwd: repo },
			{ git: realGit, config: config() },
		);
		expect(Object.keys(binding.participants).sort()).toEqual(["implementer", "reviewer"]);
		const impl = binding.participants.implementer;
		expect(impl?.agentId).toBe("claude");
		expect(impl?.adapter).toBe("claude-cli");
		expect(impl?.session).toBe("per_scope");
		expect(impl?.permissions).toEqual({ filesystem: "write" });
		// Never instructions, prompts, or env VALUES (envKeys, when present, is names only).
		const serialized = JSON.stringify(binding);
		expect(serialized).not.toContain("instructions");
		expect(serialized).not.toContain("{{ inputs.task }}");
	});

	test("a role-referencing participant records the role and config provenance", () => {
		const { repo, sha } = makeRepo();
		writeFileSync(
			join(repo, "manifests", "role.json"),
			JSON.stringify({
				schema: 1,
				id: "role-test",
				description: "role fixture",
				inputs: { task: { type: "string" } },
				participants: { worker: { role: "scout" } },
				steps: {
					go: { call: "worker", prompt: "{{ inputs.task }}" },
					out: { format: "{{ steps.go.output }}" },
				},
				output: "out",
			}),
		);
		run(repo, ["add", "-A"]);
		run(repo, ["commit", "-q", "-m", "role manifest"]);
		const sha2 = run(repo, ["rev-parse", "HEAD"]).trim();
		const cfg = config({
			agents: { scoutbot: { adapter: "codex-exec" } },
			roles: {
				scout: {
					agent: "scoutbot",
					instructions: "scout it",
					session: "stateless",
					permissions: { filesystem: "read_only" },
				},
			},
		});
		const binding = resolveManifestBindingWith(
			{ manifestPath: "manifests/role.json", baseSha: sha2, gitCwd: repo, configCwd: repo },
			{ git: realGit, config: cfg },
		);
		expect(binding.participants.worker?.role).toBe("scout");
		expect(binding.participants.worker?.agentId).toBe("scoutbot");
		expect(binding.participants.worker?.agentOrigin).toBe("global");
		void sha;
	});

	test("a manifest not in the tree at the sha is refused with a commit hint", () => {
		const { repo, sha } = makeRepo();
		// Present in the working tree only: the read point is the TREE, so it must refuse.
		writeFileSync(join(repo, "manifests", "uncommitted.json"), manifestText("u"));
		expect(() =>
			resolveManifestBindingWith(
				{ manifestPath: "manifests/uncommitted.json", baseSha: sha, gitCwd: repo, configCwd: repo },
				{ git: realGit, config: config() },
			),
		).toThrow(/commit the manifest/);
	});

	test("a symlink OBJECT in the tree is rejected", () => {
		const { repo } = makeRepo();
		symlinkSync("converge.json", join(repo, "manifests", "link.json"));
		run(repo, ["add", "-A"]);
		run(repo, ["commit", "-q", "-m", "symlink"]);
		const sha2 = run(repo, ["rev-parse", "HEAD"]).trim();
		expect(() =>
			resolveManifestBindingWith(
				{ manifestPath: "manifests/link.json", baseSha: sha2, gitCwd: repo, configCwd: repo },
				{ git: realGit, config: config() },
			),
		).toThrow(/symlink/);
	});
});

describe("resolveManifestBindingWith (absolute: the filesystem is the read point)", () => {
	test("digests the file at the path; an edit changes the digest on re-resolve", () => {
		const { repo, sha } = makeRepo();
		const root = realpathSync(mkdtempSync(join(tmpdir(), "chit-binding-abs-")));
		roots.push(root);
		const abs = join(root, "global.json");
		writeFileSync(abs, manifestText("g1"));
		const resolveAbs = () =>
			resolveManifestBindingWith(
				{ manifestPath: abs, baseSha: sha, gitCwd: repo, configCwd: repo },
				{ git: realGit, config: config() },
			);
		const first = resolveAbs();
		expect(first.source).toBe("file");
		expect(first.manifestDigest).toBe(digestManifestText(manifestText("g1")));
		writeFileSync(abs, manifestText("g2"));
		expect(resolveAbs().manifestDigest).not.toBe(first.manifestDigest);
	});
});

describe("readJobManifest (the worker's guarded filesystem read)", () => {
	test("verifies the approved digest and refuses changed bytes", () => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "chit-binding-job-")));
		roots.push(root);
		const path = join(root, "m.json");
		writeFileSync(path, manifestText("j1"));
		const ok = readJobManifest({
			manifestPath: "m.json",
			cwd: root,
			expectedDigest: digestManifestText(manifestText("j1")),
		});
		expect(ok.ok).toBe(true);
		const changed = readJobManifest({
			manifestPath: "m.json",
			cwd: root,
			expectedDigest: digestManifestText(manifestText("OTHER")),
		});
		expect(changed.ok).toBe(false);
		if (!changed.ok) expect(changed.error).toContain("no longer matches the approved content");
	});

	test("rejects a relative path whose symlink escapes the root", () => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "chit-binding-esc-")));
		roots.push(root);
		const inside = join(root, "wt");
		mkdirSync(inside);
		writeFileSync(join(root, "outside.json"), manifestText("x"));
		symlinkSync(join(root, "outside.json"), join(inside, "escape.json"));
		const read = readJobManifest({ manifestPath: "escape.json", cwd: inside });
		expect(read.ok).toBe(false);
		if (!read.ok) expect(read.error).toContain("resolves outside");
	});

	test("a symlink that stays under the root is allowed", () => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "chit-binding-int-")));
		roots.push(root);
		writeFileSync(join(root, "real.json"), manifestText("y"));
		symlinkSync(join(root, "real.json"), join(root, "alias.json"));
		expect(readJobManifest({ manifestPath: "alias.json", cwd: root }).ok).toBe(true);
	});
});

describe("resolveRecipe (substrate only; nothing consumes it at launch yet)", () => {
	test("resolves id, provenance, mode, runtime defaults, and the manifest binding", () => {
		const { repo, sha, committedText } = makeRepo();
		const cfg = config({
			recipes: {
				"deep-feature": {
					mode: "converge",
					manifestPath: "manifests/converge.json",
					maxIterations: 5,
					callTimeoutMs: 60000,
					description: "the loop we trust",
				},
			},
		});
		const recipe = resolveRecipe("deep-feature", cfg, {
			git: realGit,
			repoRoot: repo,
			baseSha: sha,
		});
		expect(recipe.id).toBe("deep-feature");
		expect(recipe.mode).toBe("converge");
		expect(recipe.origin?.source).toBe("global");
		expect(recipe.maxIterations).toBe(5);
		expect(recipe.callTimeoutMs).toBe(60000);
		expect(recipe.description).toBe("the loop we trust");
		expect(recipe.binding.manifestPath).toBe("manifests/converge.json");
		expect(recipe.binding.manifestDigest).toBe(digestManifestText(committedText));
		expect(Object.keys(recipe.binding.participants).sort()).toEqual(["implementer", "reviewer"]);
	});

	test("an unknown recipe id is refused, naming the known ids", () => {
		const { repo, sha } = makeRepo();
		const cfg = config({
			recipes: { known: { mode: "converge", manifestPath: "manifests/converge.json" } },
		});
		expect(() =>
			resolveRecipe("nope", cfg, { git: realGit, repoRoot: repo, baseSha: sha }),
		).toThrow(/known/);
	});
});
