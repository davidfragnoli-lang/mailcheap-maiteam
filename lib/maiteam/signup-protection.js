import "server-only";
import { normalizeEmail } from "../validation.js";
import { EMAIL_MESSAGES, checkSignupEmail, screenSignupEmail } from "./email-check.js";
import { checkFormStamp, issueFormStamp, readTurnstileConfig, verifyTurnstile } from "./human-check.js";
import { isSignupLimited } from "./signup-limits.js";

// maiteam (P5, PATCHES.md): the checks our deployment adds to public subscriber signup, on top of upstream's (BotID,
// honeypot, typo list, trap addresses, global suppressions, MX, embed limits), which all still run: the stricter rule
// wins. Each hook runs before the contact is written or any mail is queued, and answers null when the signup may go on.
// `deps` replaces the outside services in tests (Cloudflare's fetch, the DNS resolver, the Redis limiter, the clock).

// Must match the action the archive form gives the widget (lib/maiteam/use-signup-protection.js).
export const TURNSTILE_ACTION = "archive-signup";
const PAUSED = "Signups are paused. Try again in a few minutes.";
const TOO_MANY = "Too many signups from your network. Try again in a few minutes.";

// Counted under their own names, at the sizes of upstream's limits on the same paths, so neither counts a signup twice.
export const SIGNUP_LIMITS = {
	archivePerVisitor: { name: "maiteam-subscribe-ip", limit: 5, window: "10 m" },
	formPerVisitor: { name: "maiteam-embed-ip", limit: 5, window: "10 m" },
	apiPerKey: { name: "maiteam-api-contacts-key", limit: 600, window: "1 h" },
	apiPerVisitor: { name: "maiteam-api-contacts-ip", limit: 5, window: "10 m" },
	// P6: the signed waitlist webhooks, per product and per visitor, at the old fork's sizes.
	waitlistPerProduct: { name: "maiteam-waitlist-product", limit: 600, window: "1 h" },
	waitlistPerVisitor: { name: "maiteam-waitlist-ip", limit: 5, window: "10 m" },
};

const HUMAN_MESSAGES = {
	missing: "Please wait for the security check to finish, then try again.",
	invalid: "The security check didn't pass. Reload the page and try again.",
	hostname: "The security check didn't pass. Reload the page and try again.",
	action: "The security check didn't pass. Reload the page and try again.",
	unavailable: "We couldn't run the security check just now. Try again in a minute.",
};
const STAMP_MESSAGES = {
	too_fast: "That was quick. Wait a moment, then press Subscribe again.",
	expired: "This page has been open a while. Press Subscribe again.",
	missing: "Reload the page and try again.",
	invalid: "Reload the page and try again.",
};

function suggestionMessage(suggestion) {
	return `Did you mean ${suggestion}?`;
}

// Signs when the archive form appeared. Archive pages are cached, so the stamp can't be rendered into them.
export function startArchiveSignup(deps = {}) {
	const config = readTurnstileConfig();
	return { stamp: config ? issueFormStamp(config.secret, deps.now?.()) : null };
}

// The archive form: Turnstile for the exact host and action, the signed fill stamp, the address checks and a per-visitor
// limit that fails closed. Without Turnstile's secret and hostnames, every signup is refused. Answers the form's state:
// { error, suggestion?, typed?, restart? }, or null.
export async function checkArchiveSignup(formData, { clientIp }, deps = {}) {
	const typed = formData.get("email");
	const config = readTurnstileConfig();
	if (!config) return { error: PAUSED };

	const stamp = checkFormStamp(formData.get("started"), config.secret, deps.now?.() ?? Date.now());
	if (stamp !== "ok") return { error: STAMP_MESSAGES[stamp], restart: true };

	// A likely typo is answered before the security check spends its token.
	const keepAsTyped = formData.get("keepAsTyped");
	const screened = screenSignupEmail(typed, { keepAsTyped });
	if (!screened.ok) return archiveEmailRefusal(screened, typed);

	const human = await verifyTurnstile(
		{
			token: formData.get("cf-turnstile-response"),
			secret: config.secret,
			hostnames: config.hostnames,
			action: TURNSTILE_ACTION,
			remoteIp: clientIp,
		},
		{ fetch: deps.fetch }
	);
	if (human !== "ok") return { error: HUMAN_MESSAGES[human] };

	const perVisitor = await isSignupLimited({ ...SIGNUP_LIMITS.archivePerVisitor, key: clientIp }, deps.limiter);
	if (perVisitor.unavailable) return { error: PAUSED };
	if (perVisitor.limited) return { error: TOO_MANY };

	const checked = await checkSignupEmail(typed, { keepAsTyped, resolver: deps.resolver });
	return checked.ok ? null : archiveEmailRefusal(checked, typed);
}

function archiveEmailRefusal({ code, suggestion }, typed) {
	return suggestion ? { error: EMAIL_MESSAGES.suggestion, suggestion, typed: normalizeEmail(typed) } : { error: EMAIL_MESSAGES[code] };
}

// The forms on other sites (app/api/embed): a per-visitor limit that fails closed and the address checks. They have no
// way to keep an address as typed, so a likely typo is refused with the suggestion. { status, message }, or null.
export async function checkFormSignup({ email, clientIp }, deps = {}) {
	const perVisitor = await isSignupLimited({ ...SIGNUP_LIMITS.formPerVisitor, key: clientIp }, deps.limiter);
	if (perVisitor.unavailable) return { status: 503, message: PAUSED };
	if (perVisitor.limited) return { status: 429, message: TOO_MANY };
	const checked = await checkSignupEmail(email, { resolver: deps.resolver });
	if (checked.ok) return null;
	if (checked.code === "unavailable") return { status: 503, message: EMAIL_MESSAGES.unavailable };
	return { status: 400, message: checked.suggestion ? suggestionMessage(checked.suggestion) : EMAIL_MESSAGES[checked.code] };
}

// add_contact from the REST API and MCP: per-key and per-visitor limits that fail closed, and the address checks. No
// Turnstile: the caller's site runs its own bot checks, and nothing in the input skips a check. { code, message }, with
// an action error code, or null.
export async function checkApiSignup({ email, keepAsTyped, apiKey, connection, ip }, deps = {}) {
	const caller = apiKey ? String(apiKey._id) : connection ? `oauth-${connection.id}` : null;
	if (caller) {
		const perKey = await isSignupLimited({ ...SIGNUP_LIMITS.apiPerKey, key: caller }, deps.limiter);
		if (perKey.unavailable) return { code: "unavailable", message: "Signups are paused, try again later" };
		if (perKey.limited) return { code: "rate_limited", message: "Too many signups, try again later" };
		if (ip) {
			const perVisitor = await isSignupLimited({ ...SIGNUP_LIMITS.apiPerVisitor, key: `${caller}:${ip}` }, deps.limiter);
			if (perVisitor.unavailable) return { code: "unavailable", message: "Signups are paused, try again later" };
			if (perVisitor.limited) return { code: "rate_limited", message: "Too many signups from this visitor, try again later" };
		}
	}
	const checked = await checkSignupEmail(email, { keepAsTyped, resolver: deps.resolver });
	if (checked.ok) return null;
	if (checked.code === "unavailable") return { code: "unavailable", message: EMAIL_MESSAGES.unavailable };
	return { code: "validation_failed", message: checked.suggestion ? suggestionMessage(checked.suggestion) : EMAIL_MESSAGES[checked.code] };
}

// The signed waitlist webhooks (P6, app/api/webhooks/waitlist): per-product and per-visitor limits that fail closed, and
// the address checks, as for add_contact. No way to keep an address as typed: a likely typo is refused with the
// suggestion. { status, message }, or null.
export async function checkWaitlistSignup({ email, product, ip }, deps = {}) {
	const perProduct = await isSignupLimited({ ...SIGNUP_LIMITS.waitlistPerProduct, key: product }, deps.limiter);
	if (perProduct.unavailable) return { status: 503, message: "Signups are paused, try again later" };
	if (perProduct.limited) return { status: 429, message: "Too many signups, try again later" };
	if (ip) {
		const perVisitor = await isSignupLimited({ ...SIGNUP_LIMITS.waitlistPerVisitor, key: `${product}:${ip}` }, deps.limiter);
		if (perVisitor.unavailable) return { status: 503, message: "Signups are paused, try again later" };
		if (perVisitor.limited) return { status: 429, message: "Too many signups from this visitor, try again later" };
	}
	const checked = await checkSignupEmail(email, { resolver: deps.resolver });
	if (checked.ok) return null;
	if (checked.code === "unavailable") return { status: 503, message: EMAIL_MESSAGES.unavailable };
	return { status: 400, message: checked.suggestion ? suggestionMessage(checked.suggestion) : EMAIL_MESSAGES[checked.code] };
}
