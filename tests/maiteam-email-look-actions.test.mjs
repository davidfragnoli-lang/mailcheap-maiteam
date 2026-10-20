import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { activate, as, callApi, catchRedirect, form, signIn, startTestApp } from "./helpers/app.mjs";
import { sent } from "./stubs/ses.mjs";

// maiteam (PATCHES.md P3c): the storage contract the migration writes to, and the actions that save looks. A look is
// stored verbatim at Newsletter.theme.look and Campaign.look; unset is the newsletter's, then upstream's theme.
let app;
let m;

before(async () => {
	app = await startTestApp();
	m = {
		newsletters: await import("../app/(app)/newsletters/actions.js"),
		campaigns: await import("../app/(app)/campaigns/actions.js"),
		apiKeys: await import("../app/(app)/api-keys/actions.js"),
		look: await import("../lib/maiteam/email-look.js"),
		Newsletter: (await import("../models/Newsletter.js")).default,
		Campaign: (await import("../models/Campaign.js")).default,
	};
});

after(() => app?.stop());

async function setUp(email, slug) {
	const user = await signIn(email);
	await activate(user);
	const url = await as(user, () =>
		catchRedirect(m.newsletters.saveNewsletter(null, form({ name: "Field Notes", slug, fromName: "Jane", postalAddress: "1 Main St, Paris" })))
	);
	user.newsletterId = url.split("/").at(-1);
	return user;
}

async function draft(user) {
	const url = await as(user, () => catchRedirect(m.campaigns.createCampaign(user.newsletterId)));
	const id = url.split("/").at(-1);
	assert.deepEqual(await as(user, () => m.campaigns.saveCampaign(id, { subject: "Issue", previewText: "This week", body: "<p>Hello readers</p>" })), { ok: true });
	return id;
}

function landing() {
	return { ...m.look.presetTheme("landing"), wordmark: "Field Notes" };
}

describe("email looks", () => {
	test("the Design page saves the look verbatim at theme.look; settings and theme saves keep it; null takes it away", async () => {
		const user = await setUp("look-newsletter@example.com", "look-notes");
		const saved = await as(user, () => m.newsletters.saveEmailLook(user.newsletterId, landing()));
		assert.equal(saved.ok, true);
		assert.deepEqual(saved.look, m.look.parseThemeInput(landing()).theme);
		const stored = async () => (await m.Newsletter.findById(user.newsletterId).setOptions({ crossAccount: true }).lean()).theme;
		assert.deepEqual((await stored()).look, m.look.parseThemeInput(landing()).theme, "stored as the ported validation returns it");

		// Upstream's theme and settings saves replace the theme object; the look stays.
		assert.equal((await as(user, () => m.newsletters.saveTheme(user.newsletterId, { preset: "maiteam" }))).ok, true);
		assert.equal((await stored()).preset, "maiteam");
		assert.deepEqual((await stored()).look, saved.look);
		assert.equal((await as(user, () => m.newsletters.saveNewsletter(null, form({ id: user.newsletterId, name: "Field Notes", slug: "look-notes", description: "New" })))).ok, true);
		assert.deepEqual((await stored()).look, saved.look);

		// Refused with the ported messages, and nothing changes.
		assert.match((await as(user, () => m.newsletters.saveEmailLook(user.newsletterId, { ...landing(), light: { ...landing().light, accent: "red" } }))).error, /Light link colour must be a hex/);
		assert.match((await as(user, () => m.newsletters.saveEmailLook(user.newsletterId, { ...landing(), wordmark: "w".repeat(61) }))).error, /wordmark/);
		assert.ok((await as(user, () => m.newsletters.saveEmailLook(user.newsletterId, { preset: "neon" }))).error);
		assert.deepEqual((await stored()).look, saved.look);

		// A preset alone, from the API: its values fill in; a maiteam look without a product is company mail.
		const key = (await as(user, () => m.apiKeys.createApiKey(null, form({ name: "Agent", level: "full" })))).key;
		const viaApi = await callApi("PATCH", `/api/v1/newsletters/${user.newsletterId}/email-look`, { key, body: { look: { preset: "maiteam" } } });
		assert.equal(viaApi.status, 200);
		assert.deepEqual(viaApi.body.look, m.look.presetTheme("maiteam", "company"));
		assert.equal((await stored()).look.product, "company");

		assert.deepEqual(await as(user, () => m.newsletters.saveEmailLook(user.newsletterId, null)), { ok: true, look: null });
		assert.equal((await stored()).look, undefined);
		assert.equal((await stored()).preset, "maiteam", "upstream's theme is untouched");
	});

	test("another account's newsletter or campaign can't take a look", async () => {
		const owner = await setUp("look-owner@example.com", "look-owner");
		const other = await setUp("look-other@example.com", "look-other");
		const campaign = await draft(owner);
		assert.match((await as(other, () => m.newsletters.saveEmailLook(owner.newsletterId, landing()))).error, /Newsletter not found|Create a newsletter/);
		assert.ok((await as(other, () => m.campaigns.saveCampaign(campaign, { subject: "x", previewText: "", body: "<p>x</p>", look: landing() }))).error);
		assert.equal((await m.Newsletter.findById(owner.newsletterId).setOptions({ crossAccount: true }).lean()).theme?.look, undefined);
		assert.equal((await m.Campaign.findById(campaign).setOptions({ crossAccount: true }).lean()).look, undefined);
	});

	test("the editor saves an issue's own look at Campaign.look, null takes the newsletter's, and the test email uses it", async () => {
		const user = await setUp("look-campaign@example.com", "look-campaign");
		await as(user, () => m.newsletters.saveEmailLook(user.newsletterId, landing()));
		const id = await draft(user);
		const stored = async () => (await m.Campaign.findById(id).setOptions({ crossAccount: true }).lean()).look;
		assert.equal(await stored(), undefined, "a new issue takes the newsletter's");

		assert.deepEqual(await as(user, () => m.campaigns.sendTestCampaign(id)), { ok: true });
		assert.match(sent.at(-1).html, /bgcolor="#f4f1ea"/, "the newsletter's landing look");

		const letter = m.look.presetTheme("letter");
		assert.deepEqual(await as(user, () => m.campaigns.saveCampaign(id, { subject: "Issue", previewText: "", body: "<p>Hello readers</p>", look: letter })), { ok: true });
		assert.deepEqual(await stored(), letter);
		assert.deepEqual(await as(user, () => m.campaigns.saveCampaign(id, { subject: "Issue 2", previewText: "", body: "<p>Hello readers</p>" })), { ok: true });
		assert.deepEqual(await stored(), letter, "a save without a look leaves it");
		assert.deepEqual(await as(user, () => m.campaigns.sendTestCampaign(id)), { ok: true });
		assert.match(sent.at(-1).html, /<a style="color:#1e40af;"|class="title"/);
		assert.ok(!sent.at(-1).html.includes("#f4f1ea"), "the issue's letter look, not the newsletter's");

		assert.match((await as(user, () => m.campaigns.saveCampaign(id, { subject: "Issue", previewText: "", body: "<p>x</p>", look: { preset: "letter", light: { accent: "blue" } } }))).error, /hex/);
		assert.deepEqual(await stored(), letter);

		const copy = await as(user, () => catchRedirect(m.campaigns.duplicateCampaign(id)));
		assert.deepEqual((await m.Campaign.findById(copy.split("/").at(-1)).setOptions({ crossAccount: true }).lean()).look, letter, "a copy keeps its look");

		assert.deepEqual(await as(user, () => m.campaigns.saveCampaign(id, { subject: "Issue", previewText: "", body: "<p>x</p>", look: null })), { ok: true });
		assert.equal(await stored(), undefined);
	});

	test("HTML campaigns keep their own design: a look is refused, and turning one into HTML drops its look", async () => {
		const user = await setUp("look-html@example.com", "look-html");
		const key = (await as(user, () => m.apiKeys.createApiKey(null, form({ name: "Agent", level: "full" })))).key;
		const created = await callApi("POST", "/api/v1/campaigns", { key, body: { newsletter: user.newsletterId, subject: "Designed", format: "html", content: "<html><body><p>Own</p></body></html>" } });
		assert.equal(created.status, 201);
		const refused = await callApi("PATCH", `/api/v1/campaigns/${created.body.id}`, { key, body: { look: m.look.presetTheme("letter") } });
		assert.equal(refused.status, 400);
		assert.match(JSON.stringify(refused.body), /HTML campaigns keep their own design/);

		const id = await draft(user);
		await as(user, () => m.campaigns.saveCampaign(id, { subject: "Issue", previewText: "", body: "<p>x</p>", look: m.look.presetTheme("letter") }));
		const html = await callApi("PATCH", `/api/v1/campaigns/${id}`, { key, body: { format: "html", content: "<html><body>Own</body></html>" } });
		assert.equal(html.status, 200);
		assert.equal((await m.Campaign.findById(id).setOptions({ crossAccount: true }).lean()).look, undefined);
	});
});
