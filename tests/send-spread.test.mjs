import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import {
	getAllowance,
	getBatchStarts,
	getGrowth,
	getPace,
	getPaceHours,
	getPaceRoom,
	getProvenEmails,
	getSendHours,
	getSpreadEnd,
	getWarmup,
	getWarmupDay,
} from "../lib/send-spread.js";
import { activate, as, catchRedirect, form, jsonRequest, platformEmails, proveVolume, signIn, startTestApp } from "./helpers/app.mjs";
import { published } from "./stubs/qstash.mjs";

const HOUR_MS = 3_600_000;
const CLOUD = { MAILCHEAP_CLOUD: "true" };

test("the warm-up runs 30 days from the first campaign, on mailcheap Cloud only", () => {
	const now = new Date("2026-10-13T12:00:00Z");
	assert.equal(getWarmupDay({}, now), 0, "before the first campaign");
	assert.equal(getWarmupDay({ spreadUntil: getSpreadEnd(now) }, now), 1, "the first campaign was just now");
	assert.equal(getWarmupDay({ spreadUntil: getSpreadEnd(new Date("2026-10-11T00:00:00Z")) }, now), 3, "two and a half days in");
	assert.equal(getWarmupDay({ spreadUntil: "2026-10-13T13:00:00.000Z" }, now), 30, "its last hour, from a serialized date");
	assert.equal(getWarmupDay({ spreadUntil: now }, now), null, "over, or ended by an admin");
	assert.equal(getSpreadEnd(now).toISOString(), "2026-11-12T12:00:00.000Z");

	assert.deepEqual(getWarmup({}, { now, env: CLOUD }), { days: 30, day: 0, hasStarted: false, progress: 0, endsAt: null });
	const started = getWarmup({ spreadUntil: getSpreadEnd(new Date("2026-10-11T00:00:00Z")) }, { now, env: CLOUD });
	assert.deepEqual([started.day, started.hasStarted, started.endsAt], [3, true, "2026-11-10T00:00:00.000Z"]);
	assert.ok(Math.abs(started.progress - 2.5 / 30) < 1e-9);
	assert.equal(getWarmup({ spreadUntil: now }, { now, env: CLOUD }), null);
	assert.equal(getWarmup({}, { now, env: { MAILCHEAP_CLOUD: "" } }), null, "no warm-up on a self-hosted server");
	assert.equal(getPace({}, { proven: 0, now, env: { MAILCHEAP_CLOUD: "" } }), null, "which sends at full speed");
});

test("a send can be 2 times its proven volume on the warm-up's first day, 5 times by its last day and after it, 200 emails at least", () => {
	assert.equal(getGrowth(0), 2, "before the first campaign");
	assert.equal(getGrowth(1), 2);
	assert.ok(Math.abs(getGrowth(15) - (2 + (3 * 14) / 29)) < 1e-9, "a little more each day");
	assert.equal(getGrowth(30), 5);
	assert.equal(getGrowth(null), 5, "after the warm-up");
	assert.equal(getAllowance({ proven: 0, day: 1 }), 200);
	assert.equal(getAllowance({ proven: 30, day: null }), 200);
	assert.equal(getAllowance({ proven: 1000, day: 1 }), 2000);
	assert.equal(getAllowance({ proven: 1000, day: null }), 5000);
});

test("small sends go out at once on day 1; bigger ones over 4 hours plus 4 for each doubling, 72 at most", () => {
	const dayOne = { proven: 0, day: 1 };
	assert.equal(getSendHours({ emails: 2, ...dayOne }), 0, "2 contacts don't wait");
	assert.equal(getSendHours({ emails: 200, ...dayOne }), 0);
	assert.equal(getSendHours({ emails: 400, ...dayOne }), 8, "twice what goes at full speed");
	assert.equal(getSendHours({ emails: 10_000, ...dayOne }), 27);
	assert.equal(getSendHours({ emails: 40, recent: 10_000, ...dayOne }), 0, "one batch always goes at once");
	assert.equal(getSendHours({ emails: 50_000_000, ...dayOne }), 72, "3 days at most");
	assert.equal(getSendHours({ emails: 2000, proven: 1000, day: 1 }), 0, "twice what it proved, on day 1");
	assert.equal(getSendHours({ emails: 3000, proven: 1000, day: 1 }), 7, "3 times");
});

test("the warm-up can't be gamed: tiny sends prove nothing, and a send split in small ones keeps one pace", () => {
	assert.equal(getSendHours({ emails: 10_000, recent: 5, proven: 0, day: 1 }), 27, "10,000 right after five 1-recipient sends");
	assert.equal(getSendHours({ emails: 10_000, proven: 1, day: 5 }), 27, "or days after them");
	assert.equal(getSendHours({ emails: 10_000, proven: 1, day: null }), 27, "or past day 30");
	assert.equal(
		getSendHours({ emails: 200, recent: 200, proven: 0, day: 1 }),
		getSendHours({ emails: 400, proven: 0, day: 1 }),
		"200 more right after 200 go out like one send of 400"
	);
	assert.equal(getSendHours({ emails: 4000, recent: 6000, proven: 1000, day: null }), 8, "a send beside others counts with them");
});

test("after the warm-up, a send up to 5 times its proven volume goes at full speed; a jump far over it is paced", () => {
	assert.equal(getSendHours({ emails: 5000, proven: 1000, day: null }), 0);
	assert.equal(getSendHours({ emails: 10_000, proven: 1000, day: null }), 8, "10 times");
	assert.equal(getSendHours({ emails: 100_000, proven: 1000, day: null }), 22, "100 times");
	assert.equal(getSendHours({ emails: 10_000, proven: 0, day: null }), 27, "nothing proven in 60 days");
});

test("proven volume: the largest campaign of the last 60 days under the pause level, a day after it went out", () => {
	const now = new Date("2026-10-13T12:00:00Z");
	const ago = (hours) => new Date(now.getTime() - hours * HOUR_MS);
	const sent = (count, at, extra = {}) => ({ stats: { sent: count, ...extra }, finishedAt: at });
	assert.equal(getProvenEmails([], now), 0);
	assert.equal(getProvenEmails([sent(1000, ago(48)), sent(3000, ago(30)), sent(800, ago(200))], now), 3000);
	assert.equal(getProvenEmails([sent(5000, ago(12))], now), 0, "its bounces and complaints are still coming in");
	assert.equal(getProvenEmails([sent(5000, ago(61 * 24))], now), 0, "older than 60 days");
	assert.equal(getProvenEmails([sent(1000, ago(48), { bounced: 25 })], now), 0, "2.5% bounces");
	assert.equal(getProvenEmails([sent(1000, ago(48), { complained: 2 })], now), 0, "0.2% complaints");
	assert.equal(getProvenEmails([sent(1000, ago(48), { bounced: 4, complained: 1 })], now), 1000, "a few bounces and one complaint");
	assert.equal(
		getProvenEmails([{ stats: { sent: 900 }, lastChance: { sent: 100 }, sentAt: ago(72) }], now),
		1000,
		"last-chance emails count, and a campaign from before finishedAt goes by sentAt"
	);
	assert.equal(getProvenEmails([{ stats: { sent: 1000 }, sentAt: ago(30 * 24), finishedAt: ago(2) }], now), 0, "a step that just went out");
});

test("the dashboard adds a first send's 3-hour check to a paced send's hours, and says how much goes out at once", () => {
	const dayOne = { proven: 0, recent: 0, warmup: { day: 1 } };
	assert.equal(getPaceHours(dayOne, { emails: 2 }), 0);
	assert.equal(getPaceHours(dayOne, { emails: 10_000, newContacts: 10_000 }), 30, "27 hours, and the check");
	assert.equal(getPaceHours(dayOne, { emails: 10_000 }), 27, "nobody new");
	assert.equal(getPaceHours({ proven: 1000, recent: 0, warmup: null }, { emails: 5000, newContacts: 5000 }), 0, "a first send at full speed");
	assert.equal(getPaceHours(null, { emails: 10_000 }), 0, "self-hosted");
	assert.equal(getPaceRoom({ proven: 1000, recent: 300, warmup: { day: 1 } }), 1700);
	assert.equal(getPaceRoom({ proven: 0, recent: 300, warmup: { day: 1 } }), 50, "one batch always goes at once");
});

test("batches start evenly over the spread, the first right away and the last at its end", () => {
	const now = Date.parse("2026-10-13T12:00:00Z");
	const seconds = (hours) => Math.floor((now + hours * HOUR_MS) / 1000);
	assert.deepEqual(getBatchStarts(5, 8 * HOUR_MS, now), [null, seconds(2), seconds(4), seconds(6), seconds(8)]);
	assert.deepEqual(getBatchStarts(1, 8 * HOUR_MS, now), [null], "one batch goes at once");
	assert.deepEqual(getBatchStarts(3, 0, now), [null, null, null], "no spread, back to back");
	assert.deepEqual(getBatchStarts(0, 8 * HOUR_MS, now), []);
});

describe("sends earn their pace", () => {
	let app;
	let m;

	// isNew: before its first campaign. Otherwise past its warm-up, as signIn leaves it.
	async function setup(email, contacts, { isMailed = false, isNew = false, emails = 100_000 } = {}) {
		const user = await signIn(email);
		await activate(user, { limitOverrides: { emailsPerMonth: emails, subscribers: 100_000 } });
		if (isNew) await m.Account.updateOne({ _id: user.accountId }, { $unset: { spreadUntil: 1 } });
		const slug = email.split("@")[0];
		const url = await as(user, () => catchRedirect(m.newsletters.saveNewsletter(null, form({ name: slug, slug, postalAddress: "1 Main St" }))));
		user.newsletterId = url.split("/").at(-1);
		await m.Contact.insertMany(
			Array.from({ length: contacts }, (_, index) => ({
				accountId: user.accountId,
				newsletterId: user.newsletterId,
				email: `reader${index}@${slug}.example.org`,
				status: "active",
				...(isMailed && { lastSentAt: new Date(Date.now() - 3 * 86_400_000) }),
			}))
		);
		return user;
	}

	async function draft(user) {
		const draftUrl = await as(user, () => catchRedirect(m.campaigns.createCampaign(user.newsletterId)));
		const campaignId = draftUrl.split("/").at(-1);
		await as(user, () => m.campaigns.saveCampaign(campaignId, { subject: "Issue", previewText: "Hi", body: "<p>Hello</p>" }));
		return campaignId;
	}

	const sortJobs = (jobs) => ({
		batches: jobs.filter(({ url }) => url.endsWith("/api/jobs/send-batch")),
		checks: jobs.filter(({ url }) => url.endsWith("/api/jobs/check-first-send")),
	});

	// What one send published, in order.
	async function send(user, campaignId, options = {}) {
		const from = published.length;
		assert.deepEqual(await as(user, () => m.campaigns.sendCampaign(campaignId, options)), { ok: true });
		return sortJobs(published.slice(from));
	}

	async function runBatches(batches) {
		for (const batch of batches) await m.sendBatchRoute.POST(jsonRequest(batch.url, { method: "POST", body: batch.body }));
	}

	// Each batch's start, in hours from the send.
	function startHours(batches, start) {
		return batches.map(({ notBefore }) => (notBefore === undefined ? 0 : Math.round(((notBefore * 1000 - start) / HOUR_MS) * 100) / 100));
	}

	const campaignOf = (user, campaignId) => m.Campaign.findOne({ accountId: user.accountId, _id: campaignId }).lean();
	const isAtOnce = (batches) => batches.every(({ notBefore }) => notBefore === undefined);

	before(async () => {
		app = await startTestApp({ QSTASH_CURRENT_SIGNING_KEY: "sig-current", QSTASH_NEXT_SIGNING_KEY: "sig-next", SEND_RATE_PER_SECOND: "1000" });
		m = {
			newsletters: await import("../app/(app)/newsletters/actions.js"),
			campaigns: await import("../app/(app)/campaigns/actions.js"),
			sendBatchRoute: await import("../app/api/jobs/send-batch/route.js"),
			checkRoute: await import("../app/api/jobs/check-first-send/route.js"),
			accounts: await import("../lib/accounts.js"),
			Account: (await import("../models/Account.js")).default,
			Campaign: (await import("../models/Campaign.js")).default,
			Contact: (await import("../models/Contact.js")).default,
			Message: (await import("../models/Message.js")).default,
		};
	});

	after(() => app?.stop());

	test("a small send goes out at once on day 1, and starts the 30-day warm-up", async () => {
		const user = await setup("small-first@example.com", 2, { isNew: true });
		const start = Date.now();
		const campaignId = await draft(user);
		const { batches, checks } = await send(user, campaignId);
		assert.deepEqual(startHours(batches, start), [0]);
		assert.equal(checks.length, 0);
		const sending = await campaignOf(user, campaignId);
		assert.deepEqual([sending.spreadHours, sending.sendingUntil], [undefined, undefined]);
		const { spreadUntil } = await m.Account.findById(user.accountId).lean();
		assert.ok(Math.abs(spreadUntil.getTime() - getSpreadEnd(new Date(start)).getTime()) < 60_000);
	});

	test("tiny sends don't finish the warm-up: 10,000 contacts after five 1-recipient sends go out over 27 hours, behind a checked slice", async () => {
		const user = await setup("tiny-sends@example.com", 10_000, { isNew: true });
		for (let index = 0; index < 5; index++) {
			const { batches } = await send(user, await draft(user), { audienceLimit: 1 });
			assert.ok(isAtOnce(batches), "each goes at once");
			await runBatches(batches);
		}

		const campaignId = await draft(user);
		const start = Date.now();
		const { batches, checks } = await send(user, campaignId);
		const sending = await campaignOf(user, campaignId);
		assert.equal(sending.spreadHours, 27, "like a first send of 10,000");
		assert.deepEqual({ slice: sending.firstSend.slice, held: sending.firstSend.held }, { slice: 500, held: 9499 });
		// The slice and the one contact mailed before go first, over their share of the 27 hours.
		const sliceHours = (27 * 501) / 10_000;
		assert.equal(batches.length, 11);
		assert.ok(Math.abs(startHours(batches, start).at(-1) - sliceHours) < 0.02);
		assert.equal(checks.length, 1);
		assert.ok(Math.abs(checks[0].notBefore * 1000 - (start + (sliceHours + 3) * HOUR_MS)) < 120_000, "3 hours after the slice");
		assert.ok(Math.abs(sending.sendingUntil.getTime() - (start + 30 * HOUR_MS)) < 120_000, "27 hours and the check");

		await runBatches(batches);
		const from = published.length;
		const checkedAt = Date.now();
		const check = await (await m.checkRoute.POST(jsonRequest(checks[0].url, { method: "POST", body: checks[0].body }))).json();
		assert.equal(check.released, 9499);
		const rest = sortJobs(published.slice(from)).batches;
		assert.equal(rest.length, 190);
		assert.ok(Math.abs(startHours(rest, checkedAt).at(-1) - (27 - sliceHours)) < 0.02, "the rest over the rest of the 27 hours");
	});

	test("after day 30, a jump far over proven volume is paced behind the same first-slice check; up to 5 times goes at full speed", async () => {
		const user = await setup("past-warmup@example.com", 2000);
		await proveVolume(user, 200);
		const campaignId = await draft(user);
		const start = Date.now();
		const { checks } = await send(user, campaignId);
		const sending = await campaignOf(user, campaignId);
		assert.equal(sending.spreadHours, 8, "10 times its proven volume");
		assert.deepEqual({ slice: sending.firstSend.slice, held: sending.firstSend.held }, { slice: 200, held: 1800 });
		assert.ok(Math.abs(checks[0].notBefore * 1000 - (start + (0.8 + 3) * HOUR_MS)) < 120_000);
		assert.ok(Math.abs(sending.sendingUntil.getTime() - (start + 11 * HOUR_MS)) < 120_000);

		const steady = await setup("steady-sender@example.com", 2000, { isMailed: true });
		await proveVolume(steady, 500);
		const { batches, checks: none } = await send(steady, await draft(steady));
		assert.ok(isAtOnce(batches), "4 times its proven volume");
		assert.equal(none.length, 0);
	});

	test("a campaign over the pause level, or less than a day old, proves nothing", async () => {
		const user = await setup("unproven@example.com", 1000, { isMailed: true });
		await proveVolume(user, 1000, { bounced: 25 });
		await proveVolume(user, 1000, { hoursAgo: 2 });
		const campaignId = await draft(user);
		await send(user, campaignId);
		assert.equal((await campaignOf(user, campaignId)).spreadHours, 14, "paced as if nothing was sent: 5 times 200 emails");
	});

	test("a send in steps keeps one pace: the next 200 right after 200 go out like one send of 400", async () => {
		const user = await setup("in-steps@example.com", 600, { isMailed: true });
		const campaignId = await draft(user);
		const first = await send(user, campaignId, { audienceLimit: 200 });
		assert.ok(isAtOnce(first.batches));
		await runBatches(first.batches);

		const from = published.length;
		const start = Date.now();
		assert.deepEqual(await as(user, () => m.campaigns.sendCampaignToMore(campaignId, { additional: 200 })), { ok: true });
		const { batches } = sortJobs(published.slice(from));
		assert.equal((await campaignOf(user, campaignId)).spreadHours, 8);
		assert.deepEqual(startHours(batches, start), [0, 2.67, 5.33, 8]);
	});

	test("pausing doesn't speed a send up, and its pause and block levels stop it as before", async () => {
		const user = await setup("paced-rates@example.com", 1000, { isMailed: true });
		const campaignId = await draft(user);
		const { batches } = await send(user, campaignId);
		assert.equal((await campaignOf(user, campaignId)).spreadHours, 14);
		await runBatches(batches.slice(0, 2));
		await m.Campaign.updateOne({ accountId: user.accountId, _id: campaignId }, { $set: { "stats.bounced": 5 } });
		const emailsBefore = platformEmails.length;
		await runBatches(batches.slice(2, 3));
		const paused = await campaignOf(user, campaignId);
		assert.deepEqual([paused.status, paused.pauseCode], ["paused", "high_rates"], "5% bounces");
		assert.deepEqual(
			platformEmails.slice(emailsBefore).map(({ subject }) => subject),
			["[mailcheap] Campaign paused"]
		);

		const from = published.length;
		const resumedAt = Date.now();
		assert.deepEqual(await as(user, () => m.campaigns.resumeCampaign(campaignId)), { ok: true });
		const resumed = sortJobs(published.slice(from)).batches;
		assert.equal((await campaignOf(user, campaignId)).spreadHours, 14, "a resume keeps its pace");
		assert.ok(Math.abs(startHours(resumed, resumedAt).at(-1) - 14) < 0.02);

		await m.Campaign.updateOne({ accountId: user.accountId, _id: campaignId }, { $set: { "stats.bounced": 11 } });
		await runBatches(resumed.slice(0, 1));
		assert.equal((await m.Account.findById(user.accountId).lean()).status, "paused", "11% bounces block the account");
		assert.equal((await campaignOf(user, campaignId)).pauseCode, "account_blocked");
	});

	test("plan limits come first, and pacing never refuses a send", async () => {
		const user = await setup("paced-plan@example.com", 1000, { isMailed: true, emails: 600 });
		const campaignId = await draft(user);
		assert.equal((await as(user, () => m.campaigns.sendCampaign(campaignId, {}))).code, "plan_limit_emails");
		await send(user, campaignId, { audienceLimit: 600 });
		assert.equal((await campaignOf(user, campaignId)).spreadHours, 11, "600 emails with nothing proven go out, over 11 hours");
	});

	test("an admin ending the warm-up leaves the 5 times rule, and starting it again begins at 2 times", async () => {
		const user = await setup("trusted@example.com", 450, { isMailed: true });
		await proveVolume(user, 100);
		assert.equal(await m.accounts.setSendSpread(user.accountId, false), true);
		assert.equal((await m.Account.findById(user.accountId).lean()).spreadUntil <= new Date(), true);
		assert.ok(isAtOnce((await send(user, await draft(user))).batches), "450 emails are under 5 times 100");

		assert.equal(await m.accounts.setSendSpread(user.accountId, true), true);
		const { spreadUntil } = await m.Account.findById(user.accountId).lean();
		assert.ok(spreadUntil.getTime() > Date.now() + 29 * 24 * HOUR_MS, "for another 30 days");
		const again = await send(user, await draft(user));
		assert.ok(again.batches.slice(1).every(({ notBefore }) => notBefore > Date.now() / 1000), "over 2 times 100, with the first send still going out");
	});
});
