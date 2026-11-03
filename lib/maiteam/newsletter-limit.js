// maiteam (PATCHES.md P12): how many newsletters an account has on a self-hosted server. Upstream fixes it at
// MAX_NEWSLETTERS_PER_ACCOUNT (3) in lib/newsletters.js; MAILCHEAP_MAX_NEWSLETTERS_PER_ACCOUNT raises or lowers it
// here. MailCheap Cloud keeps upstream's number whatever the env says: its plans are priced on it.
import { isCloud } from "../config.js";
import { MAX_NEWSLETTERS_PER_ACCOUNT } from "../newsletters.js";

// A positive whole number, written as one ("10", not "10.5", "1e1" or "10 lists"). Anything else is upstream's 3.
export function getMaxNewslettersPerAccount(env = process.env) {
	if (isCloud(env)) return MAX_NEWSLETTERS_PER_ACCOUNT;
	const raw = String(env.MAILCHEAP_MAX_NEWSLETTERS_PER_ACCOUNT ?? "").trim();
	if (!/^\d+$/.test(raw)) return MAX_NEWSLETTERS_PER_ACCOUNT;
	const max = Number(raw);
	return Number.isSafeInteger(max) && max > 0 ? max : MAX_NEWSLETTERS_PER_ACCOUNT;
}

// Upstream's NEWSLETTER_LIMIT_MESSAGE, with this server's number.
export function getNewsletterLimitMessage(max = getMaxNewslettersPerAccount()) {
	return `An account has up to ${max} newsletters`;
}
