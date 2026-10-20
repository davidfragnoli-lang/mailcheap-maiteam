import { createHmac, timingSafeEqual } from "node:crypto";

// Bot checks for the public signup form: a hidden field, a minimum fill time, and Cloudflare Turnstile
// verified on the server. Every check fails closed. Nothing a caller sends (a source label, a flag,
// a client clock) can skip one; only the server's own configuration decides.

export const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
export const MIN_FILL_MS = 3_000;
export const MAX_FORM_AGE_MS = 24 * 3_600_000;
const VERIFY_TIMEOUT_MS = 4_000;
const MAX_TOKEN_LENGTH = 2_048;
// Cloudflare's published test secrets always pass, always fail, or report a spent token. They never
// guard a deployed form.
const TEST_SECRET_PATTERN = /^[123]x0{30,}AA$/;

export function isTestSecret(secret) {
	return TEST_SECRET_PATTERN.test(String(secret ?? ""));
}

export function readTurnstileConfig(env = process.env) {
	const secret = env.TURNSTILE_SECRET_KEY ?? "";
	const hostnames = String(env.TURNSTILE_HOSTNAMES ?? "")
		.split(",")
		.map((host) => host.trim().toLowerCase())
		.filter(Boolean);
	if (!secret || hostnames.length === 0) return null;
	// Any Vercel deployment needs a real widget secret. A local dev server may use a test pair.
	if (isTestSecret(secret) && env.VERCEL_ENV) return null;
	return { secret, hostnames };
}

// The fill-time stamp is signed, so a script can't send an old time. Its key is derived from the
// Turnstile secret: no extra secret to bind, and no form works without that one anyway.
function stampKey(secret) {
	return createHmac("sha256", secret).update("mailcheap:signup-started:v1").digest();
}

function sign(secret, value) {
	return createHmac("sha256", stampKey(secret)).update(value).digest("base64url");
}

export function issueFormStamp(secret, now = Date.now()) {
	const issued = String(Math.floor(now));
	return `${issued}.${sign(secret, issued)}`;
}

// "ok", "missing", "invalid", "too_fast" or "expired".
export function checkFormStamp(stamp, secret, now = Date.now(), { minMs = MIN_FILL_MS, maxMs = MAX_FORM_AGE_MS } = {}) {
	if (typeof stamp !== "string" || !stamp) return "missing";
	const match = /^(\d{1,15})\.([A-Za-z0-9_-]{43})$/.exec(stamp);
	if (!match) return "invalid";
	const expected = Buffer.from(sign(secret, match[1]));
	const given = Buffer.from(match[2]);
	if (expected.length !== given.length || !timingSafeEqual(expected, given)) return "invalid";
	const age = now - Number(match[1]);
	if (age < minMs) return "too_fast";
	if (age > maxMs) return "expired";
	return "ok";
}

// People never see the field; bots fill in every input they find.
export function isHoneypotFilled(value) {
	return typeof value === "string" ? value.length > 0 : value != null;
}

// "ok", "missing", "invalid", "hostname", "action", or "unavailable" when Cloudflare can't answer.
// Hostname and action come from the server's allowlist, never from the request.
export async function verifyTurnstile(
	{ token, secret, hostnames, action, remoteIp },
	{ fetch: fetchImpl = fetch, timeoutMs = VERIFY_TIMEOUT_MS } = {}
) {
	if (typeof token !== "string" || !token) return "missing";
	if (token.length > MAX_TOKEN_LENGTH) return "invalid";

	const body = new URLSearchParams({ secret, response: token });
	if (remoteIp && remoteIp !== "unknown") body.set("remoteip", remoteIp);

	let outcome;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(new Error("Turnstile timed out")), timeoutMs);
	try {
		const response = await fetchImpl(SITEVERIFY_URL, {
			method: "POST",
			body,
			cache: "no-store",
			signal: controller.signal,
		});
		if (!response.ok) return "unavailable";
		outcome = await response.json();
	} catch {
		return "unavailable";
	} finally {
		clearTimeout(timer);
	}
	if (!outcome || typeof outcome !== "object") return "unavailable";

	const codes = Array.isArray(outcome["error-codes"]) ? outcome["error-codes"] : [];
	if (outcome.success !== true) {
		if (codes.includes("internal-error")) return "unavailable";
		// A wrong or missing secret is our fault, not the visitor's: report it as an outage.
		if (codes.some((code) => code.endsWith("-input-secret"))) return "unavailable";
		return "invalid";
	}
	if (!hostnames.includes(String(outcome.hostname ?? "").toLowerCase())) return "hostname";
	if (outcome.action !== action) return "action";
	return "ok";
}
