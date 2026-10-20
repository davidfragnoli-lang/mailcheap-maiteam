import * as real from "../../lib/maiteam/signup-protection.js";

// maiteam (P5, PATCHES.md): upstream's own tests run the signup paths as upstream ships them, without our checks, the
// way they run without DNS (mail-domains.mjs). tests/maiteam-signup-*.test.mjs turn the real checks on with
// enableSignupProtection(deps): synthetic Cloudflare (fetch), DNS (resolver), Redis (limiter) and clock (now).
let deps = null;

export function enableSignupProtection(next = {}) {
	deps = next;
}

export function disableSignupProtection() {
	deps = null;
}

export const { SIGNUP_LIMITS, TURNSTILE_ACTION } = real;

export function startArchiveSignup() {
	return real.startArchiveSignup(deps ?? {});
}

export async function checkArchiveSignup(formData, context) {
	return deps ? real.checkArchiveSignup(formData, context, deps) : null;
}

export async function checkFormSignup(input) {
	return deps ? real.checkFormSignup(input, deps) : null;
}

export async function checkApiSignup(input) {
	return deps ? real.checkApiSignup(input, deps) : null;
}

export async function checkWaitlistSignup(input) {
	return deps ? real.checkWaitlistSignup(input, deps) : null;
}
