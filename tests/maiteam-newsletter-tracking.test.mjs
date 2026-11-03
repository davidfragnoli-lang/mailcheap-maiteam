import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { getCleanupSettings } from "../lib/cleanup.js";
import { toNewsletterSettings } from "../lib/newsletter-settings.js";
import { activate, as, callApi, catchRedirect, form, signIn, startTestApp } from "./helpers/app.mjs";
import { flushAfter } from "./stubs/next-server.mjs";
import { published } from "./stubs/qstash.mjs";
import { sent as sesEmails } from "./stubs/ses.mjs";

// PATCHES.md P15 (FRA-26543): a newsletter's tracking: false sends every email it sends with no open pixel and no
// tracked links (welcome, sequence steps and issues; confirmation and last-chance never had them), and its list
// cleanup doesn't run, since with no opens or clicks every reader would look inactive. Unset is on, as upstream.

test("tracking is on unless saved false, and list cleanup only runs with it", () => {
	assert.equal(toNewsletterSettings(null).tracking, true, "new newsletters track, as upstream");
	assert.equal(toNewsletterSettings({ name: "x" }).tracking, true, "a newsletter saved before P15 tracks");
	assert.equal(toNewsletterSettings({ name: "x", tracking: false }).tracking, false);
	assert.equal(getCleanupSettings({ cleanup: { enabled: true } }).enabled, true);
	assert.equal(getCleanupSettings({ cleanup: { enabled: true }, tracking: true }).enabled, true);
	assert.equal(getCleanupSettings({ cleanup: { enabled: true }, tracking: false }).enabled, false);
	assert.equal(getCleanupSettings({ cleanup: { enabled: false }, tracking: false }).enabled, false);
});

describe("on a server", () => {
	let app;
	let m;
	let processed = 0;

	before(async () => {
		app = await startTestApp({ QSTASH_CURRENT_SIGNING_KEY: "sig-current", QSTASH_NEXT_SIGNING_KEY: "sig-next" });
		m = {
			apiKeys: await import("../app/(app)/api-keys/actions.js"),
			newsletters: await import("../app/(app)/newsletters/actions.js"),
			store: await import("../lib/maiteam/sequence-store.js"),
			gate: await import("../lib/maiteam/send-gate.js"),
			Newsletter: (await import("../models/Newsletter.js")).default,
		};
	});
	after(() => app?.stop());
	beforeEach(() => {
		processed = published.length;
		m.gate.setSendGateSeamsForTests({ waitForSlot: async () => {} });
	});

	async function customer(slug) {
		const user = await signIn(`${slug}@example.com`);
		await activate(user);
		const url = await as(user, () =>
			catchRedirect(m.newsletters.saveNewsletter(null, form({ name: `${slug} news`, slug, fromEmail: `hello@${slug}.mailcheapmail.com`, postalAddress: "1 Main St, Paris" })))
		);
		user.newsletterId = url.split("/").at(-1);
		await m.Newsletter.updateOne({ accountId: user.accountId, _id: user.newsletterId }, { $set: { requireConfirmation: false } });
		user.key = (await as(user, () => m.apiKeys.createApiKey(null, form({ name: "Site", level: "full" })))).key;
		return user;
	}

	async function runStepJobs() {
		const results = [];
		const end = published.length;
		while (processed < end) {
			const job = published[processed++];
			if (!job.url.endsWith("/api/jobs/sequence-step")) continue;
			const now = Math.max(Date.now(), (job.notBefore ?? 0) * 1000 + 1000);
			results.push(await m.store.runSequenceStep({ ...job.body, now }));
		}
		return results;
	}

	// One sequence step with a link, sent to one reader; the email the provider got.
	async function sendStep(user, reader) {
		const sequence = await callApi("POST", "/api/v1/sequences", {
			key: user.key,
			body: { status: "active", name: "answer", slug: "answer", steps: [{ delayDays: 1, subject: "The answer", markdown: "Read [the page](https://example.org/page?a=1)." }] },
		});
		assert.equal(sequence.status, 201, JSON.stringify(sequence.body));
		const signup = await callApi("POST", "/api/v1/contacts", { key: user.key, body: { email: reader, sequence: "answer" } });
		assert.equal(signup.status, 201, JSON.stringify(signup.body));
		await flushAfter();
		const results = await runStepJobs();
		assert.deepEqual(results.map(({ outcome }) => outcome), ["sent"], JSON.stringify(results));
		const emails = sesEmails.filter((email) => email.to === reader && email.tags.find(({ name }) => name === "kind")?.value === "sequence");
		assert.equal(emails.length, 1);
		return emails[0];
	}

	test("the REST API saves and reads back tracking, and refuses a non-boolean", async () => {
		const user = await customer("track-api");
		const path = `/api/v1/newsletters/${user.newsletterId}`;
		assert.equal((await callApi("GET", path, { key: user.key })).body.tracking, true, "on by default");
		const off = await callApi("PATCH", path, { key: user.key, body: { tracking: false, cleanup: { enabled: true } } });
		assert.equal(off.status, 200, JSON.stringify(off.body));
		assert.equal(off.body.tracking, false);
		assert.equal(off.body.cleanup.enabled, false, "cleanup reads as off while tracking is off");
		assert.equal((await m.Newsletter.findOne({ accountId: user.accountId, _id: user.newsletterId }).lean()).tracking, false);
		const other = await callApi("PATCH", path, { key: user.key, body: { replyTo: "jane@example.com" } });
		assert.equal(other.body.tracking, false, "another change keeps it");
		assert.equal((await callApi("PATCH", path, { key: user.key, body: { tracking: "no" } })).status, 400);
		const on = await callApi("PATCH", path, { key: user.key, body: { tracking: true } });
		assert.equal(on.body.tracking, true);
		assert.equal(on.body.cleanup.enabled, true, "the saved cleanup setting comes back with tracking");
	});

	test("a sequence step from a newsletter with tracking off has no pixel and direct links; with it on, both", async () => {
		const tracked = await customer("track-on");
		const untracked = await customer("track-off");
		assert.equal((await callApi("PATCH", `/api/v1/newsletters/${untracked.newsletterId}`, { key: untracked.key, body: { tracking: false } })).status, 200);

		const on = await sendStep(tracked, "reader@track-on.example.org");
		assert.match(on.html, /\/o\/[^"]+"[^>]*width="1"/, "the open pixel");
		assert.match(on.html, /href="[^"]+\/c\/[^"]+"/, "a tracked link");

		const off = await sendStep(untracked, "reader@track-off.example.org");
		assert.doesNotMatch(off.html, /\/o\/|\/c\//, "no pixel and no tracked link");
		assert.match(off.html, /href="https:\/\/example\.org\/page\?a=1(&amp;)?[^"]*"/, "the link goes straight to its page");
		assert.ok(off.html.includes(off.unsubscribeUrl ?? "/unsubscribe"), "the unsubscribe link is still there");
		assert.equal(off.headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
	});
});
