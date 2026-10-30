import crypto from "node:crypto";

// Redis's semantics in memory: a claim set only if absent with a lease, then done, or released.
export function memoryReplayStore() {
	const keys = new Map();
	const live = (key) => {
		const entry = keys.get(key);
		if (entry && entry.expiresAt <= Date.now()) keys.delete(key);
		return keys.get(key);
	};
	return {
		keys,
		async claim({ product, eventId, hash, leaseMs }) {
			const key = `${product}:${eventId}`;
			const existing = live(key);
			if (!existing) {
				const claim = `p:${hash}:${crypto.randomBytes(6).toString("hex")}`;
				keys.set(key, { value: claim, expiresAt: Date.now() + leaseMs });
				return { claimed: true, claim };
			}
			const [state, storedHash] = existing.value.split(":");
			return { claimed: false, state: state === "d" ? "done" : "processing", sameBody: storedHash === hash };
		},
		async complete({ product, eventId, hash, claim, ttlMs }) {
			const key = `${product}:${eventId}`;
			if (live(key)?.value !== claim) return false;
			keys.set(key, { value: `d:${hash}`, expiresAt: Date.now() + ttlMs });
			return true;
		},
		async release({ product, eventId, claim }) {
			const key = `${product}:${eventId}`;
			if (live(key)?.value === claim) keys.delete(key);
		},
	};
}
