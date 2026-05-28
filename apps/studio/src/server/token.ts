// Launch token. 256 bits of entropy as hex (64 ASCII chars). Compared with
// crypto.timingSafeEqual after an equal-length check to avoid leaking length
// or content via timing.

import { Buffer } from "node:buffer";
import { randomBytes, timingSafeEqual } from "node:crypto";

export function generateToken(): string {
	return randomBytes(32).toString("hex");
}

export function tokensEqual(expected: string, presented: string): boolean {
	if (expected.length !== presented.length) return false;
	const a = Buffer.from(expected, "utf8");
	const b = Buffer.from(presented, "utf8");
	return timingSafeEqual(a, b);
}
