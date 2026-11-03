import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { getMaxNewslettersPerAccount, getNewsletterLimitMessage } from "../lib/maiteam/newsletter-limit.js";
import { activate, as, callApi, form, signIn, startTestApp, withEnv } from "./helpers/app.mjs";

// PATCHES.md P12 (FRA-26541): a self-hosted server sets how many newsletters an account has with
// MAILCHEAP_MAX_NEWSLETTERS_PER_ACCOUNT; unset or not a positive whole number, it's upstream's 3. mailcheap Cloud
// keeps upstream's 3 whatever the env says. The dashboard, the REST API and MCP all stop at the same number.
const ENV = "MAILCHEAP_MAX_NEWSLETTERS_PER_ACCOUNT";

test("unset or invalid is upstream's 3, a positive whole number is the cap, Cloud ignores it", () => {
	assert.equal(getMaxNewslettersPerAccount({}), 3);
	for (const raw of ["", " ", "0", "-1", "abc", "10.5", "1e1", "10 lists", "0x10", "99999999999999999999"]) {
		assert.equal(getMaxNewslettersPerAccount({ [ENV]: raw }), 3, JSON.stringify(raw));
	}
	assert.equal(getMaxNewslettersPerAccount({ [ENV]: "10" }), 10);
	assert.equal(getMaxNewslettersPerAccount({ [ENV]: " 10 " }), 10);
	assert.equal(getMaxNewslettersPerAccount({ [ENV]: "1" }), 1);
	assert.equal(getMaxNewslettersPerAccount({ [ENV]: "10", MAILCHEAP_CLOUD: "true" }), 3);
	assert.equal(getMaxNewslettersPerAccount({ [ENV]: "10", MAILCHEAP_CLOUD: "false" }), 10, "only the exact value counts as Cloud");
	assert.equal(getNewsletterLimitMessage(3), "An account has up to 3 newsletters", "upstream's message");
	assert.equal(getNewsletterLimitMessage(10), "An account has up to 10 newsletters");
});

describe("on a server", () => {
	let app;
	let m;

	before(async () => {
		// Self-hosted, with the cap the maiteam server runs with, from the start: action descriptions and MCP's
		// instructions are written when their modules load.
		app = await startTestApp({ MAILCHEAP_CLOUD: "", [ENV]: "10", ALLOWED_EMAILS: "@example.com", EMAIL_FROM: "mailcheap <hello@example.com>" });
		m = {
			newsletters: await import("../app/(app)/newsletters/actions.js"),
			apiKeys: await import("../app/(app)/api-keys/actions.js"),
			registry: await import("../lib/actions/registry.js"),
			mcp: await import("../lib/mcp/server.js"),
			Newsletter: (await import("../models/Newsletter.js")).default,
		};
	});
	after(() => app?.stop());

	async function user(email) {
		const signedIn = await signIn(email);
		const { key } = await as(signedIn, () => m.apiKeys.createApiKey(null, form({ name: "Agent", level: "full" })));
		return { ...signedIn, key };
	}
	const create = (key, name) => callApi("POST", "/api/v1/newsletters", { key, body: { name } });
	// A refusal answers { error }; a saved newsletter redirects to it.
	const fromDashboard = (signedIn, slug) =>
		as(signedIn, () => m.newsletters.saveNewsletter(null, form({ name: slug, slug, postalAddress: "1 Main St, Paris" })));

	test("10 allows the 4th to the 10th and refuses the 11th, in the REST API and the dashboard", async () => {
		const ten = await user("ten@example.com");
		for (let n = 1; n <= 10; n++) assert.equal((await create(ten.key, `List ${n}`)).status, 201, `newsletter ${n}`);
		const eleventh = await create(ten.key, "List 11");
		assert.equal(eleventh.status, 409);
		assert.deepEqual(eleventh.body, { error: { code: "conflict", message: "An account has up to 10 newsletters" } });
		assert.deepEqual(await fromDashboard(ten, "list-eleven"), { error: "An account has up to 10 newsletters" });
		assert.equal(await m.Newsletter.countDocuments({ accountId: ten.accountId }), 10);
		assert.equal((await callApi("GET", "/api/v1/newsletters", { key: ten.key })).body.newsletters.length, 10);
	});

	test("REST and MCP describe the server's number", () => {
		const described = Object.fromEntries(m.registry.ACTIONS.map(({ name, description }) => [name, description]));
		assert.match(described.create_newsletter, /An account has up to 10, /);
		assert.match(described.list_newsletters, /newsletters, 10 at most/);
		assert.match(m.mcp.MCP_INSTRUCTIONS, /An account has up to 10, /);
	});

	test("unset or invalid, the self-hosted server stops at upstream's 3", async () => {
		for (const [raw, email] of [["", "unset@example.com"], ["0", "zero@example.com"], ["ten", "word@example.com"]]) {
			await withEnv({ [ENV]: raw }, async () => {
				const three = await user(email);
				for (let n = 1; n <= 3; n++) assert.equal((await create(three.key, `List ${n}`)).status, 201, `${raw}: newsletter ${n}`);
				const fourth = await create(three.key, "List 4");
				assert.equal(fourth.status, 409, raw);
				assert.equal(fourth.body.error.message, "An account has up to 3 newsletters");
				assert.equal(await m.Newsletter.countDocuments({ accountId: three.accountId }), 3);
			});
		}
	});

	// P12's other half (lib/maiteam/email-language.js), on the same server: the settings take it and de.
	test("a newsletter's language takes it and de through the REST API, and still refuses an unknown one", async () => {
		const owner = await user("languages@example.com");
		const { body } = await create(owner.key, "Lingue");
		for (const language of ["it", "de"]) {
			const set = await callApi("PATCH", `/api/v1/newsletters/${body.id}`, { key: owner.key, body: { language } });
			assert.equal(set.status, 200, JSON.stringify(set.body));
			assert.equal(set.body.language, language);
			assert.equal((await m.Newsletter.findOne({ accountId: owner.accountId, _id: body.id }).lean()).language, language);
		}
		const unknown = await callApi("PATCH", `/api/v1/newsletters/${body.id}`, { key: owner.key, body: { language: "pt" } });
		assert.equal(unknown.status, 400);
		assert.equal(unknown.body.error.code, "validation_failed");
	});

	test("mailcheap Cloud keeps upstream's 3 even with the env set to 10", async () => {
		await withEnv({ MAILCHEAP_CLOUD: "true" }, async () => {
			const signedIn = await signIn("cloud@example.com");
			await activate(signedIn);
			const { key } = await as(signedIn, () => m.apiKeys.createApiKey(null, form({ name: "Agent", level: "full" })));
			for (let n = 1; n <= 3; n++) assert.equal((await create(key, `List ${n}`)).status, 201, `newsletter ${n}`);
			const fourth = await create(key, "List 4");
			assert.equal(fourth.status, 409);
			assert.equal(fourth.body.error.message, "An account has up to 3 newsletters");
			assert.deepEqual(await fromDashboard(signedIn, "cloud-four"), { error: "An account has up to 3 newsletters" });
			assert.equal(await m.Newsletter.countDocuments({ accountId: signedIn.accountId }), 3);
		});
	});
});
