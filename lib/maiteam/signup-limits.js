import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

// maiteam (P5, PATCHES.md): public signup limits that fail closed. lib/rate-limit.js counts in process memory while
// Redis is missing or down; for a public signup that lets a flood through on serverless hosts, so a missing Redis, a
// throw or a timeout refuses the signup here and counts nothing. Login and every other limit keep upstream's fallback.

const limiters = new Map();
let redis;
const REPORT_EVERY_MINUTES = 30;
let lastReportAt = 0;

function getLimiter({ name, limit, window }) {
	const { UPSTASH_REDIS_REST_URL: url, UPSTASH_REDIS_REST_TOKEN: token } = process.env;
	if (!url || !token) return null;
	redis ??= new Redis({ url, token });
	if (!limiters.has(name)) {
		limiters.set(name, new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(limit, window), prefix: `mailcheap/${name}` }));
	}
	return limiters.get(name);
}

// At most every 30 minutes per server instance. The admin alert shares upstream's kind and cooldown.
async function reportUnavailable(name, error) {
	if (Date.now() - lastReportAt < REPORT_EVERY_MINUTES * 60_000) return;
	lastReportAt = Date.now();
	console.error(`[signup-limits] ${name} unavailable, refusing signups:`, error.message);
	try {
		const [{ after }, { sendAlert }] = await Promise.all([import("next/server"), import("../alerts.js")]);
		after(() =>
			sendAlert({
				key: "rate-limit-unavailable",
				title: "Rate limiter unavailable",
				detail: `Upstash Redis failed (${error.message}). Public signups are refused until it's back.`,
				action: "Check the database and its token in Upstash's console.",
				link: "https://console.upstash.com/redis",
				cooldownMinutes: REPORT_EVERY_MINUTES,
			})
		);
	} catch (alertError) {
		console.error("[signup-limits] Alert failed:", alertError.message);
	}
}

// { limited, unavailable }. unavailable: no answer from Redis, so the signup is refused.
export async function isSignupLimited({ name, limit, window, key }, limiter = getLimiter({ name, limit, window })) {
	if (!limiter) return { limited: true, unavailable: true };
	try {
		const { success, reason } = await limiter.limit(key);
		// Upstash lets a request through when Redis doesn't answer in time.
		if (reason === "timeout") throw new Error("Redis timed out");
		return { limited: !success, unavailable: false };
	} catch (error) {
		await reportUnavailable(name, error);
		return { limited: true, unavailable: true };
	}
}
