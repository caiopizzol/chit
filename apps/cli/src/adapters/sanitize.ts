const SENSITIVE_KEY = /key|token|secret|password|auth/i;

export function findSensitiveValues(env: Record<string, string> | undefined): string[] {
	if (!env) return [];
	const out: string[] = [];
	for (const [k, v] of Object.entries(env)) {
		if (v && v.length > 0 && SENSITIVE_KEY.test(k)) out.push(v);
	}
	return out;
}

export function sanitize(s: string, sensitiveValues: string[]): string {
	let out = s;
	for (const v of sensitiveValues) {
		if (!v) continue;
		out = out.split(v).join("<redacted>");
	}
	return out;
}
