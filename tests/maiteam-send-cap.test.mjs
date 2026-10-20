import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { activate, as, callApi, catchRedirect, form, signIn, startTestApp } from "./helpers/app.mjs";

// P4b (PATCHES.md), QA r1 item 7 (FRA-25999): the operator's control over P4's daily cap, restored. The dashboard,
// the API and MCP set it through one action; the Sender page shows today's limit and the sender domain's warm-up.
let app;
let m;

before(async () => {
	app = await startTestApp();
	m = {
		newsletters: await import("../app/(app)/newsletters/actions.js"),
		apiKeys: await import("../app/(app)/api-keys/actions.js"),
		senderPage: await import("../app/(app)/newsletters/sender/page.js"),
		Newsletter: (await import("../models/Newsletter.js")).default,
	};
});

after(() => app?.stop());

async function customer(slug) {
	const user = await signIn(`${slug}@example.com`);
	await activate(user);
	const url = await as(user, () =>
		catchRedirect(m.newsletters.saveNewsletter(null, form({ name: `${slug} news`, slug, fromEmail: `hello@${slug}.mailcheapmail.com`, postalAddress: "1 Main St, Paris" })))
	);
	user.newsletterId = url.split("/").at(-1);
	user.key = (await as(user, () => m.apiKeys.createApiKey(null, form({ name: "Ops", level: "full" })))).key;
	return user;
}

test("the daily cap is set, read and cleared through one action, and the warm-up lowers today's limit", async () => {
	const user = await customer("send-cap");
	const path = `/api/v1/newsletters/${user.newsletterId}/send-cap`;
	const set = await callApi("PATCH", path, { key: user.key, body: { dailySendCap: 500 } });
	assert.equal(set.status, 200, JSON.stringify(set.body));
	assert.deepEqual([set.body.dailySendCap, set.body.source, set.body.limit, set.body.usedToday], [500, "newsletter", 50, 0], "warm-up level 1 is 50 a day");
	assert.equal(set.body.warmup.label, "Warm-up not started, cap 50");
	assert.equal((await m.Newsletter.findOne({ accountId: user.accountId, _id: user.newsletterId }).lean()).dailySendCap, 500);

	const closed = await callApi("PATCH", path, { key: user.key, body: { dailySendCap: 0 } });
	assert.deepEqual([closed.body.dailySendCap, closed.body.limit], [0, 0], "zero sends nothing");
	assert.equal((await callApi("PATCH", path, { key: user.key, body: { dailySendCap: -1 } })).status, 400);

	const cleared = await callApi("PATCH", path, { key: user.key, body: { dailySendCap: null } });
	assert.deepEqual([cleared.body.dailySendCap, cleared.body.source, cleared.body.limit], [null, null, null], "no cap anywhere: every send refused");
	assert.equal((await m.Newsletter.findOne({ accountId: user.accountId, _id: user.newsletterId }).lean()).dailySendCap, undefined);
	const read = await callApi("GET", path, { key: user.key });
	assert.equal(read.status, 200);
	assert.equal(read.body.limit, null);

	const other = await customer("send-cap-other");
	assert.equal((await callApi("PATCH", path, { key: other.key, body: { dailySendCap: 9 } })).status, 404, "another account's newsletter is not found");
});

test("the Sender page shows the cap field, today's limit and the warm-up; the dashboard saves it", async () => {
	const user = await customer("send-cap-page");
	const saved = await as(user, () => m.newsletters.saveSendCap(user.newsletterId, 120));
	assert.deepEqual([saved.ok, saved.status.dailySendCap, saved.status.limit], [true, 120, 50]);
	const html = renderToStaticMarkup(await as(user, () => m.senderPage.default()));
	assert.match(html, /Daily sending/);
	assert.match(html, /name="dailySendCap"[^>]*value="120"/);
	assert.match(html, /Today&#x27;s limit 50, 0 used\./);
	assert.match(html, /Warm-up not started, cap 50/);
	const refused = await as(user, () => m.newsletters.saveSendCap(user.newsletterId, 1.5));
	assert.ok(refused.error);
});
