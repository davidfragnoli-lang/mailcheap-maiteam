import { Resolver } from "node:dns/promises";
import { DISPOSABLE_DOMAINS } from "./disposable-domains-data.js";
import { normalizeEmail } from "../validation.js";

// Signup address checks, in order: syntax, a likely typo of a common mailbox provider, a disposable
// domain, then whether the domain accepts mail. They run before a contact is written or a
// confirmation is queued. No paid validator, and no address is ever rewritten.

const disposable = new Set(DISPOSABLE_DOMAINS);

// A subdomain of a disposable domain is disposable too.
export function isDisposableDomain(domain) {
	const labels = String(domain ?? "").toLowerCase().split(".");
	for (let i = 0; i < labels.length - 1; i++) {
		if (disposable.has(labels.slice(i).join("."))) return true;
	}
	return false;
}

// The providers people mistype most on Swiss and French signups, with the endings they really use.
const PROVIDERS = {
	gmail: ["com"],
	hotmail: ["com", "fr", "ch", "de", "it", "be", "es", "co.uk"],
	outlook: ["com", "fr", "de", "it", "be", "es"],
	bluewin: ["ch"],
};
// Real domains one keystroke away from a provider above. They never get a suggestion.
const REAL_NEIGHBOURS = new Set([
	"email.com",
	"ymail.com",
	"gmx.com",
	"gmx.ch",
	"gmx.de",
	"gmx.fr",
	"gmx.net",
	"googlemail.com",
	"hotmail.co.jp",
	"mail.com",
	"outlook.co.uk",
	"outlook.jp",
]);

// Optimal string alignment distance: a swapped pair ("gmial") counts as one edit.
function editDistance(a, b) {
	const rows = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
	for (let j = 1; j <= b.length; j++) rows[0][j] = j;
	for (let i = 1; i <= a.length; i++) {
		for (let j = 1; j <= b.length; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			rows[i][j] = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + cost);
			if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
				rows[i][j] = Math.min(rows[i][j], rows[i - 2][j - 2] + 1);
			}
		}
	}
	return rows[a.length][b.length];
}

function closestEnding(ending, endings) {
	if (endings.includes(ending)) return ending;
	const scored = endings.map((candidate) => [candidate, editDistance(ending, candidate)]).sort((x, y) => x[1] - y[1]);
	if (scored[0][1] <= 1) return scored[0][0];
	// "gmail.cmo" → "com": a provider with one ending takes it whatever was typed.
	return endings.length === 1 ? endings[0] : null;
}

// The domain the person probably meant, or null. A suggestion is only ever offered; the caller must
// get an explicit choice before the corrected address is used.
export function suggestDomain(domain) {
	const value = String(domain ?? "").toLowerCase();
	if (REAL_NEIGHBOURS.has(value)) return null;
	const dot = value.indexOf(".");
	if (dot <= 0) return null;
	const name = value.slice(0, dot);
	const ending = value.slice(dot + 1);

	let best = null;
	for (const [provider, endings] of Object.entries(PROVIDERS)) {
		const distance = editDistance(name, provider);
		if (distance <= 1 && (!best || distance < best.distance)) best = { provider, endings, distance };
	}
	if (!best) return null;
	const fixedEnding = closestEnding(ending, best.endings);
	if (!fixedEnding) return null;
	const suggestion = `${best.provider}.${fixedEnding}`;
	return suggestion === value ? null : suggestion;
}

export function suggestEmail(email) {
	const at = String(email ?? "").lastIndexOf("@");
	if (at <= 0) return null;
	const domain = suggestDomain(email.slice(at + 1));
	return domain ? `${email.slice(0, at)}@${domain}` : null;
}

const DNS_TIMEOUT_MS = 3_000;
// A domain that does not exist or has no mail host is the address's problem. Anything else is ours.
const NO_DOMAIN_CODES = new Set(["ENOTFOUND", "ENODATA", "NXDOMAIN"]);

function defaultResolver() {
	return new Resolver({ timeout: DNS_TIMEOUT_MS, tries: 2 });
}

async function lookup(resolver, method, domain) {
	try {
		return { records: await resolver[method](domain) };
	} catch (error) {
		return NO_DOMAIN_CODES.has(error?.code) ? { records: [] } : { error };
	}
}

function withTimeout(promise, ms) {
	let timer;
	return Promise.race([
		promise,
		new Promise((resolve) => {
			timer = setTimeout(() => resolve({ error: new Error("DNS timed out") }), ms);
		}),
	]).finally(() => clearTimeout(timer));
}

// "ok", "no_mail" or "unavailable". With no MX, an A or AAAA record is the implicit mail host
// (RFC 5321). A null MX (RFC 7505) says the domain takes no mail.
export async function checkMailDomain(domain, { resolver = defaultResolver(), timeoutMs = DNS_TIMEOUT_MS * 2 } = {}) {
	const mx = await withTimeout(lookup(resolver, "resolveMx", domain), timeoutMs);
	if (mx.error) return "unavailable";
	if (mx.records.length > 0) {
		const hosts = mx.records.filter((record) => record?.exchange && record.exchange !== ".");
		return hosts.length > 0 ? "ok" : "no_mail";
	}
	const [a, aaaa] = await Promise.all([
		withTimeout(lookup(resolver, "resolve4", domain), timeoutMs),
		withTimeout(lookup(resolver, "resolve6", domain), timeoutMs),
	]);
	if (a.records?.length || aaaa.records?.length) return "ok";
	if (a.error || aaaa.error) return "unavailable";
	return "no_mail";
}

export const EMAIL_MESSAGES = {
	invalid: "Enter a valid email",
	disposable: "Please use a permanent address. Throwaway inboxes can't confirm a subscription.",
	no_mail: "That address can't receive email. Check the part after the @.",
	unavailable: "We couldn't check that address just now. Try again in a minute.",
	suggestion: "Did you mean a different address?",
};

// The checks that need no network: { ok: true, email } or { ok: false, code, suggestion? }.
// `keepAsTyped` is the exact address the person confirmed after seeing a suggestion; it only answers
// the suggestion and skips nothing else.
export function screenSignupEmail(raw, { keepAsTyped } = {}) {
	const email = normalizeEmail(raw);
	if (!email) return { ok: false, code: "invalid" };
	// Typo squatters register some of these ("gmial.com" is a throwaway inbox), so the suggestion
	// comes first: the person sees "Did you mean gmail.com?", not a refusal.
	const suggestion = suggestEmail(email);
	if (suggestion && normalizeEmail(keepAsTyped) !== email) return { ok: false, code: "suggestion", suggestion };
	if (isDisposableDomain(email.slice(email.lastIndexOf("@") + 1))) return { ok: false, code: "disposable" };
	return { ok: true, email };
}

// Every check, the mail-domain lookup last.
export async function checkSignupEmail(raw, { keepAsTyped, resolver, timeoutMs } = {}) {
	const screened = screenSignupEmail(raw, { keepAsTyped });
	if (!screened.ok) return screened;
	const { email } = screened;
	const mail = await checkMailDomain(email.slice(email.lastIndexOf("@") + 1), { resolver, timeoutMs });
	if (mail === "unavailable") return { ok: false, code: "unavailable" };
	if (mail !== "ok") return { ok: false, code: "no_mail" };
	return { ok: true, email };
}
