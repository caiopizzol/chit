export interface SessionKey {
	scope: string;
	manifestId: string;
	participantId: string;
	fingerprint: string;
}

export interface SessionStore {
	load(key: SessionKey): unknown | undefined;
	save(key: SessionKey, payload: unknown): void;
}
