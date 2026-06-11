import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readHandoffFileReal } from "./read-handoff.ts";

let wt: string;
let outside: string;

beforeEach(() => {
	// realpath the roots so the function's own realpathSync containment check compares like-for-like
	// (macOS routes tmpdir through the /var -> /private/var symlink).
	wt = realpathSync(mkdtempSync(join(tmpdir(), "chit-handoff-wt-")));
	outside = realpathSync(mkdtempSync(join(tmpdir(), "chit-handoff-out-")));
});
afterEach(() => {
	rmSync(wt, { recursive: true, force: true });
	rmSync(outside, { recursive: true, force: true });
});

test("reads a regular file within the worktree, reporting bytes and a digest over those bytes", () => {
	const content = '{"k":1}';
	writeFileSync(join(wt, "findings.json"), content);
	const r = readHandoffFileReal(wt, "findings.json", 1024);
	expect(r).toEqual({
		ok: true,
		bytes: Buffer.byteLength(content),
		content,
		digest: `sha256:${createHash("sha256").update(Buffer.from(content)).digest("hex")}`,
	});
});

test("rejects a file whose bytes are not valid UTF-8 (no silent replacement-char laundering)", () => {
	// `0xff` inside a JSON string decodes to the replacement char under a non-fatal decode and would
	// then parse as valid JSON -- the capture must refuse it instead of digesting transformed content.
	const bytes = Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]);
	writeFileSync(join(wt, "findings.json"), bytes);
	const r = readHandoffFileReal(wt, "findings.json", 1024);
	expect(r.ok).toBe(false);
	if (!r.ok) {
		expect(r.status).toBe("invalid");
		expect(r.error).toContain("not valid UTF-8");
	}
});

test("the digest addresses the exact on-disk bytes, not the decoded string", () => {
	// A multi-byte UTF-8 character: the digest must be over its bytes, which differ from a naive
	// per-code-unit hash of the decoded string.
	const content = '{"emoji":"\u{1f600}"}';
	writeFileSync(join(wt, "findings.json"), content);
	const r = readHandoffFileReal(wt, "findings.json", 1024);
	expect(r.ok).toBe(true);
	if (r.ok) {
		expect(r.digest).toBe(
			`sha256:${createHash("sha256").update(Buffer.from(content)).digest("hex")}`,
		);
	}
});

test("a missing file is reported missing", () => {
	const r = readHandoffFileReal(wt, "findings.json", 1024);
	expect(r.ok).toBe(false);
	if (!r.ok) expect(r.status).toBe("missing");
});

test("a file over maxBytes is rejected as invalid WITHOUT being read", () => {
	writeFileSync(join(wt, "big.json"), "x".repeat(100));
	const r = readHandoffFileReal(wt, "big.json", 10);
	expect(r.ok).toBe(false);
	if (!r.ok) {
		expect(r.status).toBe("invalid");
		expect(r.error).toContain("exceeds maxBytes");
	}
});

test("a symlinked handoff path is rejected (never followed)", () => {
	writeFileSync(join(outside, "secret.json"), '{"secret":true}');
	symlinkSync(join(outside, "secret.json"), join(wt, "findings.json"));
	const r = readHandoffFileReal(wt, "findings.json", 1024);
	expect(r.ok).toBe(false);
	if (!r.ok) {
		expect(r.status).toBe("invalid");
		expect(r.error).toContain("symlink");
	}
});

test("a regular file reached through a symlinked PARENT dir is rejected as escaping", () => {
	const realDir = join(outside, "data");
	mkdirSync(realDir);
	writeFileSync(join(realDir, "findings.json"), '{"k":1}');
	symlinkSync(realDir, join(wt, "link"));
	const r = readHandoffFileReal(wt, "link/findings.json", 1024);
	expect(r.ok).toBe(false);
	if (!r.ok) {
		expect(r.status).toBe("invalid");
		expect(r.error).toContain("outside the step worktree");
	}
});

test("a directory at the declared path is not a regular file", () => {
	mkdirSync(join(wt, "findings.json"));
	const r = readHandoffFileReal(wt, "findings.json", 1024);
	expect(r.ok).toBe(false);
	if (!r.ok) {
		expect(r.status).toBe("invalid");
		expect(r.error).toContain("not a regular file");
	}
});

test("a nested handoff path within the worktree is allowed", () => {
	mkdirSync(join(wt, "out"));
	writeFileSync(join(wt, "out", "findings.json"), '{"k":1}');
	const r = readHandoffFileReal(wt, "out/findings.json", 1024);
	expect(r.ok).toBe(true);
});
