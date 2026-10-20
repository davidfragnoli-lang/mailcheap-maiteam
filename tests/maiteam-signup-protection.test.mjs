import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import { activate, as, callApi, catchRedirect, form, signIn, startTestApp, withEnv } from "./helpers/app.mjs";
import { setBotIdVerdict } from "./stubs/botid-server.mjs";
import { disableSignupProtection, enableSignupProtection } from "./stubs/maiteam-signup-protection.mjs";
import { runWithRequest } from "./stubs/next-headers.mjs";
import { flushAfter } from "./stubs/next-server.mjs";

// maiteam (P5, PATCHES.md): the archive form, the forms on other sites and add_contact over the API, with the real
// checks of lib/maiteam/signup-protection.js on top of upstream's. Cloudflare, DNS and Redis are synthetic: nothing
// leaves the process. Every refusal must leave the contacts as they were and queue nothing.

const SECRET = "synthetic-turnstile-secret";
const HOST = "mailcheap.maiteam.ch";
const PASS = { success: true, hostname: HOST, action: "archive-signup" };

const cloudflare = { calls: [], answer: PASS };
const dns = { calls: [] };
const redis = { calls: [], answer: { success: true } };

async function siteverify(url, init) {
	assert.equal(url, "https://challenges.cloudflare.com/turnstile/v0/siteverify");
	cloudflare.calls.push(Object.fromEntries(init.body));
	const { answer } = cloudflare;
	if (answer instanceof Error) throw answer;
	return new Response(JSON.stringify(answer), { status: 200 });
}

const dnsError = (code) => Object.assign(new Error(code), { code });
const ZONE = {
	"gmail.com": { mx: [{ exchange: "gmail-smtp-in.l.google.com", priority: 5 }] },
	"gamil.com": { mx: [{ exchange: "mx.gamil.example", priority: 5 }] },
	"bluewin.ch": { mx: [{ exchange: "mx.bluewin.ch", priority: 5 }] },
	"bluwin.ch": { mx: [{ exchange: "mx.bluwin.example", priority: 5 }] },
	"example.org": { mx: [{ exchange: "mx.example.org", priority: 5 }] },
	"null-mx.example": { mx: [{ exchange: ".", priority: 0 }] },
	"servfail.example": { mx: dnsError("ESERVFAIL") },
};
function answer(type) {
	return async (domain) => {
		dns.calls.push(`${type} ${domain}`);
		const value = ZONE[domain]?.[type];
		if (value instanceof Error) throw value;
		if (value === undefined) throw dnsError(ZONE[domain] ? "ENODATA" : "ENOTFOUND");
		return value;
	};
}
const resolver = { resolveMx: answer("mx"), resolve4: answer("a"), resolve6: answer("aaaa") };

const limiter = {
	async limit(key) {
		redis.calls.push(key);
		const { answer } = redis;
		if (answer instanceof Error) throw answer;
		return answer;
	},
};

let clock = 0;
const now = () => Date.now() + clock;

function reset() {
	cloudflare.calls = [];
	cloudflare.answer = PASS;
	dns.calls = [];
	redis.calls = [];
	redis.answer = { success: true };
	clock = 0;
	enableSignupProtection({ fetch: siteverify, resolver, limiter, now });
}

describe("maiteam signup protection", () => {
	let app;
	let m;
	let owner;
	let newsletter;
	let apiKey;
	let nextIp = 0;

	before(async () => {
		app = await startTestApp({ TURNSTILE_SECRET_KEY: SECRET, TURNSTILE_HOSTNAMES: HOST });
		m = {
			welcome: await import("../app/welcome/actions.js"),
			archive: await import("../app/archive/actions.js"),
			newsletters: await import("../app/(app)/newsletters/actions.js"),
			apiKeys: await import("../app/(app)/api-keys/actions.js"),
			embed: await import("../app/api/embed/[id]/route.js"),
			Contact: (await import("../models/Contact.js")).default,
			Message: (await import("../models/Message.js")).default,
			Newsletter: (await import("../models/Newsletter.js")).default,
		};
		owner = await signIn("p5-owner@example.com");
		await activate(owner);
		await as(owner, () => catchRedirect(m.welcome.completeOnboarding(null, form({ name: "P5 notes" }))));
		newsletter = await m.Newsletter.findOne({ accountId: owner.accountId }).lean();
		const saved = await as(owner, () => m.newsletters.saveSignupForm(newsletter._id, { enabled: true }));
		assert.equal(saved.ok, true, saved.error);
		apiKey = (await as(owner, () => m.apiKeys.createApiKey(null, form({ name: "site", level: "signups" })))).key;
	});

	beforeEach(reset);

	afterEach(() => {
		disableSignupProtection();
		setBotIdVerdict("human");
	});

	after(() => app?.stop());

	const emails = () => m.Contact.find({ accountId: owner.accountId }).distinct("email");
	const messages = () => m.Message.countDocuments({ accountId: owner.accountId });

	// Runs a signup and checks that a refusal left no contact and queued no mail.
	async function refused(label, run) {
		await flushAfter();
		const [before, sentBefore] = [await emails(), await messages()];
		const result = await run();
		await flushAfter();
		assert.deepEqual(await emails(), before, `${label}: contact written`);
		assert.equal(await messages(), sentBefore, `${label}: mail queued`);
		return result;
	}

	async function archive(fields, { ip = `198.18.1.${++nextIp}` } = {}) {
		const values = { newsletter: newsletter.slug, email: "reader@gmail.com", website: "", "cf-turnstile-response": "token-1", ...fields };
		if (!("started" in fields)) {
			clock = -10_000;
			values.started = (await m.archive.startSignup()).stamp;
			clock = 0;
		}
		const data = new FormData();
		for (const [key, value] of Object.entries(values)) if (value !== undefined) data.set(key, value);
		return runWithRequest({ headers: { "x-forwarded-for": ip } }, () => m.archive.subscribe(null, data));
	}

	test("the archive form: honeypot, missing configuration, fill stamp and Turnstile refuse before any write", async (t) => {
		t.mock.method(console, "error", () => {});
		assert.deepEqual(await refused("honeypot", () => archive({ website: "http://spam" })), { ok: true });
		assert.equal(cloudflare.calls.length + redis.calls.length + dns.calls.length, 0);

		for (const env of [{ TURNSTILE_SECRET_KEY: "" }, { TURNSTILE_HOSTNAMES: "" }, { TURNSTILE_SECRET_KEY: "1x0000000000000000000000000000000AA", VERCEL_ENV: "production" }]) {
			const result = await withEnv(env, () => refused(JSON.stringify(env), () => archive({ started: "x" })));
			assert.equal(result.error, "Signups are paused. Try again in a few minutes.");
		}
		assert.equal(cloudflare.calls.length, 0);

		clock = 0;
		const fresh = (await m.archive.startSignup()).stamp;
		assert.match((await refused("too fast", () => archive({ started: fresh }))).error, /quick/);
		assert.equal((await refused("no stamp", () => archive({ started: undefined }))).restart, true);
		assert.match((await refused("forged", () => archive({ started: `${Date.now() - 60_000}.${"A".repeat(43)}` }))).error, /Reload/);
		assert.equal(cloudflare.calls.length, 0, "no token is spent on a bad stamp");

		assert.match((await refused("no token", () => archive({ "cf-turnstile-response": undefined }))).error, /security check/);
		const cases = [
			["bad token", { success: false, "error-codes": ["invalid-input-response"] }, /didn't pass/],
			["other host", { ...PASS, hostname: "copycat.example" }, /didn't pass/],
			["other action", { ...PASS, action: "site-signup" }, /didn't pass/],
			["test key answer", { success: true, hostname: "example.com" }, /didn't pass/],
			["cloudflare down", new Error("ECONNRESET"), /couldn't run the security check/],
		];
		for (const [label, reply, error] of cases) {
			cloudflare.answer = reply;
			assert.match((await refused(label, () => archive({}))).error, error, label);
		}
		assert.equal(redis.calls.length, 0, "the limiter counts only signups past Turnstile");
	});

	test("the archive form fails closed on BotID, Redis and DNS, and refuses throwaway and mailless addresses", async (t) => {
		t.mock.method(console, "error", () => {});
		t.mock.method(console, "warn", () => {});
		await withEnv({ VERCEL: "1" }, async () => {
			setBotIdVerdict("error");
			assert.equal((await refused("botid down", () => archive({}))).error, "Couldn't sign you up. Try again in a minute.");
		});
		setBotIdVerdict("human");
		assert.equal(cloudflare.calls.length, 0);

		enableSignupProtection({ fetch: siteverify, resolver, limiter: null, now });
		assert.equal((await refused("no redis", () => archive({}))).error, "Signups are paused. Try again in a few minutes.");
		enableSignupProtection({ fetch: siteverify, resolver, limiter, now });
		redis.answer = new Error("fetch failed");
		assert.match((await refused("redis error", () => archive({}))).error, /paused/);
		redis.answer = { success: true, reason: "timeout" };
		assert.match((await refused("redis timeout", () => archive({}))).error, /paused/);
		redis.answer = { success: false };
		assert.match((await refused("over limit", () => archive({}))).error, /Too many signups/);
		redis.answer = { success: true };

		dns.calls = [];
		assert.match((await refused("disposable", () => archive({ email: "x@0-mail.com" }))).error, /permanent address/);
		assert.equal(dns.calls.length, 0);
		assert.match((await refused("null mx", () => archive({ email: "x@null-mx.example" }))).error, /can't receive email/);
		assert.match((await refused("no domain", () => archive({ email: "x@nowhere.example" }))).error, /can't receive email/);
		assert.match((await refused("dns down", () => archive({ email: "x@servfail.example" }))).error, /couldn't check that address/);
	});

	test("the archive form suggests a typo, never rewrites it, and keeps it only when asked; upstream's own typo list still wins", async () => {
		cloudflare.calls = [];
		const typo = await refused("bluewin typo", () => archive({ email: "Leser@Bluwin.ch" }));
		assert.deepEqual([typo.suggestion, typo.typed], ["leser@bluewin.ch", "leser@bluwin.ch"]);
		assert.equal(cloudflare.calls.length, 0, "answered before the token is spent");
		assert.ok((await refused("kept other", () => archive({ email: "leser@bluwin.ch", keepAsTyped: "other@bluwin.ch" }))).suggestion);

		const kept = await archive({ email: "leser@bluwin.ch", keepAsTyped: "leser@bluwin.ch" });
		assert.equal(kept.ok, true, kept.error);
		assert.ok((await emails()).includes("leser@bluwin.ch"), "the address as typed");
		assert.ok(!(await emails()).includes("leser@bluewin.ch"));

		// gamil.com is on upstream's list of misspellings, which refuses it even when kept.
		const upstream = await refused("gamil kept", () => archive({ email: "reader@gamil.com", keepAsTyped: "reader@gamil.com" }));
		assert.equal(upstream.error, "Did you mean reader@gmail.com?");
	});

	test("the archive form takes a signup that passes every check, once through each", async () => {
		const result = await archive({ email: "leser@bluewin.ch" }, { ip: "198.18.9.9" });
		assert.equal(result.ok, true, result.error);
		assert.ok((await emails()).includes("leser@bluewin.ch"));
		assert.equal(cloudflare.calls.length, 1);
		assert.deepEqual(cloudflare.calls[0], { secret: SECRET, response: "token-1", remoteip: "198.18.9.9" });
		assert.deepEqual(redis.calls, ["198.18.9.9"]);
		assert.deepEqual(dns.calls, ["mx bluewin.ch"]);
	});

	// The plain HTML form, posted from the owner's site.
	function embed(email, { ip = `198.18.2.${++nextIp}` } = {}) {
		const id = String(newsletter._id);
		const request = new Request(`http://localhost:3000/api/embed/${id}`, {
			method: "POST",
			headers: { "x-forwarded-for": ip, "content-type": "application/json", accept: "application/json", origin: "https://site.example" },
			body: JSON.stringify({ email, website: "" }),
		});
		return m.embed.POST(request, { params: Promise.resolve({ id }) });
	}

	async function embedRefused(label, email, status) {
		const response = await refused(label, () => embed(email));
		assert.equal(response.status, status, label);
		return (await response.json()).error;
	}

	test("forms on other sites: Redis, DNS, throwaway, mailless and typo addresses refuse before any write", async (t) => {
		t.mock.method(console, "error", () => {});
		enableSignupProtection({ fetch: siteverify, resolver, limiter: null, now });
		// Upstream's per-address limit counts before ours, so each case has its own address.
		assert.match(await embedRefused("no redis", "form1@example.org", 503), /paused/);
		enableSignupProtection({ fetch: siteverify, resolver, limiter, now });
		redis.answer = new Error("fetch failed");
		assert.match(await embedRefused("redis error", "form2@example.org", 503), /paused/);
		redis.answer = { success: false };
		assert.match(await embedRefused("over limit", "form3@example.org", 429), /Too many/);
		redis.answer = { success: true };

		assert.match(await embedRefused("disposable", "form@0-mail.com", 400), /permanent address/);
		assert.match(await embedRefused("null mx", "form@null-mx.example", 400), /can't receive email/);
		assert.match(await embedRefused("dns down", "form@servfail.example", 503), /couldn't check/);
		assert.equal(await embedRefused("typo", "form@bluwin.ch", 400), "Did you mean form@bluewin.ch?");

		const ok = await embed("form@example.org");
		assert.equal(ok.status, 200);
		assert.ok((await emails()).includes("form@example.org"));
		assert.equal(cloudflare.calls.length, 0, "no Turnstile on forms on other sites");
	});

	async function addContact(body) {
		return callApi("POST", "/api/v1/contacts", { key: apiKey, body: { newsletter: newsletter.slug, ...body } });
	}

	async function apiRefused(label, body, status, code) {
		const response = await refused(label, () => addContact(body));
		assert.equal(response.status, status, `${label}: ${JSON.stringify(response.body)}`);
		assert.equal(response.body.error.code, code, label);
		return response.body.error.message;
	}

	test("add_contact over the API: per-key and per-visitor limits fail closed, then the address checks; no Turnstile", async (t) => {
		t.mock.method(console, "error", () => {});
		enableSignupProtection({ fetch: siteverify, resolver, limiter: null, now });
		assert.match(await apiRefused("no redis", { email: "api@example.org" }, 503, "unavailable"), /paused/);
		enableSignupProtection({ fetch: siteverify, resolver, limiter, now });
		redis.answer = { success: true, reason: "timeout" };
		assert.match(await apiRefused("redis timeout", { email: "api@example.org", ip: "203.0.113.5" }, 503, "unavailable"), /paused/);
		redis.answer = { success: false };
		assert.match(await apiRefused("over limit", { email: "api@example.org" }, 429, "rate_limited"), /Too many/);
		redis.answer = { success: true };

		assert.match(await apiRefused("disposable", { email: "api@0-mail.com", source: "trusted" }, 400, "validation_failed"), /permanent address/);
		assert.match(await apiRefused("null mx", { email: "api@null-mx.example" }, 400, "validation_failed"), /can't receive email/);
		assert.match(await apiRefused("dns down", { email: "api@servfail.example" }, 503, "unavailable"), /couldn't check/);
		assert.equal(await apiRefused("typo", { email: "api@bluwin.ch" }, 400, "validation_failed"), "Did you mean api@bluewin.ch?");

		redis.calls = [];
		const kept = await addContact({ email: "api@bluwin.ch", keepAsTyped: "api@bluwin.ch", ip: "203.0.113.5" });
		assert.equal(kept.status, 201, JSON.stringify(kept.body));
		assert.equal(kept.body.email, "api@bluwin.ch");
		assert.equal(redis.calls.length, 2, "per key, then per visitor");
		assert.ok(redis.calls[1].endsWith(":203.0.113.5"));
		assert.equal(cloudflare.calls.length, 0);
		await flushAfter();
	});
});
