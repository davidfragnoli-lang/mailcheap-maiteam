// maiteam (PATCHES.md P6): signed landing-waitlist webhooks. Decisions only; app/api/webhooks/waitlist/[product]/route.js
// and lib/maiteam/waitlist-signup.js do the I/O.
//
// A product is a fixed server-side mapping to one newsletter (by its slug, unique across accounts, which names the
// account too) and one sequence: the payload can choose neither, and it can't say the person has confirmed. Every
// waitlist signup is a pending contact that gets the confirmation email; the sequence starts only when the confirmation
// link is clicked.
//
// Signature: header `x-waitlist-signature: v1=<base64url HMAC-SHA256>` over `${timestamp}.${product}.${rawBody}`, with
// `x-waitlist-timestamp` in Unix milliseconds. Each product has its own secret, so one product's secret can't sign for
// another. A product is off until it is listed in WAITLIST_WEBHOOK_PRODUCTS and its secret is set; an unlisted or
// unconfigured product answers 404. The product slug `maifortune` is a machine identifier; people see "fortuna".

import crypto from "node:crypto";
import { normalizeEmail } from "../validation.js";

export const WAITLIST_PRODUCTS = Object.freeze({
	maifortune: Object.freeze({
		name: "fortuna waitlist",
		newsletter: "maifortune",
		sequence: "welcome",
		secretEnv: "WAITLIST_SECRET_MAIFORTUNE",
	}),
});

export const MIN_SECRET_LENGTH = 32;
export const MAX_BODY_BYTES = 4096;
// A delivery older than this, or this far ahead of our clock, is refused even with a valid signature.
export const PAST_TOLERANCE_MS = 5 * 60_000;
export const FUTURE_TOLERANCE_MS = 60_000;
// A finished event id is remembered well past the tolerance, so a replay inside the window is always seen.
export const REPLAY_TTL_MS = 48 * 60 * 60_000;
// While a signup runs, its event id is held for this long. It is twice the route's maxDuration, so a live
// original has always answered or been stopped before another delivery can take the event over.
export const CLAIM_LEASE_MS = 60_000;
// Seconds a sender should wait before retrying an event that is still being processed.
export const IN_PROGRESS_RETRY_AFTER_S = 5;

const PRODUCT_PATTERN = /^[a-z0-9-]{1,40}$/;
const EVENT_ID_PATTERN = /^[A-Za-z0-9_-]{8,100}$/;
const SIGNATURE_PATTERN = /^v1=([A-Za-z0-9_-]{43})$/;
const TIMESTAMP_PATTERN = /^\d{13}$/;
const IP_PATTERN = /^[0-9a-f.:]{3,45}$/i;
// Anything else is refused, including `confirmed`, `status`, `consent`, `newsletter`, `sequence` and `resubscribe`.
const ALLOWED_FIELDS = new Set(["eventId", "product", "email", "ip"]);

export function resolveWaitlistProduct(product, env = process.env) {
	if (typeof product !== "string" || !PRODUCT_PATTERN.test(product)) return null;
	const config = Object.hasOwn(WAITLIST_PRODUCTS, product) ? WAITLIST_PRODUCTS[product] : null;
	if (!config) return null;
	const enabled = String(env.WAITLIST_WEBHOOK_PRODUCTS ?? "")
		.split(",")
		.map((item) => item.trim())
		.includes(product);
	const secret = env[config.secretEnv] ?? "";
	if (!enabled || secret.length < MIN_SECRET_LENGTH) return null;
	return { product, ...config, secret };
}

export function signWaitlistBody({ secret, timestamp, product, rawBody }) {
	return `v1=${crypto.createHmac("sha256", secret).update(`${timestamp}.${product}.${rawBody}`).digest("base64url")}`;
}

// { ok: true } or { ok: false, reason } with reason "signature" or "timestamp".
export function verifyWaitlistSignature({ secret, product, timestamp, signature, rawBody, now }) {
	const match = typeof signature === "string" ? SIGNATURE_PATTERN.exec(signature) : null;
	if (!match || typeof timestamp !== "string" || !TIMESTAMP_PATTERN.test(timestamp)) return { ok: false, reason: "signature" };
	const expected = Buffer.from(signWaitlistBody({ secret, timestamp, product, rawBody }).slice(3));
	const provided = Buffer.from(match[1]);
	if (expected.length !== provided.length || !crypto.timingSafeEqual(expected, provided)) {
		return { ok: false, reason: "signature" };
	}
	const sentAt = Number(timestamp);
	if (now - sentAt > PAST_TOLERANCE_MS || sentAt - now > FUTURE_TOLERANCE_MS) return { ok: false, reason: "timestamp" };
	return { ok: true };
}

export function bodyHash(rawBody) {
	return crypto.createHash("sha256").update(rawBody).digest("hex");
}

// The signed JSON, read strictly. The product in the body must be the product in the path.
export function parseWaitlistPayload(rawBody, product) {
	let body;
	try {
		body = JSON.parse(rawBody);
	} catch {
		return { error: "Send a JSON object" };
	}
	if (typeof body !== "object" || body === null || Array.isArray(body)) return { error: "Send a JSON object" };
	const unknown = Object.keys(body).filter((key) => !ALLOWED_FIELDS.has(key));
	if (unknown.length > 0) return { error: `Unknown field: ${unknown.sort().join(", ")}` };
	if (typeof body.eventId !== "string" || !EVENT_ID_PATTERN.test(body.eventId)) return { error: "eventId is invalid" };
	if (body.product !== product) return { error: "product does not match this webhook", status: 403 };
	const email = normalizeEmail(body.email);
	if (!email) return { error: "email is invalid" };
	if (body.ip !== undefined && (typeof body.ip !== "string" || !IP_PATTERN.test(body.ip))) return { error: "ip is invalid" };
	return { eventId: body.eventId, email, ip: body.ip ?? null };
}

// What the shared signup gets. Newsletter and sequence come from the product, never from the payload,
// and a waitlist signup never reverses an unsubscribe.
export function signupInputFor(config, payload) {
	return {
		slug: config.newsletter,
		sequence: config.sequence,
		email: payload.email,
		source: `waitlist:${config.product}`,
		resubscribe: false,
		ip: payload.ip,
	};
}

// 429 and 5xx leave the event unrecorded so the sender may retry; anything else is final for this event id.
export function isRetryableStatus(status) {
	return status === 429 || status >= 500;
}
