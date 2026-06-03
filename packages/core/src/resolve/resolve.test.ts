import { describe, expect, test } from "bun:test";
import type { NormalizedRole } from "../config/types.ts";
import { parseManifest } from "../manifest/parse.ts";
import { ResolveError, resolveManifest } from "./resolve.ts";
import type { ManifestSpec, ParticipantSpec } from "./types.ts";

// resolveManifest turns a ManifestSpec (role refs and/or inline participants) +
// roles into a ResolvedManifest with every participant concrete. It owns two errors:
// unknown role, and no-agent (a model-agnostic role used without a participant
// agent). Agent existence is NOT its job (findUnknownAgents, on the resolved
// manifest, later). parseManifest is unchanged here; the resolver is built and
// tested in isolation.

// A minimal ManifestSpec with the given participants; the non-participant fields are
// inert for resolution.
function spec(participants: Record<string, ParticipantSpec>): ManifestSpec {
	return {
		schema: 1,
		id: "m",
		description: "d",
		inputs: {},
		declaredRequires: {},
		inferredRequires: {},
		requires: {},
		participants,
		steps: {},
		output: "out",
		policy: { kind: "one-shot" },
		dependencies: {},
		executionOrder: [],
	};
}

const REVIEWER_WITH_AGENT: NormalizedRole = {
	agent: "codex",
	instructions: "Review the diff skeptically.",
	session: "per_scope",
	permissions: { filesystem: "read_only" },
};
const REVIEWER_AGNOSTIC: NormalizedRole = {
	instructions: "Review the diff skeptically.",
	session: "per_scope",
	permissions: { filesystem: "read_only" },
};

describe("resolveManifest: inline participants", () => {
	test("a fully inline participant resolves to itself, no role provenance", () => {
		const r = resolveManifest(
			spec({
				impl: {
					agent: "claude",
					instructions: "Implement.",
					session: "per_scope",
					permissions: { filesystem: "write" },
				},
			}),
			{ roles: {} },
		);
		expect(r.participants.impl).toEqual({
			agent: "claude",
			instructions: "Implement.",
			session: "per_scope",
			permissions: { filesystem: "write" },
			provenance: { overrides: [] },
		});
	});

	test("a real parsed manifest (inline participants) resolves unchanged", () => {
		const m = parseManifest({
			schema: 1,
			id: "consult",
			description: "ask two",
			inputs: { q: { type: "string" } },
			participants: {
				a: { agent: "claude", instructions: "Advisor.", session: "stateless" },
				b: { agent: "codex", instructions: "Advisor.", session: "stateless" },
			},
			steps: {
				ask_a: { call: "a", prompt: "{{ inputs.q }}" },
				ask_b: { call: "b", prompt: "{{ inputs.q }}" },
				out: { format: "{{ steps.ask_a.output }} {{ steps.ask_b.output }}" },
			},
			output: "out",
		});
		const r = resolveManifest(m, { roles: {} });
		expect(r.participants.a?.agent).toBe("claude");
		expect(r.participants.a?.permissions.filesystem).toBe("read_only"); // parser default
		expect(r.participants.b?.provenance).toEqual({ overrides: [] });
	});
});

describe("resolveManifest: role references", () => {
	test("a bare role reference resolves from the role", () => {
		const r = resolveManifest(spec({ reviewer: { role: "reviewer" } }), {
			roles: { reviewer: REVIEWER_WITH_AGENT },
		});
		expect(r.participants.reviewer).toEqual({
			agent: "codex",
			instructions: "Review the diff skeptically.",
			session: "per_scope",
			permissions: { filesystem: "read_only" },
			provenance: { role: "reviewer", overrides: [] },
		});
	});

	test("a participant agent override replaces the role default; provenance records it", () => {
		const r = resolveManifest(spec({ reviewer: { role: "reviewer", agent: "codex-deep" } }), {
			roles: { reviewer: REVIEWER_WITH_AGENT },
		});
		expect(r.participants.reviewer?.agent).toBe("codex-deep");
		expect(r.participants.reviewer?.instructions).toBe("Review the diff skeptically."); // from role
		expect(r.participants.reviewer?.provenance).toEqual({ role: "reviewer", overrides: ["agent"] });
	});

	test("overrides are shallow: a permissions override replaces the whole object", () => {
		const r = resolveManifest(
			spec({ reviewer: { role: "reviewer", permissions: { filesystem: "write" } } }),
			{ roles: { reviewer: REVIEWER_WITH_AGENT } },
		);
		expect(r.participants.reviewer?.permissions).toEqual({ filesystem: "write" });
		expect(r.participants.reviewer?.provenance.overrides).toEqual(["permissions"]);
	});

	test("a model-agnostic role + a participant agent resolves (the agent comes from the participant)", () => {
		const r = resolveManifest(spec({ reviewer: { role: "reviewer", agent: "codex" } }), {
			roles: { reviewer: REVIEWER_AGNOSTIC },
		});
		expect(r.participants.reviewer?.agent).toBe("codex");
		expect(r.participants.reviewer?.provenance).toEqual({ role: "reviewer", overrides: ["agent"] });
	});
});

describe("resolveManifest: recomputes inferred requirements", () => {
	test("a per_scope session hidden behind a role ref surfaces can_provide_stable_scope", () => {
		// The spec's participant references a role; parse could not see the role's
		// per_scope session, so the spec carries no can_provide_stable_scope. Resolution
		// must derive it from the resolved participant.
		const s = spec({ reviewer: { role: "reviewer" } });
		expect(s.requires.can_provide_stable_scope).toBeUndefined(); // not visible pre-resolve
		const r = resolveManifest(s, { roles: { reviewer: REVIEWER_WITH_AGENT } });
		expect(r.requires.can_provide_stable_scope).toBe(true);
		expect(r.inferredRequires.can_provide_stable_scope).toBe(true);
	});

	test("declared requires are preserved through resolution", () => {
		const s = { ...spec({ x: { agent: "claude", instructions: "I.", session: "stateless" } }) };
		s.declaredRequires = { can_show_markdown: true };
		s.requires = { can_show_markdown: true };
		const r = resolveManifest(s, { roles: {} });
		expect(r.requires.can_show_markdown).toBe(true);
		expect(r.declaredRequires.can_show_markdown).toBe(true);
	});
});

describe("resolveManifest: errors", () => {
	test("an unknown role reference is a ResolveError", () => {
		expect(() => resolveManifest(spec({ reviewer: { role: "ghost" } }), { roles: {} })).toThrow(
			/unknown role "ghost"/,
		);
	});

	test("a model-agnostic role used without a participant agent is a ResolveError", () => {
		expect(() =>
			resolveManifest(spec({ reviewer: { role: "reviewer" } }), {
				roles: { reviewer: REVIEWER_AGNOSTIC },
			}),
		).toThrow(/has no default agent and the participant supplied none/);
	});

	test("an inline participant with no agent is a ResolveError", () => {
		let caught: unknown;
		try {
			resolveManifest(spec({ x: { instructions: "I.", session: "per_scope" } }), { roles: {} });
		} catch (e) {
			caught = e;
		}
		expect(caught).toBeInstanceOf(ResolveError);
		expect((caught as ResolveError).participantId).toBe("x");
	});

	// Once parse loosens to allow role refs, an incomplete inline participant becomes a
	// real path (not just hand-built), so the defensive completeness checks matter.
	test("an inline participant missing instructions is a ResolveError", () => {
		expect(() =>
			resolveManifest(spec({ x: { agent: "claude", session: "per_scope" } }), { roles: {} }),
		).toThrow(/has no instructions/);
	});

	test("an inline participant missing session is a ResolveError", () => {
		expect(() =>
			resolveManifest(spec({ x: { agent: "claude", instructions: "I." } }), { roles: {} }),
		).toThrow(/has no session/);
	});

	test("a model-agnostic role with an instructions override but no agent is still a no-agent ResolveError", () => {
		// The participant overrides instructions but supplies no agent, and the role has
		// none: the override does not rescue the missing agent.
		expect(() =>
			resolveManifest(spec({ reviewer: { role: "reviewer", instructions: "Override." } }), {
				roles: { reviewer: REVIEWER_AGNOSTIC },
			}),
		).toThrow(/has no default agent and the participant supplied none/);
	});

	test("agent EXISTENCE is not resolution's job (a bogus agent resolves; findUnknownAgents catches it later)", () => {
		const r = resolveManifest(
			spec({ x: { agent: "nope", instructions: "I.", session: "stateless" } }),
			{
				roles: {},
			},
		);
		expect(r.participants.x?.agent).toBe("nope"); // resolved, not rejected here
	});
});
