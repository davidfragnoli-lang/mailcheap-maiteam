import assert from "node:assert/strict";
import { test } from "node:test";
import { isSignupLimited } from "../lib/maiteam/signup-limits.js";

// maiteam (P5): public signup limits fail closed; upstream's other limits keep their memory fallback
// (tests/rate-limit.test.mjs).
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;

const SIGNUP = { name: "test-signup", limit: 100, window: "1 h" };

test("public signup fails closed for a missing, failing, or timed-out Redis burst, and counts nothing in memory", async (t) => {
	t.mock.method(console, "error", () => {});
	const unconfigured = await Promise.all(Array.from({ length: 20 }, (_, index) => isSignupLimited({ ...SIGNUP, key: `unset-${index}` })));
	assert.ok(unconfigured.every((result) => result.limited && result.unavailable), "no Redis env");
	const missing = await Promise.all(Array.from({ length: 20 }, (_, index) => isSignupLimited({ ...SIGNUP, key: `missing-${index}` }, null)));
	assert.ok(missing.every((result) => result.limited && result.unavailable));

	const failing = { limit: async () => Promise.reject(new Error("fetch failed")) };
	const errored = await Promise.all(Array.from({ length: 20 }, () => isSignupLimited({ ...SIGNUP, key: "down" }, failing)));
	assert.ok(errored.every((result) => result.limited && result.unavailable));

	const timingOut = { limit: async () => ({ success: true, reason: "timeout" }) };
	const timedOut = await Promise.all(Array.from({ length: 20 }, () => isSignupLimited({ ...SIGNUP, key: "slow" }, timingOut)));
	assert.ok(timedOut.every((result) => result.limited && result.unavailable));

	const reports = console.error.mock.calls.filter(({ arguments: [message] }) => /unavailable, refusing signups/.test(message));
	assert.equal(reports.length, 1, "an outage is reported at most every 30 minutes, not on every request");
});

test("while Redis answers, its answer decides, over-limit included", async () => {
	const allowing = { limit: async () => ({ success: true }) };
	assert.deepEqual(await isSignupLimited({ ...SIGNUP, key: "up" }, allowing), { limited: false, unavailable: false });
	const refusing = { limit: async () => ({ success: false }) };
	assert.deepEqual(await isSignupLimited({ ...SIGNUP, key: "full" }, refusing), { limited: true, unavailable: false });
});
