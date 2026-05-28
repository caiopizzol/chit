import type { NormalizedManifest, NormalizedRegistry } from "@chit/core";
import type { AdapterCallRequest, AdapterMap, RuntimeAdapter } from "../runtime/types.ts";
import { computeFingerprint } from "./fingerprint.ts";
import type { SessionKey, SessionStore } from "./types.ts";

// Wraps an AdapterMap with session load/save behavior for participants
// declaring `session: per_scope`. Participants with other session policies
// pass through unchanged.
//
// The runtime never sees this layer. From `executeManifest`'s perspective,
// it's still receiving the same shape of adapters; the wrapper handles
// session injection per call.
export function wrapAdaptersWithSessions(
	adapters: AdapterMap,
	manifest: NormalizedManifest,
	registry: NormalizedRegistry,
	scope: string,
	store: SessionStore,
): AdapterMap {
	const fingerprintsByAgent: Record<string, Record<string, string>> = {};
	for (const [participantId, p] of Object.entries(manifest.participants)) {
		if (p.session !== "per_scope") continue;
		const agent = registry.agents[p.agent];
		if (!agent) continue;
		const fp = computeFingerprint({ agent, participant: p });
		const bucket = fingerprintsByAgent[p.agent] ?? {};
		bucket[participantId] = fp;
		fingerprintsByAgent[p.agent] = bucket;
	}

	const out: AdapterMap = {};
	for (const [agentId, adapter] of Object.entries(adapters)) {
		const tracked = fingerprintsByAgent[agentId];
		if (!tracked || Object.keys(tracked).length === 0) {
			out[agentId] = adapter;
			continue;
		}
		out[agentId] = buildSessionAdapter(adapter, manifest.id, scope, tracked, store);
	}
	return out;
}

function buildSessionAdapter(
	inner: RuntimeAdapter,
	manifestId: string,
	scope: string,
	trackedFingerprints: Record<string, string>,
	store: SessionStore,
): RuntimeAdapter {
	return {
		async call(req: AdapterCallRequest) {
			const fingerprint = trackedFingerprints[req.participantId];
			if (!fingerprint) {
				return inner.call(req);
			}
			const key: SessionKey = {
				scope,
				manifestId,
				participantId: req.participantId,
				fingerprint,
			};
			const priorSession = store.load(key);
			const result = await inner.call({ ...req, session: priorSession });
			if (result.session !== undefined) {
				store.save(key, result.session);
			}
			return result;
		},
	};
}
