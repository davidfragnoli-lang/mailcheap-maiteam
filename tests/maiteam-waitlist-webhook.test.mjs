import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { after, before, beforeEach, describe, test } from "node:test";
import { activate, as, callApi, catchRedirect, form, signIn, startTestApp } from "./helpers/app.mjs";
import { flushAfter } from "./stubs/next-server.mjs";
import { disableSignupProtection, enableSignupProtection } from "./stubs/maiteam-signup-protection.mjs";
import { published } from "./stubs/qstash.mjs";
import { sent as sesEmails } from "./stubs/ses.mjs";
import {
	FUTURE_TOLERANCE_MS,
	PAST_TOLERANCE_MS,
	isRetryableStatus,
	parseWaitlistPayload,
	resolveWaitlistProduct,
	signWaitlistBody,
	signupInputFor,
	verifyWaitlistSignature,
} from "../lib/maiteam/waitlist-webhook.js";

// maiteam's signed waitlist webhook (PATCHES.md P6): the rules on their own, then the route on upstream's signup path,
// with a synthetic secret, an in-memory replay store in place of Redis, and nothing leaving the process.

const SECRET = "synthetic-test-secret-at-least-32-characters";
const NOW = Date.parse("2026-10-19T08:00:00.000Z");
const ENV = { WAITLIST_WEBHOOK_PRODUCTS: "maifortune", WAITLIST_SECRET_MAIFORTUNE: SECRET };
const body = JSON.stringify({ eventId: "evt-00000001", product: "maifortune", email: "Reader@Example.invalid" });
const COPY = JSON.parse(readFileSync(new URL("../fixtures/maifortune-welcome/copy.maiteam.en.json", import.meta.url), "utf8"));

function signed(overrides = {}) {
	const timestamp = String(overrides.at ?? NOW);
	return {
		secret: SECRET,
		product: "maifortune",
		timestamp,
		rawBody: body,
		now: NOW,
		signature: signWaitlistBody({ secret: overrides.secret ?? SECRET, timestamp, product: overrides.signProduct ?? "maifortune", rawBody: body }),
		...overrides.input,
	};
}

describe("waitlist webhook rules", () => {
	test("a product is off unless it is listed and has a long enough secret", () => {
		assert.equal(resolveWaitlistProduct("maifortune", {}), null);
		assert.equal(resolveWaitlistProduct("maifortune", { WAITLIST_SECRET_MAIFORTUNE: SECRET }), null);
		assert.equal(resolveWaitlistProduct("maifortune", { ...ENV, WAITLIST_SECRET_MAIFORTUNE: "short" }), null);
		assert.equal(resolveWaitlistProduct("unknown", { ...ENV, WAITLIST_WEBHOOK_PRODUCTS: "unknown" }), null);
		assert.equal(resolveWaitlistProduct("__proto__", ENV), null);
		const config = resolveWaitlistProduct("maifortune", ENV);
		assert.equal(config.newsletter, "maifortune");
		assert.equal(config.sequence, "welcome");
		assert.equal(config.name, "fortuna waitlist", "people see the product in lowercase");
	});

	test("the signature binds the secret, the product, the timestamp and the body", () => {
		assert.deepEqual(verifyWaitlistSignature(signed()), { ok: true });
		assert.equal(verifyWaitlistSignature(signed({ secret: "another-secret-that-is-at-least-32-chars" })).reason, "signature");
		assert.equal(verifyWaitlistSignature(signed({ signProduct: "other" })).reason, "signature");
		assert.equal(verifyWaitlistSignature(signed({ input: { rawBody: `${body} ` } })).reason, "signature");
		assert.equal(verifyWaitlistSignature(signed({ input: { signature: "" } })).reason, "signature");
		assert.equal(verifyWaitlistSignature(signed({ input: { timestamp: "1792396800" } })).reason, "signature");
	});

	test("the timestamp window is five minutes back and one minute ahead", () => {
		assert.equal(verifyWaitlistSignature(signed({ at: NOW - PAST_TOLERANCE_MS })).ok, true);
		assert.equal(verifyWaitlistSignature(signed({ at: NOW - PAST_TOLERANCE_MS - 1 })).reason, "timestamp");
		assert.equal(verifyWaitlistSignature(signed({ at: NOW + FUTURE_TOLERANCE_MS })).ok, true);
		assert.equal(verifyWaitlistSignature(signed({ at: NOW + FUTURE_TOLERANCE_MS + 1 })).reason, "timestamp");
	});

	test("the payload can't assert consent or choose its list", () => {
		const ok = parseWaitlistPayload(body, "maifortune");
		assert.deepEqual(ok, { eventId: "evt-00000001", email: "reader@example.invalid", ip: null });
		for (const field of ["confirmed", "status", "consent", "newsletter", "sequence", "resubscribe", "source"]) {
			const withField = JSON.stringify({ ...JSON.parse(body), [field]: true });
			assert.match(parseWaitlistPayload(withField, "maifortune").error, /^Unknown field/);
		}
		assert.equal(parseWaitlistPayload(body, "other").status, 403);
		assert.equal(parseWaitlistPayload("[]", "maifortune").error, "Send a JSON object");
		assert.equal(parseWaitlistPayload("{", "maifortune").error, "Send a JSON object");
		assert.equal(parseWaitlistPayload(JSON.stringify({ eventId: "short", product: "maifortune", email: "a@b.invalid" }), "maifortune").error, "eventId is invalid");
		assert.deepEqual(signupInputFor(resolveWaitlistProduct("maifortune", ENV), ok), {
			slug: "maifortune",
			sequence: "welcome",
			email: "reader@example.invalid",
			source: "waitlist:maifortune",
			resubscribe: false,
			ip: null,
		});
	});

	test("only rate-limited and server-side refusals free the event id for a retry", () => {
		for (const status of [429, 500, 503]) assert.equal(isRetryableStatus(status), true, status);
		for (const status of [200, 201, 400, 404, 409]) assert.equal(isRetryableStatus(status), false, status);
	});
});

// Redis's semantics in memory: a claim set only if absent with a lease, then done, or released.
function memoryReplayStore() {
	const keys = new Map();
	const live = (key) => {
		const entry = keys.get(key);
		if (entry && entry.expiresAt <= Date.now()) keys.delete(key);
		return keys.get(key);
	};
	return {
		keys,
		async claim({ product, eventId, hash, leaseMs }) {
			const key = `${product}:${eventId}`;
			const existing = live(key);
			if (!existing) {
				const claim = `p:${hash}:${crypto.randomBytes(6).toString("hex")}`;
				keys.set(key, { value: claim, expiresAt: Date.now() + leaseMs });
				return { claimed: true, claim };
			}
			const [state, storedHash] = existing.value.split(":");
			return { claimed: false, state: state === "d" ? "done" : "processing", sameBody: storedHash === hash };
		},
		async complete({ product, eventId, hash, claim, ttlMs }) {
			const key = `${product}:${eventId}`;
			if (live(key)?.value !== claim) return false;
			keys.set(key, { value: `d:${hash}`, expiresAt: Date.now() + ttlMs });
			return true;
		},
		async release({ product, eventId, claim }) {
			const key = `${product}:${eventId}`;
			if (live(key)?.value === claim) keys.delete(key);
		},
	};
}

describe("waitlist webhook route", () => {
	let app;
	let m;
	let user;
	let store;
	let sequence;
	let nextEvent = 0;

	before(async () => {
		app = await startTestApp(ENV);
		m = {
			apiKeys: await import("../app/(app)/api-keys/actions.js"),
			newsletters: await import("../app/(app)/newsletters/actions.js"),
			confirm: await import("../app/confirm/actions.js"),
			route: await import("../app/api/webhooks/waitlist/[product]/route.js"),
			replay: await import("../lib/maiteam/webhook-replay-store.js"),
			confirmation: await import("../lib/confirmation.js"),
			Contact: (await import("../models/Contact.js")).default,
			Enrollment: (await import("../models/Enrollment.js")).default,
			Message: (await import("../models/Message.js")).default,
			Newsletter: (await import("../models/Newsletter.js")).default,
		};
		user = await signIn("fortuna-owner@example.com");
		await activate(user);
		const url = await as(user, () =>
			catchRedirect(m.newsletters.saveNewsletter(null, form({ name: "fortuna", slug: "maifortune", fromEmail: "hello@maifortune.mailcheapmail.com", postalAddress: "1 Main St, Paris" })))
		);
		user.newsletterId = url.split("/").at(-1);
		await m.Newsletter.updateOne({ accountId: user.accountId, _id: user.newsletterId }, { $set: { requireConfirmation: true, confirmation: COPY.confirmation, theme: { preset: "fortuna" } } });
		user.key = (await as(user, () => m.apiKeys.createApiKey(null, form({ name: "Admin", level: "full" })))).key;
		const created = await callApi("POST", "/api/v1/sequences", {
			key: user.key,
			body: { name: "fortuna welcome", slug: "welcome", status: "active", steps: COPY.steps.map(({ delayDays, subject, previewText, markdown }) => ({ delayDays, subject, previewText, markdown })) },
		});
		assert.equal(created.status, 201, JSON.stringify(created.body));
		sequence = created.body;
	});

	after(() => app?.stop());

	beforeEach(() => {
		store = memoryReplayStore();
		m.replay.setReplayStoreForTests(store);
		disableSignupProtection();
	});

	function event(fields = {}) {
		return { eventId: `evt-${String(++nextEvent).padStart(8, "0")}`, product: "maifortune", ...fields };
	}

	async function deliver(payload, { at = Date.now(), secret = SECRET, product = "maifortune", raw } = {}) {
		const rawBody = raw ?? JSON.stringify(payload);
		const timestamp = String(at);
		const request = new Request(`http://localhost:3000/api/webhooks/waitlist/${product}`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-waitlist-timestamp": timestamp,
				"x-waitlist-signature": signWaitlistBody({ secret, timestamp, product, rawBody }),
			},
			body: rawBody,
		});
		const response = await m.route.POST(request, { params: Promise.resolve({ product }) });
		await flushAfter();
		return { status: response.status, headers: response.headers, body: await response.json() };
	}

	const contactOf = (email) => m.Contact.findOne({ accountId: user.accountId, email }).lean();
	const confirmationsTo = (email) => sesEmails.filter((sent) => sent.to === email && sent.tags.some(({ name, value }) => name === "kind" && value === "confirmation"));

	test("a signed event signs the reader up pending, sends the fortuna confirmation once, and a replay is acknowledged", async () => {
		const email = "first@fortuna.example.org";
		const payload = event({ email });
		const first = await deliver(payload);
		assert.equal(first.status, 201, JSON.stringify(first.body));
		assert.equal(first.body.status, "pending");
		const contact = await contactOf(email);
		assert.equal(contact.source, "waitlist:maifortune");
		const [confirmation] = confirmationsTo(email);
		assert.equal(confirmation.subject, COPY.confirmation.subject);
		assert.match(confirmation.html, /style="display:inline-block;background:#6e5c96;/);
		const enrollment = await m.Enrollment.findOne({ accountId: user.accountId, contactId: contact._id }).lean();
		assert.equal(enrollment.status, "awaiting_confirmation");
		assert.equal(String(enrollment.sequenceId), sequence.id);

		const replay = await deliver(payload);
		assert.deepEqual([replay.status, replay.body.duplicate], [200, true]);
		const reused = await deliver({ ...payload, email: "other@fortuna.example.org" });
		assert.equal(reused.status, 409);
		assert.equal(await contactOf("other@fortuna.example.org"), null);
		assert.equal(confirmationsTo(email).length, 1);

		const jobs = published.length;
		const token = m.confirmation.createConfirmToken({ contactId: contact._id, newsletterId: contact.newsletterId });
		assert.deepEqual(await m.confirm.confirmSubscription(token), { ok: true });
		assert.equal((await m.Enrollment.findById(enrollment._id).setOptions({ crossAccount: true }).lean()).status, "active");
		const [job] = published.slice(jobs);
		assert.equal(job.body.position, 1);
		assert.ok(job.notBefore * 1000 > Date.now() + 23 * 3_600_000, "step 1 on day 1 after the click");
	});

	test("an unsigned, stale, foreign or oversized event, or one with fields beyond eventId, product, email and ip, writes nothing", async () => {
		const email = "refused@fortuna.example.org";
		const cases = [
			[401, await deliver(event({ email }), { secret: "another-secret-that-is-at-least-32-chars" })],
			[401, await deliver(event({ email }), { at: Date.now() - PAST_TOLERANCE_MS - 1000 })],
			[404, await deliver(event({ email }), { product: "unknown" })],
			[403, await deliver(event({ email, product: "other" }))],
			[413, await deliver(null, { raw: JSON.stringify({ ...event({ email }), ip: "1".repeat(5000) }) })],
		];
		for (const field of ["confirmed", "status", "newsletter", "sequence", "resubscribe", "consent"]) {
			cases.push([400, await deliver(event({ email, [field]: true }))]);
		}
		for (const [status, response] of cases) assert.equal(response.status, status, JSON.stringify(response.body));
		assert.equal(await contactOf(email), null);
		assert.equal(confirmationsTo(email).length, 0);
		assert.equal(store.keys.size, 0, "no event id is taken by a refused delivery");
	});

	test("an event still being processed is retryable, never a duplicate; a fail-closed refusal frees its id for the retry", async () => {
		const email = "race@fortuna.example.org";
		const payload = event({ email });
		const hash = crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
		await store.claim({ product: "maifortune", eventId: payload.eventId, hash, leaseMs: 60_000 });
		const busy = await deliver(payload);
		assert.equal(busy.status, 503);
		assert.equal(busy.body.retryable, true);
		assert.equal(busy.headers.get("retry-after"), "5");
		store.keys.clear();

		enableSignupProtection({ limiter: null, resolver: { resolveMx: async () => [{ exchange: "mx.example.org", priority: 5 }] } });
		const down = await deliver(payload);
		assert.equal(down.status, 503, "Redis down refuses the signup");
		assert.equal(await contactOf(email), null);
		enableSignupProtection({ limiter: { limit: async () => ({ success: true }) }, resolver: { resolveMx: async () => [{ exchange: "mx.example.org", priority: 5 }] } });
		const retried = await deliver(payload);
		assert.equal(retried.status, 201, JSON.stringify(retried.body));
		assert.equal(confirmationsTo(email).length, 1);
	});

	test("an unsubscribed reader stays unsubscribed, and an imported active contact doesn't start the series", async () => {
		const left = "left@fortuna.example.org";
		const imported = "imported@fortuna.example.org";
		await m.Contact.create([
			{ accountId: user.accountId, newsletterId: user.newsletterId, email: left, status: "unsubscribed", subscribedAt: new Date() },
			{ accountId: user.accountId, newsletterId: user.newsletterId, email: imported, status: "active", subscribedAt: new Date() },
		]);
		const kept = await deliver(event({ email: left }));
		assert.deepEqual([kept.status, kept.body.status, kept.body.created], [200, "unsubscribed", false]);
		assert.equal((await contactOf(left)).status, "unsubscribed");
		assert.equal(confirmationsTo(left).length, 0);
		const active = await deliver(event({ email: imported }));
		assert.equal(active.status, 200);
		assert.equal(await m.Enrollment.countDocuments({ accountId: user.accountId, email: imported }), 0);
		assert.equal(sesEmails.filter((sent) => sent.to === imported).length, 0);
	});

	test("a newsletter that doesn't ask new subscribers to confirm takes no waitlist signup", async () => {
		await m.Newsletter.updateOne({ accountId: user.accountId, _id: user.newsletterId }, { $set: { requireConfirmation: false } });
		try {
			const email = "noconfirm@fortuna.example.org";
			const refused = await deliver(event({ email }));
			assert.equal(refused.status, 503);
			assert.equal(await contactOf(email), null);
		} finally {
			await m.Newsletter.updateOne({ accountId: user.accountId, _id: user.newsletterId }, { $set: { requireConfirmation: true } });
		}
	});
});
