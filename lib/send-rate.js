import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import { LIMITS } from "./config.js";

// Each way of sending has one rate for every customer: a lane (SES's account rate, or PostShiba's bulk
// cluster and its REST send budget, lib/email-provider). Each instance spaces its own sends, and with
// Upstash, all instances share one count too. Without Redis, or while it's down, only the spacing applies:
// concurrent instances could go over, and the provider throttles them (those sends are retried).
const MAX_WAIT_MS = 30_000;
const RETRY_UPSTASH_AFTER_MS = 60_000;
const REPORT_EVERY_MS = 30 * 60_000;
const lanes = new Map();
let upstashDownUntil = 0;
let lastReportAt = 0;

function getLane(name) {
	if (!lanes.has(name)) lanes.set(name, { nextSendAt: 0, shared: null });
	return lanes.get(name);
}

// SES keeps the prefix it always had.
function getPrefix(name) {
	return name === "ses" ? "mailcheap/ses-rate" : `mailcheap/send-rate-${name}`;
}

function getSharedLimiter(lane, name, rate) {
	const { UPSTASH_REDIS_REST_URL: url, UPSTASH_REDIS_REST_TOKEN: token } = process.env;
	if (!url || !token) return null;
	if (lane.shared?.rate !== rate) {
		const limiter = new Ratelimit({ redis: new Redis({ url, token, retry: false }), limiter: Ratelimit.slidingWindow(rate, "1 s"), prefix: getPrefix(name) });
		lane.shared = { rate, limiter };
	}
	return lane.shared.limiter;
}

// Slots are reserved synchronously, so concurrent sends in one instance share the rate.
async function waitLocally(lane, rate) {
	const now = Date.now();
	const sendAt = Math.max(now, lane.nextSendAt);
	lane.nextSendAt = sendAt + Math.ceil(1000 / rate);
	if (sendAt > now) await new Promise((resolve) => setTimeout(resolve, sendAt - now));
}

// failClosed (maiteam, PATCHES.md P4): without a shared count, or when it can't be read, nothing is sent.
export async function waitForSendSlot({ name = "ses", rate = LIMITS.sendRatePerSecond, failClosed = false } = {}) {
	const lane = getLane(name);
	await waitLocally(lane, rate);
	const limiter = (failClosed || Date.now() >= upstashDownUntil) && getSharedLimiter(lane, name, rate);
	if (!limiter) {
		if (failClosed) throw Object.assign(new Error("The shared send rate isn't configured, so nothing is sent"), { name: "Throttling" });
		return;
	}
	let result;
	try {
		result = await limiter.blockUntilReady(name, MAX_WAIT_MS);
	} catch (error) {
		if (failClosed) throw Object.assign(new Error(`The shared send rate couldn't be read, so nothing is sent: ${error.message}`), { name: "Throttling" });
		upstashDownUntil = Date.now() + RETRY_UPSTASH_AFTER_MS;
		if (Date.now() - lastReportAt > REPORT_EVERY_MS) {
			lastReportAt = Date.now();
			console.error("[send-rate] Upstash unavailable, spacing sends per instance only:", error.message);
		}
		return;
	}
	if (!result.success) throw Object.assign(new Error("Every sending slot is taken, retrying later"), { name: "Throttling" });
}
