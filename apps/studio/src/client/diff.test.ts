import { describe, expect, test } from "bun:test";
import { hasChanges, lineDiff } from "./diff.ts";

describe("lineDiff", () => {
	test("identical input is all same", () => {
		const rows = lineDiff("a\nb\nc", "a\nb\nc");
		expect(rows.every((r) => r.type === "same")).toBe(true);
		expect(rows.map((r) => r.text)).toEqual(["a", "b", "c"]);
	});

	test("single line changed shows del then add for that line", () => {
		const rows = lineDiff("a\nb\nc", "a\nX\nc");
		// a same, b deleted, X added, c same (order may interleave del/add)
		const types = rows.map((r) => `${r.type}:${r.text}`);
		expect(types).toContain("same:a");
		expect(types).toContain("del:b");
		expect(types).toContain("add:X");
		expect(types).toContain("same:c");
	});

	test("pure addition", () => {
		const rows = lineDiff("a", "a\nb");
		expect(rows).toEqual([
			{ type: "same", text: "a" },
			{ type: "add", text: "b" },
		]);
	});

	test("pure deletion", () => {
		const rows = lineDiff("a\nb", "a");
		expect(rows).toEqual([
			{ type: "same", text: "a" },
			{ type: "del", text: "b" },
		]);
	});

	test("preserves unchanged surrounding lines when a middle line changes", () => {
		const before = '{\n\t"description": "old",\n\t"id": "x"\n}';
		const after = '{\n\t"description": "new",\n\t"id": "x"\n}';
		const rows = lineDiff(before, after);
		const dels = rows.filter((r) => r.type === "del").map((r) => r.text);
		const adds = rows.filter((r) => r.type === "add").map((r) => r.text);
		expect(dels).toEqual(['\t"description": "old",']);
		expect(adds).toEqual(['\t"description": "new",']);
		// the braces and id line are unchanged
		expect(rows.filter((r) => r.type === "same").map((r) => r.text)).toEqual([
			"{",
			'\t"id": "x"',
			"}",
		]);
	});

	test("empty before is all adds", () => {
		const rows = lineDiff("", "a\nb");
		// "" splits to [""], so one "same" empty line may appear; assert adds present
		expect(rows.some((r) => r.type === "add" && r.text === "a")).toBe(true);
		expect(rows.some((r) => r.type === "add" && r.text === "b")).toBe(true);
	});
});

describe("hasChanges", () => {
	test("true when any add/del present", () => {
		expect(hasChanges(lineDiff("a", "b"))).toBe(true);
	});
	test("false when all same", () => {
		expect(hasChanges(lineDiff("a\nb", "a\nb"))).toBe(false);
	});
});
