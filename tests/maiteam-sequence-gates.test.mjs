import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { activate, as, callApi, catchRedirect, form, signIn, startTestApp } from "./helpers/app.mjs";
import { flushAfter } from "./stubs/next-server.mjs";
import { published } from "./stubs/qstash.mjs";
import { sent as sesEmails } from "./stubs/ses.mjs";

// A welcome-sequence step (PATCHES.md P6) with maiteam's send gates on (P4): it goes through deliver() like every
// email, so it holds a unit of the SES quota and of its newsletter's daily cap, and a closed cap refuses it. The SES
// account read and the send slot are the only seams, as in tests/maiteam-send-gates.test.mjs.

let app;
let m;
let processed = 0;
const quota = { max24HourSend: 200, sentLast24Hours: 0, maxSendRate: 1 };
const slots = [];

before(async () => {
	app = await startTestApp({ QSTASH_CURRENT_SIGNING_KEY: "sig-current", QSTASH_NEXT_SIGNING_KEY: "sig-next", MAITEAM_SEND_GATES: "on" });
	m = {
		apiKeys: await import("../app/(app)/api-keys/actions.js"),
		newsletters: await import("../app/(app)/newsletters/actions.js"),
		store: await import("../lib/maiteam/sequence-store.js"),
		gate: await import("../lib/maiteam/send-gate.js"),
		cap: await import("../lib/maiteam/newsletter-cap.js"),
		Enrollment: (await import("../models/Enrollment.js")).default,
		Message: (await import("../models/Message.js")).default,
		Newsletter: (await import("../models/Newsletter.js")).default,
		SesQuota: (await import("../models/SesQuota.js")).default,
		NewsletterCap: (await import("../models/NewsletterCap.js")).default,
	};
	m.gate.setSendGateSeamsForTests({
		readAccount: async () => ({ ...quota }),
		waitForSlot: async (lane) => {
			slots.push(lane);
		},
	});
});

after(() => app?.stop());

beforeEach(async () => {
	await m.SesQuota.deleteMany({});
	processed = published.length;
});

async function customer(slug, dailySendCap) {
	const user = await signIn(`${slug}@example.com`);
	await activate(user);
	const url = await as(user, () =>
		catchRedirect(m.newsletters.saveNewsletter(null, form({ name: `${slug} news`, slug, fromEmail: `hello@${slug}.mailcheapmail.com`, postalAddress: "1 Main St, Paris" })))
	);
	user.newsletterId = url.split("/").at(-1);
	await m.Newsletter.updateOne({ accountId: user.accountId, _id: user.newsletterId }, { $set: { dailySendCap } });
	user.key = (await as(user, () => m.apiKeys.createApiKey(null, form({ name: "Site", level: "full" })))).key;
	const created = await callApi("POST", "/api/v1/sequences", {
		key: user.key,
		body: { name: "Welcome", slug: "welcome", status: "active", steps: [{ delayDays: 0, subject: "Welcome", markdown: "Hello" }] },
	});
	assert.equal(created.status, 201, JSON.stringify(created.body));
	return user;
}

async function signUpAll(user, emails) {
	for (const email of emails) assert.equal((await callApi("POST", "/api/v1/contacts", { key: user.key, body: { email, sequence: "welcome" } })).status, 201);
	await flushAfter();
}

async function runStepJobs() {
	const results = [];
	const end = published.length;
	while (processed < end) {
		const job = published[processed++];
		if (job.url.endsWith("/api/jobs/sequence-step")) results.push({ job, result: await m.store.runSequenceStep(job.body) });
	}
	return results;
}

const capOf = (user) => m.NewsletterCap.findById(`${user.newsletterId}:${new Date().toISOString().slice(0, 10)}`).lean();

test("a step takes a unit of the SES quota and of the daily cap, and the cap holds the rest until the next UTC day", async () => {
	const user = await customer("gated-seq", 2);
	const readers = [1, 2, 3].map((n) => `reader${n}@gated-seq.example.org`);
	const before = sesEmails.length;
	await signUpAll(user, readers);
	const results = await runStepJobs();
	assert.deepEqual(results.map(({ result }) => result.outcome), ["sent", "sent", "retry"]);
	assert.equal(sesEmails.length - before, 2, "the cap of 2 holds");
	const ledger = await m.SesQuota.findById("ses-rolling-24h").lean();
	assert.equal(ledger.issued, 2);
	assert.equal(ledger.holds.length, 0);
	assert.equal((await capOf(user)).issued, 2);
	assert.ok(slots.every((lane) => lane.failClosed === true && lane.rate === 1), "the gated send slot, at SES's own rate");

	const messages = await m.Message.find({ accountId: user.accountId, kind: "sequence" }).sort({ _id: 1 }).lean();
	assert.ok(messages.slice(0, 2).every((message) => message.senderDomain === "gated-seq.mailcheapmail.com" && message.handoffAt instanceof Date));
	assert.equal(messages[2].status, "queued", "the third waits, never handed off");
	const held = await m.Enrollment.findOne({ accountId: user.accountId, email: readers[2] }).lean();
	assert.equal(held.steps[0].status, "sending");
	const [retry] = published.slice(processed).filter(({ url }) => url.endsWith("/api/jobs/sequence-step"));
	const midnight = Math.floor(m.cap.nextUtcDayStart(Date.now()) / 1000);
	assert.ok(Math.abs(retry.notBefore - midnight) <= 5, `retried at the next UTC midnight (${retry.notBefore} vs ${midnight})`);
});

test("a newsletter whose cap is 0 sends no step", async () => {
	const user = await customer("closed-seq", 0);
	const before = sesEmails.length;
	await signUpAll(user, ["reader@closed-seq.example.org"]);
	const [{ result }] = await runStepJobs();
	assert.equal(result.outcome, "failed");
	assert.match(result.error, /daily send cap is 0/);
	assert.equal(sesEmails.length, before);
	const enrollment = await m.Enrollment.findOne({ accountId: user.accountId }).lean();
	assert.equal(enrollment.steps[0].status, "failed");
	assert.equal((await m.SesQuota.findById("ses-rolling-24h").lean())?.holds?.length ?? 0, 0, "its quota hold returned");
});
