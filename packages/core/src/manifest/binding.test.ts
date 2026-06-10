import { describe, expect, test } from "bun:test";
import {
	type BoundParticipantSummary,
	describeManifestBindingDrift,
	type ManifestBinding,
} from "./binding.ts";

// The drift comparison is what the confirm gate (refusal) and the launch gate
// (needs_human pause) both rely on: equal bindings stay silent, and any material
// change -- path, content digest, or participant execution summary -- is named.

function participant(over: Partial<BoundParticipantSummary> = {}): BoundParticipantSummary {
	return {
		agentId: "claude",
		adapter: "claude-cli",
		session: "per_scope",
		permissions: { filesystem: "write" },
		enforcesReadOnly: false,
		config: { model: "opus" },
		...over,
	};
}

function binding(over: Partial<ManifestBinding> = {}): ManifestBinding {
	return {
		manifestPath: "manifests/converge.json",
		source: "git",
		manifestDigest: "sha256:aaaa",
		participants: { implementer: participant() },
		...over,
	};
}

describe("describeManifestBindingDrift", () => {
	test("identical bindings report no drift, regardless of key order", () => {
		const approved = binding();
		const reordered: ManifestBinding = JSON.parse(
			JSON.stringify({
				participants: approved.participants,
				manifestDigest: approved.manifestDigest,
				source: approved.source,
				manifestPath: approved.manifestPath,
			}),
		);
		expect(describeManifestBindingDrift(approved, reordered)).toBeUndefined();
	});

	test("a changed content digest is drift, naming both digests", () => {
		const drift = describeManifestBindingDrift(
			binding(),
			binding({ manifestDigest: "sha256:bbbb" }),
		);
		expect(drift).toContain("manifest content changed");
		expect(drift).toContain("sha256:aaaa");
		expect(drift).toContain("sha256:bbbb");
	});

	test("a changed manifest path is drift", () => {
		const drift = describeManifestBindingDrift(
			binding(),
			binding({ manifestPath: "manifests/other.json" }),
		);
		expect(drift).toContain("manifest path changed");
	});

	test("a changed participant summary is drift, naming the participant", () => {
		const drift = describeManifestBindingDrift(
			binding(),
			binding({ participants: { implementer: participant({ config: { model: "haiku" } }) } }),
		);
		expect(drift).toContain("participant execution summary changed");
		expect(drift).toContain("implementer");
	});

	test("an added or removed participant is drift", () => {
		const drift = describeManifestBindingDrift(
			binding(),
			binding({
				participants: { implementer: participant(), reviewer: participant({ agentId: "codex" }) },
			}),
		);
		expect(drift).toContain("reviewer");
	});
});
