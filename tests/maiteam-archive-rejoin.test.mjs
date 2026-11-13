import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { createUnsubscribeToken } from "../lib/unsubscribe.js";
import { activate, addAuthor, anonymous, as, callApi, catchRedirect, form, jsonRequest, signIn, startTestApp } from "./helpers/app.mjs";
import { runWithRequest } from "./stubs/next-headers.mjs";
import { flushAfter } from "./stubs/next-server.mjs";
import { published } from "./stubs/qstash.mjs";
import { sent as sesEmails } from "./stubs/ses.mjs";

// maiteam (PATCHES.md P17, FRA-26634): the archive's public signup form can't undo an unsubscribe or a dormancy. Anyone
// who knows an address and the slug can fill it in, so a contact who left comes back pending, with the date they left
// kept, and only the click on the signed confirmation link makes them active again.
let app;
let m;
let visitor = 0;
let processed = 0;

async function createNewsletter(user, slug, extra = {}) {
	const fields = {
		name: `${slug} news`,
		slug,
		postalAddress: "1 Main St, Paris",
		archiveEnabled: "on",
		welcomeEnabled: "on",
		welcomeSubject: "Welcome",
		welcomeContent: "Thanks for joining.",
		...extra,
	};
	const url = await as(user, () => catchRedirect(m.newsletters.saveNewsletter(null, form(fields))));
	const newsletterId = url.split("/").at(-1);
	await addAuthor(user, newsletterId);
	return newsletterId;
}

async function customer(email, extra = {}) {
	const user = await signIn(email);
	await activate(user);
	user.slug = email.split("@")[0];
	user.newsletterId = await createNewsletter(user, user.slug, extra);
	user.key = (await as(user, () => m.apiKeys.createApiKey(null, form({ name: "Agent", level: "full" })))).key;
	user.signupsKey = (await as(user, () => m.apiKeys.createApiKey(null, form({ name: "Site", level: "signups" })))).key;
	return user;
}

async function signUpOnArchive(user, email) {
	const result = await runWithRequest({ headers: { "x-forwarded-for": `192.0.2.${++visitor}` } }, () =>
		m.archive.subscribe(null, form({ newsletter: user.slug, email }))
	);
	await flushAfter();
	return result;
}

function findContact(user, email) {
	return m.Contact.findOne({ accountId: user.accountId, newsletterId: user.newsletterId, email }).lean();
}

// The one-click unsubscribe a mail app sends, as the audit's reproduction did.
async function unsubscribe(contact, newsletterId) {
	const token = createUnsubscribeToken({ contactId: contact._id, newsletterId });
	const response = await m.unsubscribeRoute.POST(
		new Request(`http://localhost:3000/api/unsubscribe?token=${token}`, { method: "POST", body: new URLSearchParams({ "List-Unsubscribe": "One-Click" }) })
	);
	assert.equal(response.status, 200);
}

function emailsTo(address, since) {
	return sesEmails.slice(since).filter(({ to }) => String(to).includes(address));
}

function confirmTokenIn(email) {
	const token = `${email.html ?? ""} ${email.text ?? ""}`.match(/\/confirm\?token=([^"'&\s)<]+)/)?.[1];
	assert.ok(token, "the email carries a signed confirmation link");
	return decodeURIComponent(token);
}

async function runJobs() {
	while (processed < published.length) {
		const { url, body } = published[processed++];
		if (url.endsWith("/api/jobs/send-batch")) await m.sendBatchRoute.POST(jsonRequest(url, { method: "POST", body }));
	}
}

// How many an issue sent now would reach: the campaign audience, which takes active contacts only.
async function issueRecipients(user) {
	const draft = await callApi("POST", "/api/v1/campaigns", { key: user.key, body: { subject: "Issue", content: "Hello." } });
	const sent = await callApi("POST", `/api/v1/campaigns/${draft.body.id}/send`, { key: user.key });
	if (sent.body.error?.code === "no_recipients") return 0;
	return sent.body.stats.recipients;
}

before(async () => {
	app = await startTestApp({ QSTASH_CURRENT_SIGNING_KEY: "sig-current", QSTASH_NEXT_SIGNING_KEY: "sig-next" });
	m = {
		newsletters: await import("../app/(app)/newsletters/actions.js"),
		contacts: await import("../app/(app)/contacts/actions.js"),
		apiKeys: await import("../app/(app)/api-keys/actions.js"),
		archive: await import("../app/archive/actions.js"),
		confirm: await import("../app/confirm/actions.js"),
		unsubscribeRoute: await import("../app/api/unsubscribe/route.js"),
		sendBatchRoute: await import("../app/api/jobs/send-batch/route.js"),
		Contact: (await import("../models/Contact.js")).default,
		Suppression: (await import("../models/Suppression.js")).default,
		Message: (await import("../models/Message.js")).default,
	};
});

after(() => app?.stop());

describe("the archive form and a contact who left", () => {
	test("an anonymous signup after an unsubscribe leaves them pending with the date kept; only their click brings them back", async () => {
		const user = await customer("rejoin-unsub@example.com");
		assert.deepEqual(await signUpOnArchive(user, "reader@example.org"), { ok: true });
		const joined = await findContact(user, "reader@example.org");
		assert.equal(joined.status, "active");
		await unsubscribe(joined, user.newsletterId);
		const left = await findContact(user, "reader@example.org");
		assert.equal(left.status, "unsubscribed");
		assert.ok(left.unsubscribedAt instanceof Date);
		assert.equal(await m.Suppression.countDocuments({ accountId: user.accountId, email: "reader@example.org" }), 0, "an unsubscribe writes no suppression");
		const before = sesEmails.length;

		const result = await signUpOnArchive(user, "reader@example.org");
		assert.deepEqual([result.ok, result.pending], [true, true]);
		const pending = await findContact(user, "reader@example.org");
		assert.equal(pending.status, "pending", "not active from someone typing the address");
		assert.equal(pending.unsubscribedAt?.toISOString(), left.unsubscribedAt.toISOString(), "the date they left is kept");
		assert.deepEqual(pending.statusChanges.at(-1), { ...pending.statusChanges.at(-1), from: "unsubscribed", to: "pending", via: "signup" });
		const mails = emailsTo("reader@example.org", before);
		assert.equal(mails.length, 1, "one email: the confirmation");
		assert.notEqual(mails[0].subject, "Welcome");
		assert.equal(await issueRecipients(user), 0, "a pending contact gets no issue");
		await runJobs();
		assert.equal(emailsTo("reader@example.org", before).length, 1);

		const token = confirmTokenIn(mails[0]);
		assert.deepEqual(await anonymous(() => m.confirm.confirmSubscription(token)), { ok: true });
		await flushAfter();
		const back = await findContact(user, "reader@example.org");
		assert.equal(back.status, "active");
		assert.equal(back.unsubscribedAt, undefined, "the click clears the date they left");
		assert.ok(back.confirmedAt instanceof Date);
		assert.deepEqual(back.statusChanges.at(-1), { ...back.statusChanges.at(-1), from: "pending", to: "active", via: "confirmation" });
		assert.equal(await issueRecipients(user), 1);
	});

	test("a dormant contact also confirms by email first, and the lifetime cap of three confirmations holds", async () => {
		const user = await customer("rejoin-dormant@example.com");
		assert.deepEqual(await signUpOnArchive(user, "cold@example.org"), { ok: true });
		const cold = await findContact(user, "cold@example.org");
		assert.deepEqual(await as(user, () => m.contacts.setContactStatus(String(cold._id), "dormant")), { ok: true });
		const before = sesEmails.length;

		const result = await signUpOnArchive(user, "cold@example.org");
		assert.deepEqual([result.ok, result.pending], [true, true]);
		assert.equal((await findContact(user, "cold@example.org")).status, "pending");
		assert.equal(emailsTo("cold@example.org", before).length, 1);

		// More tries, each after the 24-hour pause between confirmations: the confirmation email's own lifetime cap
		// applies, so the form can't flood the address.
		for (let attempt = 0; attempt < 5; attempt++) {
			// The driver directly: createdAt is immutable through mongoose.
			await m.Message.collection.updateMany({ accountId: user.accountId, kind: "confirmation", contactId: cold._id }, { $set: { createdAt: new Date(0) } });
			await signUpOnArchive(user, "cold@example.org");
		}
		assert.equal(emailsTo("cold@example.org", before).length, 3, "three confirmations per contact, then none");
		assert.equal((await findContact(user, "cold@example.org")).status, "pending");
	});
});

describe("the normal paths, unchanged", () => {
	test("a new reader joins at once, or confirms first where the newsletter asks it", async () => {
		const open = await customer("rejoin-open@example.com");
		const before = sesEmails.length;
		assert.deepEqual(await signUpOnArchive(open, "new@example.org"), { ok: true });
		assert.equal((await findContact(open, "new@example.org")).status, "active");
		assert.deepEqual(emailsTo("new@example.org", before).map(({ subject }) => subject), ["Welcome"]);

		const confirming = await customer("rejoin-confirming@example.com", { requireConfirmation: "on" });
		const result = await signUpOnArchive(confirming, "careful@example.org");
		assert.deepEqual([result.ok, result.pending], [true, true]);
		const [mail] = emailsTo("careful@example.org", before);
		assert.deepEqual(await anonymous(() => m.confirm.confirmSubscription(confirmTokenIn(mail))), { ok: true });
		const confirmed = await findContact(confirming, "careful@example.org");
		assert.deepEqual([confirmed.status, confirmed.unsubscribedAt], ["active", undefined]);
	});

	test("a key's resubscribe: true and the dashboard still bring back someone who left at once, and a key can't ask for rejoin", async () => {
		const user = await customer("rejoin-admin@example.com");
		for (const email of ["by-key@example.org", "by-hand@example.org"]) {
			assert.deepEqual(await signUpOnArchive(user, email), { ok: true });
			await unsubscribe(await findContact(user, email), user.newsletterId);
		}

		const viaKey = await callApi("POST", "/api/v1/contacts", { key: user.signupsKey, body: { email: "by-key@example.org", resubscribe: true } });
		assert.equal(viaKey.status, 200, JSON.stringify(viaKey.body));
		const byKey = await findContact(user, "by-key@example.org");
		assert.deepEqual([byKey.status, byKey.unsubscribedAt], ["active", undefined]);

		const byHand = await findContact(user, "by-hand@example.org");
		const changed = await callApi("PATCH", `/api/v1/contacts/${byHand._id}`, { key: user.key, body: { status: "active", consent: true } });
		assert.equal(changed.status, 200, JSON.stringify(changed.body));
		assert.deepEqual([changed.body.status, changed.body.unsubscribedAt], ["active", null]);

		await unsubscribe(byKey, user.newsletterId);
		const asking = await callApi("POST", "/api/v1/contacts", { key: user.signupsKey, body: { email: "by-key@example.org", resubscribe: false, rejoin: "confirm" } });
		assert.notEqual((await findContact(user, "by-key@example.org")).status, "pending", `rejoin isn't an API field (${asking.status})`);
	});
});
