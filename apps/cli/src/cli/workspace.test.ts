import { describe, expect, test } from "bun:test";
import { classifyWorkspace, isChitOwned, isGeneratedArtifact } from "./workspace.ts";

describe("workspace classification", () => {
	test("isChitOwned matches chit control-plane state only", () => {
		expect(isChitOwned(".chit")).toBe(true);
		expect(isChitOwned(".chit/loops/p1.jsonl")).toBe(true);
		expect(isChitOwned("src/chit.ts")).toBe(false);
		expect(isChitOwned("calc.py")).toBe(false);
	});

	test("isGeneratedArtifact matches python bytecode and .DS_Store, not real source", () => {
		expect(isGeneratedArtifact("__pycache__/calc.cpython-314.pyc")).toBe(true);
		expect(isGeneratedArtifact("pkg/__pycache__/m.pyc")).toBe(true);
		expect(isGeneratedArtifact("a/b.pyc")).toBe(true);
		expect(isGeneratedArtifact("a/b.pyo")).toBe(true);
		expect(isGeneratedArtifact(".DS_Store")).toBe(true);
		expect(isGeneratedArtifact("sub/.DS_Store")).toBe(true);
		expect(isGeneratedArtifact("calc.py")).toBe(false);
		expect(isGeneratedArtifact("src/new_module.py")).toBe(false);
	});

	test("tracked edits + new source are changedFiles; artifacts are warnings; chit state is dropped", () => {
		const out = classifyWorkspace({
			tracked: ["calc.py", ".chit/loops/p1.jsonl"],
			untracked: [
				"src/new_module.py", // new source = task work
				"__pycache__/calc.cpython-314.pyc", // generated artifact = warning
				".chit/loops/p2.jsonl", // legacy in-repo chit state = dropped from both
				".DS_Store", // artifact = warning
			],
		});
		expect(out.changedFiles).toEqual(["calc.py", "src/new_module.py"]);
		expect(out.workspaceWarnings).toEqual([
			"untracked generated artifact: __pycache__/calc.cpython-314.pyc",
			"untracked generated artifact: .DS_Store",
		]);
	});

	test("a staged-and-unstaged file is deduped", () => {
		expect(classifyWorkspace({ tracked: ["a.ts", "a.ts"], untracked: [] }).changedFiles).toEqual([
			"a.ts",
		]);
	});

	// The repo config deliberately lives at the repo root (chit.config.json), NOT
	// under .chit/: .chit/** is dropped from changedFiles, so a config there would
	// be invisible to converge review. This pins both halves of that decision.
	test("chit.config.json is a changed file (visible to converge); .chit stays excluded", () => {
		expect(isChitOwned("chit.config.json")).toBe(false);
		const out = classifyWorkspace({
			tracked: ["chit.config.json"],
			untracked: [".chit/loops/p1.jsonl"],
		});
		expect(out.changedFiles).toEqual(["chit.config.json"]);
		expect(out.workspaceWarnings).toEqual([]);
	});

	test("a clean tree yields empty lists", () => {
		expect(classifyWorkspace({ tracked: [], untracked: [] })).toEqual({
			changedFiles: [],
			workspaceWarnings: [],
		});
	});
});
