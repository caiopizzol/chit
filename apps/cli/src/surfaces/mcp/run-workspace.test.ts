import { describe, expect, test } from "bun:test";
import { isAbsolute, join } from "node:path";
import { loopMayWriteFiles, planManagedWorkspace, resolveManifestPathAbsolute } from "./server.ts";

// The chit_start managed-worktree dispatch (#85) is a closure inside registerTool,
// not drivable without an MCP transport. These pin its decision logic, extracted into
// pure/injectable helpers, against the exact contract the independent review required
// (F1 read-only not isolated, F2 manifest path absolute from caller, F3a config before
// any worktree).

describe("resolveManifestPathAbsolute (F2): same file for fg + bg, from the caller cwd", () => {
	test("a relative manifest_path resolves against the CALLER cwd, not a worktree", () => {
		const abs = resolveManifestPathAbsolute("chit-manifests/converge.json", "/repo");
		expect(abs).toBe(join("/repo", "chit-manifests/converge.json"));
		expect(isAbsolute(abs)).toBe(true);
	});
	test("an already-absolute path passes through unchanged", () => {
		expect(resolveManifestPathAbsolute("/abs/m.json", "/repo")).toBe("/abs/m.json");
	});
});

describe("loopMayWriteFiles (F1): isolate only a loop that may write", () => {
	const p = (filesystem?: string) => (filesystem ? { permissions: { filesystem } } : {});
	test("any write-capable participant -> may write (isolate)", () => {
		expect(loopMayWriteFiles({ impl: p("write"), rev: p("read_only") })).toBe(true);
	});
	test("every participant provably read_only -> does NOT write (run in place)", () => {
		expect(loopMayWriteFiles({ a: p("read_only"), b: p("read_only") })).toBe(false);
	});
	test("a role-ref (permissions resolved later, absent here) errs toward may-write", () => {
		// permissions undefined at dispatch for a role-ref; the safe direction is to isolate.
		expect(loopMayWriteFiles({ impl: p(undefined), rev: p("read_only") })).toBe(true);
	});
});

describe("planManagedWorkspace: ordering + isolate decision (F1 + F3a)", () => {
	const writeLoop = { impl: { permissions: { filesystem: "write" } } };
	const readOnlyLoop = { a: { permissions: { filesystem: "read_only" } } };

	test("write loop, in_place false -> opens an ISOLATED worktree (inPlace=false)", () => {
		const calls: boolean[] = [];
		planManagedWorkspace(
			{ ensureConfig: () => {}, openWorkspace: (inPlace) => calls.push(inPlace) },
			{ participants: writeLoop, inPlace: false },
		);
		expect(calls).toEqual([false]); // isolated
	});

	test("read-only loop -> runs IN PLACE (inPlace=true), no worktree (F1)", () => {
		const calls: boolean[] = [];
		planManagedWorkspace(
			{ ensureConfig: () => {}, openWorkspace: (inPlace) => calls.push(inPlace) },
			{ participants: readOnlyLoop, inPlace: false },
		);
		expect(calls).toEqual([true]); // in place: nothing to isolate
	});

	test("in_place:true forces the caller checkout even for a write loop", () => {
		const calls: boolean[] = [];
		planManagedWorkspace(
			{ ensureConfig: () => {}, openWorkspace: (inPlace) => calls.push(inPlace) },
			{ participants: writeLoop, inPlace: true },
		);
		expect(calls).toEqual([true]);
	});

	test("a config error fails BEFORE any worktree is opened (F3a: no leak)", () => {
		let opened = false;
		expect(() =>
			planManagedWorkspace(
				{
					ensureConfig: () => {
						throw new Error("bad config");
					},
					openWorkspace: () => {
						opened = true;
						return opened;
					},
				},
				{ participants: writeLoop, inPlace: false },
			),
		).toThrow("bad config");
		expect(opened).toBe(false); // the worktree was never created
	});
});
