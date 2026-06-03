import { describe, expect, test } from "bun:test";
import { buildGraphModel, parseManifest, parseRegistry, validationSeverity } from "@chit-run/core";
import {
	appendReference,
	canonicalize,
	canSave,
	deepEqual,
	insertReference,
	isDirty,
	referenceToken,
	removeReference,
	updateParticipantField,
	updateStepField,
} from "./editor.ts";

const REGISTRY = parseRegistry(undefined);

function chit(id: string, description = "a chit"): string {
	return JSON.stringify({
		schema: 1,
		id,
		description,
		inputs: { q: { type: "string" } },
		requires: {},
		participants: { a: { agent: "codex", instructions: "r", session: "stateless" } },
		steps: { s: { call: "a", prompt: "{{ inputs.q }}" } },
		output: "s",
	});
}

function graphFor(raw: string, surface?: "claude-skill" | "cli") {
	return buildGraphModel(parseManifest(JSON.parse(raw)), REGISTRY, surface);
}

describe("deepEqual", () => {
	test("primitives", () => {
		expect(deepEqual(1, 1)).toBe(true);
		expect(deepEqual("a", "a")).toBe(true);
		expect(deepEqual(1, 2)).toBe(false);
		expect(deepEqual(null, null)).toBe(true);
		expect(deepEqual(null, undefined)).toBe(false);
	});

	test("objects are key-order independent", () => {
		expect(deepEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
		expect(deepEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
	});

	test("nested + arrays", () => {
		expect(deepEqual({ a: [1, { x: 2 }] }, { a: [1, { x: 2 }] })).toBe(true);
		expect(deepEqual({ a: [1, 2] }, { a: [2, 1] })).toBe(false);
		expect(deepEqual([1, 2], [1, 2, 3])).toBe(false);
	});

	test("object vs array of same length is not equal", () => {
		expect(deepEqual({ 0: "a" }, ["a"])).toBe(false);
	});
});

describe("canonicalize", () => {
	test("tab-indented, roundtrippable", () => {
		const obj = { schema: 1, id: "x" };
		const text = canonicalize(obj);
		expect(text).toContain("\t");
		expect(JSON.parse(text)).toEqual(obj);
	});

	test("deterministic for the same object", () => {
		const obj = { a: 1, b: { c: 2 } };
		expect(canonicalize(obj)).toBe(canonicalize(obj));
	});
});

describe("isDirty", () => {
	test("draft equal to parsed raw is not dirty even if raw formatting differs", () => {
		const draft = JSON.parse(chit("consult"));
		// raw with extra whitespace / different indentation than draft
		const raw = JSON.stringify(draft, null, 4);
		expect(isDirty(draft, raw)).toBe(false);
	});

	test("changed description is dirty", () => {
		const raw = chit("consult", "original");
		const draft = JSON.parse(raw);
		draft.description = "edited";
		expect(isDirty(draft, raw)).toBe(true);
	});

	test("unparseable raw makes any draft dirty", () => {
		expect(isDirty({ anything: true }, "not json")).toBe(true);
	});
});

describe("updateParticipantField", () => {
	const draft = () => ({
		schema: 1,
		participants: {
			codex: { agent: "codex", instructions: "old role", session: "per_scope" },
			claude: { agent: "claude", instructions: "r", session: "stateless" },
		},
	});

	test("sets a top-level field (instructions) without touching other participants", () => {
		const next = updateParticipantField(draft(), "codex", "instructions", "new instructions");
		const ps = next.participants as Record<string, Record<string, unknown>>;
		expect(ps.codex?.instructions).toBe("new instructions");
		expect(ps.codex?.agent).toBe("codex");
		expect(ps.claude).toEqual({ agent: "claude", instructions: "r", session: "stateless" });
	});

	test("sets session", () => {
		const next = updateParticipantField(draft(), "codex", "session", "stateless");
		const ps = next.participants as Record<string, Record<string, unknown>>;
		expect(ps.codex?.session).toBe("stateless");
	});

	test("filesystem creates the permissions object when absent", () => {
		const next = updateParticipantField(draft(), "codex", "filesystem", "write");
		const ps = next.participants as Record<string, Record<string, unknown>>;
		expect(ps.codex?.permissions).toEqual({ filesystem: "write" });
	});

	test("filesystem merges into an existing permissions object", () => {
		const d = draft();
		(d.participants as Record<string, Record<string, unknown>>).codex.permissions = {
			filesystem: "read_only",
			other: "keep",
		};
		const next = updateParticipantField(d, "codex", "filesystem", "write");
		const ps = next.participants as Record<string, Record<string, unknown>>;
		expect(ps.codex?.permissions).toEqual({ filesystem: "write", other: "keep" });
	});

	test("does not mutate the input draft", () => {
		const d = draft();
		const before = JSON.stringify(d);
		updateParticipantField(d, "codex", "instructions", "changed");
		expect(JSON.stringify(d)).toBe(before);
	});
});

describe("updateStepField", () => {
	const draft = () => ({
		schema: 1,
		steps: {
			ask_codex: { call: "codex", prompt: "old prompt" },
			out: { format: "## codex\n{{ steps.ask_codex.output }}" },
		},
	});

	test("sets a call step's prompt without touching other steps", () => {
		const next = updateStepField(draft(), "ask_codex", "prompt", "new prompt");
		const steps = next.steps as Record<string, Record<string, unknown>>;
		expect(steps.ask_codex?.prompt).toBe("new prompt");
		expect(steps.ask_codex?.call).toBe("codex");
		expect(steps.out).toEqual({ format: "## codex\n{{ steps.ask_codex.output }}" });
	});

	test("sets a format step's format", () => {
		const next = updateStepField(draft(), "out", "format", "## only codex");
		const steps = next.steps as Record<string, Record<string, unknown>>;
		expect(steps.out?.format).toBe("## only codex");
	});

	test("does not mutate the input draft", () => {
		const d = draft();
		const before = JSON.stringify(d);
		updateStepField(d, "ask_codex", "prompt", "changed");
		expect(JSON.stringify(d)).toBe(before);
	});
});

describe("referenceToken", () => {
	test("input source", () => {
		expect(referenceToken("input", "question")).toBe("{{ inputs.question }}");
	});
	test("call source", () => {
		expect(referenceToken("call", "ask_codex")).toBe("{{ steps.ask_codex.output }}");
	});
	test("format source", () => {
		expect(referenceToken("format", "out")).toBe("{{ steps.out.output }}");
	});
});

describe("appendReference", () => {
	test("empty template becomes just the token", () => {
		expect(appendReference("", "{{ inputs.q }}")).toBe("{{ inputs.q }}");
	});
	test("non-empty template gets the token on its own line", () => {
		expect(appendReference("Verify this:", "{{ steps.x.output }}")).toBe(
			"Verify this:\n\n{{ steps.x.output }}",
		);
	});
});

describe("insertReference", () => {
	const draft = () => ({
		schema: 1,
		steps: {
			ask_codex: { call: "codex", prompt: "Answer:" },
			out: { format: "## codex" },
		},
	});

	test("appends an input ref into a call step's prompt", () => {
		const next = insertReference(draft(), "ask_codex", "{{ inputs.question }}");
		const steps = next.steps as Record<string, Record<string, unknown>>;
		expect(steps.ask_codex?.prompt).toBe("Answer:\n\n{{ inputs.question }}");
	});

	test("appends a step ref into a format step's format", () => {
		const next = insertReference(draft(), "out", "{{ steps.ask_codex.output }}");
		const steps = next.steps as Record<string, Record<string, unknown>>;
		expect(steps.out?.format).toBe("## codex\n\n{{ steps.ask_codex.output }}");
	});

	test("is idempotent: re-inserting an existing token returns the draft unchanged", () => {
		const once = insertReference(draft(), "ask_codex", "{{ inputs.question }}");
		const twice = insertReference(once, "ask_codex", "{{ inputs.question }}");
		expect(twice).toBe(once); // same reference, no second append
	});

	test("does not mutate the input draft", () => {
		const d = draft();
		const before = JSON.stringify(d);
		insertReference(d, "ask_codex", "{{ inputs.question }}");
		expect(JSON.stringify(d)).toBe(before);
	});

	test("throws on an unknown step", () => {
		expect(() => insertReference(draft(), "nope", "{{ inputs.q }}")).toThrow(/unknown step/);
	});

	test("throws on a step that is neither call nor format", () => {
		const d = { schema: 1, steps: { weird: { something: true } } };
		expect(() => insertReference(d, "weird", "{{ inputs.q }}")).toThrow(
			/neither a call nor a format/,
		);
	});
});

describe("removeReference", () => {
	test("removes the canonical token and trims the trailing blank line", () => {
		const draft = {
			schema: 1,
			steps: { out: { format: "## claude\n\n{{ steps.ask_claude.output }}" } },
		};
		const { draft: next, removed } = removeReference(draft, "out", "call", "ask_claude");
		expect(removed).toBe(1);
		expect((next.steps as Record<string, Record<string, unknown>>).out?.format).toBe("## claude");
	});

	test("removes whitespace variants (no spaces, extra spaces)", () => {
		const draft = {
			schema: 1,
			steps: { s: { call: "a", prompt: "{{steps.x.output}}\n{{  steps.x.output  }}" } },
		};
		const { removed } = removeReference(draft, "s", "call", "x");
		expect(removed).toBe(2);
	});

	test("removes an input ref", () => {
		const draft = { schema: 1, steps: { s: { call: "a", prompt: "Q: {{ inputs.question }}" } } };
		const { draft: next, removed } = removeReference(draft, "s", "input", "question");
		expect(removed).toBe(1);
		expect((next.steps as Record<string, Record<string, unknown>>).s?.prompt).toBe("Q:");
	});

	test("no match returns the draft unchanged with removed 0", () => {
		const draft = { schema: 1, steps: { s: { call: "a", prompt: "no refs here" } } };
		const result = removeReference(draft, "s", "call", "x");
		expect(result.removed).toBe(0);
		expect(result.draft).toBe(draft);
	});

	test("similar-but-distinct step names are not matched (ask_codex vs ask_codex2)", () => {
		const draft = {
			schema: 1,
			steps: { s: { call: "a", prompt: "{{ steps.ask_codex2.output }}" } },
		};
		const { removed } = removeReference(draft, "s", "call", "ask_codex");
		expect(removed).toBe(0);
	});

	test("collapses to empty when the ref was the whole template (caller's gate rejects)", () => {
		const draft = { schema: 1, steps: { out: { format: "{{ steps.x.output }}" } } };
		const { draft: next, removed } = removeReference(draft, "out", "call", "x");
		expect(removed).toBe(1);
		expect((next.steps as Record<string, Record<string, unknown>>).out?.format).toBe("");
	});

	test("does not mutate the input draft", () => {
		const draft = { schema: 1, steps: { s: { call: "a", prompt: "{{ inputs.q }}" } } };
		const before = JSON.stringify(draft);
		removeReference(draft, "s", "input", "q");
		expect(JSON.stringify(draft)).toBe(before);
	});

	test("throws on an unknown step", () => {
		expect(() => removeReference({ schema: 1, steps: {} }, "nope", "input", "q")).toThrow(
			/unknown step/,
		);
	});
});

describe("canSave", () => {
	const base = (raw: string, surface: "claude-skill" | "cli") => ({
		dirty: true,
		previewPending: false,
		previewError: null,
		conflict: false,
		graphModel: graphFor(raw, surface),
	});

	test("dirty + clean preview + ok validation is saveable", () => {
		// A codex-only chit on claude-skill has no enforcement gap (codex sandboxes),
		// so validation is ok, which is saveable.
		const g = base(chit("consult"), "claude-skill");
		expect(canSave(g)).toBe(true);
	});

	test("not dirty is not saveable", () => {
		expect(canSave({ ...base(chit("c"), "cli"), dirty: false })).toBe(false);
	});

	test("preview pending is not saveable", () => {
		expect(canSave({ ...base(chit("c"), "cli"), previewPending: true })).toBe(false);
	});

	test("preview error is not saveable", () => {
		expect(canSave({ ...base(chit("c"), "cli"), previewError: "boom" })).toBe(false);
	});

	test("conflict is not saveable", () => {
		expect(canSave({ ...base(chit("c"), "cli"), conflict: true })).toBe(false);
	});

	test("warn-severity validation (needs_override) is saveable", () => {
		// No built-in adapter produces a real gap anymore (both enforce read_only), so
		// synthesize a needs_override report to confirm warn severity stays saveable.
		const g = base(chit("w"), "claude-skill");
		const warnG = {
			...g,
			graphModel: {
				...g.graphModel,
				validation: {
					capabilities: { compatible: true, missing: [] },
					permissions: {
						status: "needs_override" as const,
						gaps: [{ participantId: "a", agentId: "codex", permission: "filesystem: read_only" }],
					},
					agents: { resolved: true, unknown: [] },
				},
			},
		};
		expect(validationSeverity(warnG.graphModel.validation)).toBe("warn");
		expect(canSave(warnG)).toBe(true);
	});
});
