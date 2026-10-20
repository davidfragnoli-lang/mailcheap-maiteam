import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { activate, as, catchRedirect, form, jsonRequest, signIn, startTestApp, withEnv } from "./helpers/app.mjs";
import { published } from "./stubs/qstash.mjs";
import { sent as sesEmails, state as sesState } from "./stubs/ses.mjs";

// maiteam's send gates (PATCHES.md P4) through upstream's real campaign, batch and test paths, with the gates on.
// The SES account read and the shared send slot are the only seams: the ledgers are real Mongo documents.

let app;
let m;
let processed = 0;
const quota = { max24HourSend: 200, sentLast24Hours: 0, maxSendRate: 1 };
const slots = [];
let slotError = null;

// The jobs published so far, once each: a retry a batch publishes waits for the next call, as QStash would make it wait.
async function runJobs() {
	const results = [];
	const end = published.length;
	while (processed < end) {
		const { url, body } = published[processed++];
		if (!url.endsWith("/api/jobs/send-batch")) continue;
		results.push(await (await m.sendBatchRoute.POST(jsonRequest(url, { method: "POST", body }))).json());
	}
	return results;
}

async function customer(slug, { contacts = 3, dailySendCap = 50 } = {}) {
	const user = await signIn(`${slug}@example.com`);
	await activate(user);
	const url = await as(user, () =>
		catchRedirect(m.newsletters.saveNewsletter(null, form({ name: `${slug} news`, slug, fromEmail: `hello@${slug}.mailcheapmail.com`, postalAddress: "1 Main St, Paris" })))
	);
	user.newsletterId = url.split("/").at(-1);
	if (dailySendCap !== null) await m.Newsletter.updateOne({ accountId: user.accountId, _id: user.newsletterId }, { $set: { dailySendCap } });
	const rows = Array.from({ length: contacts }, (_, index) => ({ email: `reader${index}@${slug}.example.org`, status: "active" }));
	if (contacts) await as(user, () => m.contacts.importContacts({ newsletterId: user.newsletterId, consent: true, rows }));
	return user;
}

async function campaign(user) {
	const url = await as(user, () => catchRedirect(m.campaigns.createCampaign(user.newsletterId)));
	const id = url.split("/").at(-1);
	await as(user, () => m.campaigns.saveCampaign(id, { subject: "Issue", previewText: "This week", body: "<p>Hello</p>" }));
	return id;
}

const ledger = () => m.SesQuota.findById("ses-rolling-24h").lean();
const capOf = (user) => m.NewsletterCap.findById(`${user.newsletterId}:${new Date().toISOString().slice(0, 10)}`).lean();
const messagesOf = (user) => m.Message.find({ accountId: user.accountId, kind: "campaign" }).lean();

before(async () => {
	app = await startTestApp({ QSTASH_CURRENT_SIGNING_KEY: "sig-current", QSTASH_NEXT_SIGNING_KEY: "sig-next", MAITEAM_SEND_GATES: "on" });
	m = {
		newsletters: await import("../app/(app)/newsletters/actions.js"),
		campaigns: await import("../app/(app)/campaigns/actions.js"),
		contacts: await import("../app/(app)/contacts/actions.js"),
		sendBatchRoute: await import("../app/api/jobs/send-batch/route.js"),
		sending: await import("../lib/sending.js"),
		gate: await import("../lib/maiteam/send-gate.js"),
		sendRate: await import("../lib/send-rate.js"),
		Message: (await import("../models/Message.js")).default,
		Newsletter: (await import("../models/Newsletter.js")).default,
		SesQuota: (await import("../models/SesQuota.js")).default,
		NewsletterCap: (await import("../models/NewsletterCap.js")).default,
	};
	m.gate.setSendGateSeamsForTests({
		readAccount: async () => (quota.error ? { error: quota.error } : { ...quota }),
		waitForSlot: async (lane) => {
			slots.push(lane);
			if (slotError) throw slotError;
		},
	});
});

after(() => app?.stop());

beforeEach(async () => {
	Object.assign(quota, { max24HourSend: 200, sentLast24Hours: 0, maxSendRate: 1, error: null });
	slots.length = 0;
	slotError = null;
	m.gate.setSendGateSeamsForTests({});
	await m.SesQuota.deleteMany({});
	// Each test starts with no job left over from the one before.
	processed = published.length;
});

describe("maiteam send gates", () => {
	test("a campaign that fits goes out: quota and cap issued per email, stamped before handoff, at SES's own rate", async () => {
		const user = await customer("fits");
		const before = sesEmails.length;
		assert.deepEqual(await as(user, async () => m.campaigns.sendCampaign(await campaign(user), {})), { ok: true });
		const sent = (await runJobs()).reduce((sum, result) => sum + (result.sent ?? 0), 0);
		assert.equal(sent, 3);
		assert.equal(sesEmails.length - before, 3);
		assert.equal((await ledger()).issued, 3);
		assert.equal((await ledger()).holds.length, 0);
		assert.equal((await capOf(user)).issued, 3);
		for (const message of await messagesOf(user)) {
			assert.equal(message.senderDomain, "fits.mailcheapmail.com");
			assert.ok(message.handoffAt instanceof Date);
		}
		assert.ok(slots.every((lane) => lane.failClosed === true && lane.rate === 1), "min(14 configured, 6 app, 1 SES)");
	});

	test("an audience larger than the SES quota left is refused whole, not shortened", async () => {
		const user = await customer("quota");
		quota.max24HourSend = 2;
		const result = await as(user, async () => m.campaigns.sendCampaign(await campaign(user), {}));
		assert.match(JSON.stringify(result), /needs 3 emails and 2 remain today/);
		assert.equal((await messagesOf(user)).length, 0, "nothing queued");
	});

	test("a newsletter without a daily cap, or with 0, sends nothing", async () => {
		const unset = await customer("nocap", { dailySendCap: null });
		assert.match(JSON.stringify(await as(unset, async () => m.campaigns.sendCampaign(await campaign(unset), {}))), /no daily send cap/);
		const closed = await customer("closed", { dailySendCap: 0 });
		assert.match(JSON.stringify(await as(closed, async () => m.campaigns.sendCampaign(await campaign(closed), {}))), /needs 3 emails and 0 remain today/);
		const before = sesEmails.length;
		const id = await campaign(closed);
		await assert.rejects(() => m.sending.sendTestEmail({ accountId: closed.accountId, campaignId: id, to: "me@closed.example.org" }), /daily send cap is 0/);
		assert.equal(sesEmails.length, before);
	});

	test("the warm-up holds a new sender domain to 50 a day, whatever the cap says", async () => {
		const user = await customer("warm", { contacts: 60, dailySendCap: 500 });
		assert.match(JSON.stringify(await as(user, async () => m.campaigns.sendCampaign(await campaign(user), {}))), /needs 60 emails and 50 remain today/);
	});

	test("a quota that can't be read, or a send slot that can't be taken, sends nothing and returns every hold", async () => {
		const user = await customer("down");
		assert.deepEqual(await as(user, async () => m.campaigns.sendCampaign(await campaign(user), {})), { ok: true });
		const before = sesEmails.length;
		quota.error = "AccessDenied";
		m.gate.setSendGateSeamsForTests({});
		let results = await runJobs();
		assert.equal(sesEmails.length, before);
		assert.ok(results.some((result) => result.retry), "the batch comes back later");
		quota.error = null;
		slotError = Object.assign(new Error("Redis down"), { name: "Throttling" });
		m.gate.setSendGateSeamsForTests({});
		// The retry QStash got, delivered now.
		results = await runJobs();
		assert.equal(sesEmails.length, before);
		assert.equal((await ledger())?.holds?.length ?? 0, 0, "quota holds released");
		assert.equal((await capOf(user))?.holds?.length ?? 0, 0, "cap holds released");
		assert.ok((await messagesOf(user)).every((message) => message.status === "queued"));
	});

	test("an ambiguous provider error keeps the email counted: the ledgers can under-send, never overspend", async () => {
		const user = await customer("unsure", { contacts: 1 });
		sesState.failNext = { name: "sendSesEmail", error: new Error("socket hang up") };
		assert.deepEqual(await as(user, async () => m.campaigns.sendCampaign(await campaign(user), {})), { ok: true });
		await runJobs();
		assert.equal((await ledger()).issued, 1);
		assert.equal((await capOf(user)).issued, 1);
	});

	// QA r2 item 2 (FRA-25999): a hold left behind by a failed release, retried through the real gate. QA's exact case:
	// the account is full (max 1, sent 1) and the retained hold must not count as permission.
	test("a retained hold is reused only while every reservation still fits the account's current room", async () => {
		const user = await customer("retained", { contacts: 0 });
		const newsletter = await m.Newsletter.findOne({ accountId: user.accountId, _id: user.newsletterId }).lean();
		const queued = async () => (await m.Message.create({ accountId: user.accountId, newsletterId: user.newsletterId, kind: "test", email: "reader@retained.example.org", status: "queued" })).toObject();
		const seed = (holds) => m.SesQuota.create({ _id: "ses-rolling-24h", revision: 1, issued: 0, reserved: holds.length, issuedLog: [], accountedSent: 0, accountedAt: Date.now() - 1000, holds });
		const attempt = async (message) => {
			let calls = 0;
			const error = await m.gate
				.gateDelivery({ message, newsletter, send: async () => ((calls += 1), { providerMessageId: "stub-only" }) })
				.then(() => null, (caught) => caught);
			return { calls, error };
		};

		const full = await queued();
		await seed([{ key: `message:${full._id}`, amount: 1 }]);
		Object.assign(quota, { max24HourSend: 1, sentLast24Hours: 1 });
		const refused = await attempt(full);
		assert.equal(refused.calls, 0);
		assert.equal(refused.error?.name, "SendGateRefused");
		assert.equal((await m.Message.findOne({ accountId: user.accountId, _id: full._id }).lean()).status, "queued");
		assert.equal((await ledger()).holds.length, 1, "the hold stays until the email is sent or released");

		// Another email's outstanding hold shares the room: two holds and one email of room is still refused.
		await m.SesQuota.deleteMany({});
		const other = await queued();
		await seed([{ key: `message:${full._id}`, amount: 1 }, { key: `message:${other._id}`, amount: 1 }]);
		Object.assign(quota, { max24HourSend: 2, sentLast24Hours: 1 });
		m.gate.setSendGateSeamsForTests({});
		assert.equal((await attempt(full)).calls, 0);

		// With room for every reservation, the same hold is reused once, not taken twice.
		Object.assign(quota, { max24HourSend: 10, sentLast24Hours: 1 });
		m.gate.setSendGateSeamsForTests({});
		const reused = await attempt(full);
		assert.equal(reused.error, null);
		assert.equal(reused.calls, 1);
		const after = await ledger();
		assert.deepEqual(after.holds.map(({ key }) => key), [`message:${other._id}`]);
		assert.equal(after.issued, 1);
	});

	test("the real send slot refuses without a shared count when asked to fail closed", async () => {
		const saved = [process.env.UPSTASH_REDIS_REST_URL, process.env.UPSTASH_REDIS_REST_TOKEN];
		delete process.env.UPSTASH_REDIS_REST_URL;
		delete process.env.UPSTASH_REDIS_REST_TOKEN;
		try {
			await assert.rejects(() => m.sendRate.waitForSendSlot({ name: "gate-test", rate: 6, failClosed: true }), { name: "Throttling" });
			await m.sendRate.waitForSendSlot({ name: "gate-test-open", rate: 6 });
		} finally {
			if (saved[0] !== undefined) process.env.UPSTASH_REDIS_REST_URL = saved[0];
			if (saved[1] !== undefined) process.env.UPSTASH_REDIS_REST_TOKEN = saved[1];
		}
		// With a shared count that can't be reached, it refuses too, instead of spacing per instance.
		await withEnv({ UPSTASH_REDIS_REST_URL: "https://redis.invalid", UPSTASH_REDIS_REST_TOKEN: "token" }, async () => {
			await assert.rejects(() => m.sendRate.waitForSendSlot({ name: "gate-test-down", rate: 6, failClosed: true }), { name: "Throttling" });
		});
		assert.equal(m.gate.gatedRate(14, 1), 1);
		assert.equal(m.gate.gatedRate(14, 20), 6);
		assert.equal(m.gate.gatedRate(3, 20), 3);
	});
});
