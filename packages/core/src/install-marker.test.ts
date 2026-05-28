import { describe, expect, test } from "bun:test";
import { MarkerError, parseInstallMarker } from "./install-marker.ts";

const VALID = {
	schema: 1,
	surface: "claude-skill",
	installName: "consult",
	manifestId: "consult",
	runtimePath: "/abs/path/handoff",
	installedAt: "2026-05-27T15:41:32.000Z",
	manifestHash: "abc123",
};

describe("parseInstallMarker", () => {
	test("accepts a well-formed marker", () => {
		const m = parseInstallMarker(VALID, "/tmp/x");
		expect(m.installName).toBe("consult");
		expect(m.surface).toBe("claude-skill");
	});

	test("rejects non-object", () => {
		expect(() => parseInstallMarker("nope", "/tmp/x")).toThrow(MarkerError);
		expect(() => parseInstallMarker(["array"], "/tmp/x")).toThrow(MarkerError);
		expect(() => parseInstallMarker(null, "/tmp/x")).toThrow(MarkerError);
	});

	test("rejects unsupported schema version", () => {
		expect(() => parseInstallMarker({ ...VALID, schema: 2 }, "/tmp/x")).toThrow(/marker schema/);
	});

	test("rejects missing required field", () => {
		for (const key of [
			"surface",
			"installName",
			"manifestId",
			"runtimePath",
			"installedAt",
			"manifestHash",
		]) {
			const bad: Record<string, unknown> = { ...VALID };
			delete bad[key];
			expect(() => parseInstallMarker(bad, "/tmp/x")).toThrow(
				new RegExp(`"${key}" must be a non-empty string`),
			);
		}
	});

	test("rejects empty string in required field", () => {
		expect(() => parseInstallMarker({ ...VALID, installName: "" }, "/tmp/x")).toThrow(
			/installName.*non-empty/,
		);
	});

	test("error carries the file path", () => {
		try {
			parseInstallMarker({}, "/some/path/.handoff-install.json");
		} catch (e) {
			if (e instanceof MarkerError) {
				expect(e.path).toBe("/some/path/.handoff-install.json");
			}
		}
	});
});
