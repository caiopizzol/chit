// The single filesystem touch of producer handoff capture, and its trust boundary. The declared
// path is operator-approved and already structurally validated at parse time (no absolute form, no
// traversal, never under .git -- see core's parseHandoffPath), but capture is the point where model
// output becomes a recorded artifact that a later step's prompt may consume, so it re-checks
// containment against the REAL resolved path: a symlink inside the worktree could still point
// outside it, and the durable record is the only thing the runtime trusts here. Refuses anything
// that escapes the worktree root or is not a regular file, enforces the byte cap from the file size
// WITHOUT reading an oversized file, strictly decodes the bytes as UTF-8, and computes the
// "sha256:<hex>" digest over the exact captured bytes (so the digest addresses the on-disk content,
// never a lossily-decoded string). JSON parseability + status projection are the pure caller's
// (plans/handoffs.ts), not here.

import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { HandoffFileRead } from "./handoffs.ts";

function escapes(root: string, target: string): boolean {
	return target !== root && !target.startsWith(root + sep);
}

export function readHandoffFileReal(
	worktreePath: string,
	relPath: string,
	maxBytes: number,
): HandoffFileRead {
	let root: string;
	try {
		root = realpathSync(worktreePath);
	} catch (e) {
		return {
			ok: false,
			status: "invalid",
			error: `step worktree not readable: ${(e as Error).message}`,
		};
	}
	const target = resolve(root, relPath);
	// Cheap containment on the resolved path catches the obvious escape before any stat.
	if (escapes(root, target)) {
		return {
			ok: false,
			status: "invalid",
			error: "declared path resolves outside the step worktree",
		};
	}
	let stat: ReturnType<typeof lstatSync>;
	try {
		// lstat (not stat): a handoff path that is itself a symlink is rejected, never followed.
		stat = lstatSync(target);
	} catch {
		return { ok: false, status: "missing", error: `no file at ${relPath}` };
	}
	if (stat.isSymbolicLink()) {
		return { ok: false, status: "invalid", error: `${relPath} is a symlink, not a regular file` };
	}
	if (!stat.isFile()) {
		return { ok: false, status: "invalid", error: `${relPath} is not a regular file` };
	}
	// A symlinked PARENT directory could still place a regular file outside the worktree; re-resolve
	// the real path and re-check containment before trusting it.
	let real: string;
	try {
		real = realpathSync(target);
	} catch {
		return { ok: false, status: "missing", error: `no file at ${relPath}` };
	}
	if (escapes(root, real)) {
		return {
			ok: false,
			status: "invalid",
			error: "declared path resolves outside the step worktree",
		};
	}
	// Enforce the cap from the stat size first, so an oversized handoff is rejected without reading it.
	if (stat.size > maxBytes) {
		return {
			ok: false,
			status: "invalid",
			error: `exceeds maxBytes (${stat.size} > ${maxBytes})`,
		};
	}
	let buffer: Buffer;
	try {
		// Read raw bytes (no encoding): the digest must address the exact captured bytes, and a strict
		// UTF-8 decode below must see the real bytes, not a lossily-decoded string.
		buffer = readFileSync(target);
	} catch (e) {
		return {
			ok: false,
			status: "invalid",
			error: `could not read ${relPath}: ${(e as Error).message}`,
		};
	}
	// Recheck the cap against the actual bytes: the file may have grown between stat and read, and the
	// captured bytes (not the earlier stat) are what we digest and record.
	if (buffer.length > maxBytes) {
		return {
			ok: false,
			status: "invalid",
			error: `exceeds maxBytes (${buffer.length} > ${maxBytes})`,
		};
	}
	// Decode strictly: invalid UTF-8 is rejected, never silently turned into replacement characters.
	// Otherwise non-text source bytes could decode to a different string that parses as JSON and is
	// digested as content that does not match what is on disk -- the capture must not launder bytes.
	let content: string;
	try {
		content = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
	} catch {
		return { ok: false, status: "invalid", error: `${relPath} is not valid UTF-8` };
	}
	// Digest over the exact captured bytes (not the decoded string), so the receipt addresses the
	// on-disk content byte-for-byte. Same "sha256:<hex>" style as the manifest binding.
	const digest = `sha256:${createHash("sha256").update(buffer).digest("hex")}`;
	return { ok: true, bytes: buffer.length, content, digest };
}
