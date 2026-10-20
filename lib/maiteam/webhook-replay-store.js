// maiteam (PATCHES.md P6): the waitlist webhooks' replay store.
import crypto from "node:crypto";
import { Redis } from "@upstash/redis";

// Each script acts only while the key still holds this delivery's claim, so a slow original whose lease
// ran out cannot free or overwrite a later delivery's claim.
const RELEASE = `if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) end return 0`;
const COMPLETE = `if redis.call("GET", KEYS[1]) == ARGV[1] then redis.call("SET", KEYS[1], ARGV[2], "PX", ARGV[3]) return 1 end return 0`;

let client;
// Tests only: a store in place of Redis. Production never sets it.
let storeForTests = null;

export function setReplayStoreForTests(store) {
	storeForTests = store;
}

// One key per product and event id, in one of two states:
//   processing  `p:<body hash>:<nonce>`, set only if absent, for a short lease while the signup runs;
//   done        `d:<body hash>`, written by the claim holder once the signup has a final answer.
// Only a done event is acknowledged as a duplicate. A delivery that meets a processing claim is told to
// retry, and a claim whose holder crashed simply expires with its lease, so the next retry runs the
// signup again (the signup itself is idempotent per address).
// Missing Redis, a throw, or a timeout is unavailable, and the webhook refuses: there is no memory
// fallback, because a second instance would not see the first one's event ids.
export function redisReplayStore(env = process.env) {
	if (storeForTests) return storeForTests;
	const url = env.UPSTASH_REDIS_REST_URL;
	const token = env.UPSTASH_REDIS_REST_TOKEN;
	if (!url || !token) return null;
	client ??= new Redis({ url, token });
	const keyFor = (product, eventId) => `mailcheap:waitlist:${product}:${eventId}`;
	// Prefixed so the client's JSON deserialization can never turn a value into a number.
	const doneValue = (hash) => `d:${hash}`;
	return {
		// { claimed: true, claim } | { claimed: false, state: "processing" | "done", sameBody } | { unavailable: true }
		async claim({ product, eventId, hash, leaseMs }) {
			try {
				const key = keyFor(product, eventId);
				const claim = `p:${hash}:${crypto.randomBytes(12).toString("base64url")}`;
				const set = await client.set(key, claim, { nx: true, px: leaseMs });
				if (set === "OK") return { claimed: true, claim };
				const existing = await client.get(key);
				const match = typeof existing === "string" ? /^([pd]):([0-9a-f]{64})(?::|$)/.exec(existing) : null;
				if (!match) return { unavailable: true };
				return { claimed: false, state: match[1] === "d" ? "done" : "processing", sameBody: match[2] === hash };
			} catch {
				return { unavailable: true };
			}
		},
		// Records the final answer for this event id. false if the lease was lost or Redis failed; the signup
		// has still happened, and a later replay just runs the idempotent signup again.
		async complete({ product, eventId, hash, claim, ttlMs }) {
			try {
				return (await client.eval(COMPLETE, [keyFor(product, eventId)], [claim, doneValue(hash), String(ttlMs)])) === 1;
			} catch (error) {
				console.error("[waitlist] Could not record a finished event:", error?.message);
				return false;
			}
		},
		async release({ product, eventId, claim }) {
			try {
				await client.eval(RELEASE, [keyFor(product, eventId)], [claim]);
			} catch (error) {
				console.error("[waitlist] Could not release an event claim:", error?.message);
			}
		},
	};
}
