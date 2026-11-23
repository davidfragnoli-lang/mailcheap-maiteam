import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import mongoose from "mongoose";
import * as z from "zod";
import { activate, anonymous, as, callApi, catchRedirect, form, signIn, startTestApp } from "./helpers/app.mjs";

// maiteam (PATCHES.md P18, P19; QI-28776): a read only key, for maiteam's ops console. It runs the read-only GET actions
// that stay inside mailcheap, on its own account only; every write, send and paid call is refused, over REST and MCP.
let app;
let m;
let owner;
let stranger;
let nextId = 0;

const DAY_MS = 86_400_000;

async function customer(slug) {
	const user = await signIn(`${slug}@example.com`);
	await activate(user);
	const url = await as(user, () =>
		catchRedirect(
			m.newsletters.saveNewsletter(
				null,
				form({ name: `${slug} news`, slug, fromName: "David", fromEmail: `hello@${slug}.mailcheapmail.com`, postalAddress: "1 Main St, Paris" })
			)
		)
	);
	user.newsletterId = url.split("/").at(-1);
	user.slug = slug;
	user.fullKey = (await as(user, () => m.apiKeys.createApiKey(null, form({ name: "Agent", level: "full" })))).key;
	const created = await as(user, () => m.apiKeys.createApiKey(null, form({ name: "Console", level: "read" })));
	assert.equal(created.level, "read", "the dashboard makes read only keys");
	user.readKey = created.key;
	const sequence = await callApi("POST", "/api/v1/sequences", {
		key: user.fullKey,
		body: {
			newsletter: slug,
			name: "Welcome",
			slug: "welcome",
			steps: [
				{ delayDays: 1, subject: `Day one at ${slug}`, previewText: "A first look", markdown: `Hello {{first_name}}, this is ${slug}.` },
				{ delayDays: 3, subject: "Day three", markdown: "More words." },
			],
		},
	});
	assert.equal(sequence.status, 201, JSON.stringify(sequence.body));
	user.sequenceId = sequence.body.id;
	return user;
}

async function mcp(key, method, params = {}) {
	const request = new Request("http://localhost:3000/mcp", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
			...(method !== "initialize" && { "mcp-protocol-version": "2025-06-18" }),
			authorization: `Bearer ${key}`,
		},
		body: JSON.stringify({ jsonrpc: "2.0", method, params, id: ++nextId }),
	});
	const response = await anonymous(() => m.mcpRoute.POST(request));
	const text = await response.text();
	const data = text.split("\n").find((line) => line.startsWith("data: "));
	return data ? JSON.parse(data.slice(6)) : JSON.parse(text);
}

// A path for an action's route, every parameter an id that exists nowhere.
function pathOf(action) {
	return `/api/v1${action.http.path.replace(/\{[a-zA-Z]+\}/g, "0123456789abcdef01234567")}`;
}

before(async () => {
	app = await startTestApp();
	m = {
		mcpRoute: await import("../app/mcp/route.js"),
		newsletters: await import("../app/(app)/newsletters/actions.js"),
		apiKeys: await import("../app/(app)/api-keys/actions.js"),
		registry: await import("../lib/actions/registry.js"),
		defineAction: await import("../lib/actions/define-action.js"),
		tokens: await import("../lib/api-key-tokens.js"),
		ApiKey: (await import("../models/ApiKey.js")).default,
		Contact: (await import("../models/Contact.js")).default,
		Message: (await import("../models/Message.js")).default,
		Newsletter: (await import("../models/Newsletter.js")).default,
		Sequence: (await import("../models/Sequence.js")).default,
	};
	owner = await customer("read-owner");
	stranger = await customer("read-stranger");
});

after(() => app?.stop());

describe("the read level", () => {
	test("a read key is stored as read; unknown and old levels stay signups only", () => {
		assert.equal(m.tokens.getKeyLevel({ level: "read" }), "read");
		assert.equal(m.tokens.getKeyLevel({ level: "full" }), "full");
		assert.equal(m.tokens.getKeyLevel({ level: "READ" }), "signups");
		assert.equal(m.tokens.getKeyLevel({}), "signups");
	});

	test("it opens exactly the read-only GET actions that stay inside mailcheap, less the excluded ones", () => {
		const { canKeyUse, READ_KEY_EXCLUDED } = m.defineAction;
		for (const action of m.registry.ACTIONS) {
			const expected = action.readOnly && !action.openWorld && action.http.method === "GET" && !READ_KEY_EXCLUDED.has(action.name);
			assert.equal(canKeyUse("read", action), expected, action.name);
		}
		const allowed = m.registry.ACTIONS.filter((action) => canKeyUse("read", action)).map(({ name }) => name);
		for (const name of ["list_newsletters", "get_newsletter", "list_sequences", "get_sequence", "preview_sequence_step", "get_email_counts", "preview_campaign"]) {
			assert.ok(allowed.includes(name), name);
		}
		for (const name of ["add_contact", "create_api_key", "count_segment", "get_campaign_tips", "send_test_email", "update_newsletter", ...READ_KEY_EXCLUDED]) {
			assert.ok(!allowed.includes(name), name);
		}
	});

	test("each part of the rule refuses on its own", () => {
		const { canKeyUse, defineAction } = m.defineAction;
		const read = {
			name: "get_thing",
			title: "Get a thing",
			description: "Gets a thing.",
			group: "Things",
			http: { method: "GET", path: "/things/{id}" },
			input: z.object({ id: z.string() }),
			output: z.object({ id: z.string() }),
			readOnly: true,
			handler: async ({ input }) => input,
		};
		assert.equal(canKeyUse("read", defineAction(read)), true);
		assert.equal(canKeyUse("read", defineAction({ ...read, readOnly: false })), false, "a GET that isn't readOnly");
		assert.equal(canKeyUse("read", defineAction({ ...read, openWorld: true })), false, "a readOnly GET that reaches outside");
		assert.equal(canKeyUse("read", defineAction({ ...read, http: { method: "POST", path: "/things/{id}" } })), false, "a readOnly POST");
		assert.equal(canKeyUse("read", defineAction({ ...read, name: "export_contacts" })), false, "an excluded name");
		assert.equal(canKeyUse("full", defineAction({ ...read, name: "export_contacts" })), true, "full keys aren't touched");
	});

	test("the excluded actions exist, keep their annotations, and still run for a full key", () => {
		const { canKeyUse, READ_KEY_EXCLUDED } = m.defineAction;
		assert.deepEqual([...READ_KEY_EXCLUDED].sort(), ["export_contacts", "get_billing", "preview_summary_email"]);
		for (const name of READ_KEY_EXCLUDED) {
			const action = m.registry.getAction(name);
			assert.ok(action, `${name} is in the registry: a rename upstream must move the exclusion with it`);
			assert.equal(action.http.method, "GET", name);
			assert.equal(action.readOnly, true, name);
			assert.equal(action.openWorld, false, name);
			assert.equal(canKeyUse("full", action), true, name);
		}
	});
});

describe("the excluded readOnly GETs", () => {
	// export_contacts mints a 1-hour export.csv link that works without the key; preview_summary_email shows the summary's
	// 180-day settings links; get_billing reads Stripe's prices when its cache is cold (Fragno's review of FRA-26733).
	const EXCLUDED = [
		["export_contacts", "/api/v1/contacts/export"],
		["preview_summary_email", "/api/v1/summary/preview"],
		["get_billing", "/api/v1/billing"],
	];

	test("a read key gets 403 forbidden over REST", async () => {
		for (const [name, path] of EXCLUDED) {
			assert.equal(m.registry.getAction(name).http.path, path.replace("/api/v1", ""), name);
			const response = await callApi("GET", path, { key: owner.readKey });
			assert.equal(response.status, 403, `${name}: ${JSON.stringify(response.body)}`);
			assert.equal(response.body.error.code, "forbidden");
			assert.match(response.body.error.message, /can only read/);
			assert.doesNotMatch(JSON.stringify(response.body), /token=/);
		}
	});

	test("they aren't in a read key's MCP tools, and a call can't reach them; a full key still has them", async () => {
		const names = (await mcp(owner.readKey, "tools/list")).result.tools.map(({ name }) => name);
		const fullNames = (await mcp(owner.fullKey, "tools/list")).result.tools.map(({ name }) => name);
		for (const [name] of EXCLUDED) {
			assert.ok(!names.includes(name), `${name} isn't listed for a read key`);
			assert.ok(fullNames.includes(name), `${name} is listed for a full key`);
			const refused = await mcp(owner.readKey, "tools/call", { name, arguments: {} });
			const text = refused.error?.message ?? refused.result?.content[0].text;
			assert.match(text, new RegExp(name), name);
			assert.doesNotMatch(text, /token=/, name);
		}
	});

	test("a full key still exports", async () => {
		const response = await callApi("GET", "/api/v1/contacts/export", { key: owner.fullKey });
		assert.equal(response.status, 200, JSON.stringify(response.body));
		assert.match(response.body.url, /\/api\/v1\/contacts\/export\.csv\?token=/);
	});
});

describe("a write attempt with a read key", () => {
	test("every action a read key can't use answers 403 over REST, before it reads its input", async () => {
		const refused = m.registry.ACTIONS.filter((action) => !m.defineAction.canKeyUse("read", action));
		assert.ok(refused.length > 40);
		for (const action of refused) {
			const response = await callApi(action.http.method, pathOf(action), {
				key: owner.readKey,
				...(action.http.method !== "GET" && action.http.method !== "DELETE" && { body: {} }),
			});
			assert.equal(response.status, 403, `${action.http.method} ${action.http.path}: ${JSON.stringify(response.body)}`);
			assert.equal(response.body.error.code, "forbidden");
			assert.match(response.body.error.message, /can only read/);
		}
	});

	test("nothing changes: no contact, no key, no newsletter or sequence edit", async () => {
		const contacts = await m.Contact.countDocuments({ accountId: owner.accountId });
		const keys = await m.ApiKey.countDocuments({ accountId: owner.accountId });
		const added = await callApi("POST", "/api/v1/contacts", { key: owner.readKey, body: { email: "someone@example.org", newsletter: owner.slug } });
		assert.equal(added.status, 403);
		const key = await callApi("POST", "/api/v1/api-keys", { key: owner.readKey, body: { name: "Escalate", level: "full" } });
		assert.equal(key.status, 403);
		const renamed = await callApi("PATCH", `/api/v1/newsletters/${owner.newsletterId}`, { key: owner.readKey, body: { name: "Renamed" } });
		assert.equal(renamed.status, 403);
		const paused = await callApi("POST", `/api/v1/sequences/${owner.sequenceId}/pause`, { key: owner.readKey });
		assert.equal(paused.status, 403);
		assert.equal(await m.Contact.countDocuments({ accountId: owner.accountId }), contacts);
		assert.equal(await m.ApiKey.countDocuments({ accountId: owner.accountId }), keys);
		assert.equal((await m.Newsletter.findOne({ accountId: owner.accountId, _id: owner.newsletterId }).lean()).name, "read-owner news");
		assert.equal((await m.Sequence.findOne({ accountId: owner.accountId, _id: owner.sequenceId }).lean()).status, "draft");
	});

	test("over MCP the key lists only its tools, and a write tool doesn't exist for it", async () => {
		const listed = await mcp(owner.readKey, "tools/list");
		const names = listed.result.tools.map(({ name }) => name).sort();
		const expected = m.registry.ACTIONS.filter((action) => m.defineAction.canKeyUse("read", action)).map(({ name }) => name).sort();
		assert.deepEqual(names, expected);
		assert.ok(listed.result.tools.every(({ annotations }) => annotations.readOnlyHint === true && annotations.openWorldHint === false));
		const refused = await mcp(owner.readKey, "tools/call", { name: "update_newsletter", arguments: { id: owner.newsletterId, name: "Renamed" } });
		assert.match(refused.error?.message ?? refused.result?.content[0].text, /update_newsletter/);
		assert.equal((await m.Newsletter.findOne({ accountId: owner.accountId, _id: owner.newsletterId }).lean()).name, "read-owner news");
	});
});

describe("another account", () => {
	test("a read key reads its own account and nothing of another's", async () => {
		const list = await callApi("GET", "/api/v1/newsletters", { key: owner.readKey });
		assert.equal(list.status, 200);
		assert.deepEqual(list.body.newsletters.map(({ slug }) => slug), ["read-owner"]);
		const sequences = await callApi("GET", "/api/v1/sequences", { key: owner.readKey });
		assert.deepEqual(sequences.body.sequences.map(({ id }) => id), [owner.sequenceId]);

		const theirs = [
			`/api/v1/newsletters/${stranger.newsletterId}`,
			`/api/v1/sequences/${stranger.sequenceId}`,
			`/api/v1/sequences/${stranger.sequenceId}/preview?position=1`,
			`/api/v1/emails/counts?newsletter=read-stranger`,
			`/api/v1/sequences?newsletter=read-stranger`,
		];
		for (const path of theirs) {
			const response = await callApi("GET", path, { key: owner.readKey });
			assert.equal(response.status, 404, `${path}: ${JSON.stringify(response.body)}`);
		}
	});
});

describe("reports (P19)", () => {
	test("preview_sequence_step renders a step with the send path's code, as the sample reader", async () => {
		const response = await callApi("GET", `/api/v1/sequences/${owner.sequenceId}/preview?position=1`, { key: owner.readKey });
		assert.equal(response.status, 200, JSON.stringify(response.body));
		const step = response.body;
		assert.equal(step.position, 1);
		assert.equal(step.delayDays, 1);
		assert.equal(step.useWelcome, false);
		assert.equal(step.subject, "Day one at read-owner");
		assert.equal(step.previewText, "A first look");
		assert.match(step.from, /David/);
		assert.match(step.html, /Hello Jane, this is read-owner\./);
		assert.match(step.text, /Hello Jane, this is read-owner\./);
		assert.match(step.html, /unsubscribe/i, "the footer the send adds");

		const missing = await callApi("GET", `/api/v1/sequences/${owner.sequenceId}/preview?position=5`, { key: owner.readKey });
		assert.equal(missing.status, 404);
	});

	test("get_email_counts counts each step and issue per UTC day, its own account only, with no address", async () => {
		const now = new Date();
		const yesterday = new Date(now.getTime() - DAY_MS);
		const base = { accountId: owner.accountId, newsletterId: owner.newsletterId, status: "sent" };
		const enrollmentId = () => new mongoose.Types.ObjectId();
		const step = (position, extra = {}) => ({ ...base, kind: "sequence", sequenceId: owner.sequenceId, enrollmentId: enrollmentId(), stepPosition: position, ...extra });
		await m.Message.insertMany([
			step(1, { email: "a@example.org", sentAt: now, deliveredAt: now, openedAt: now }),
			step(1, { email: "b@example.org", sentAt: now, bouncedAt: now, status: "bounced" }),
			step(2, { email: "a@example.org", sentAt: now, deliveredAt: now, clickedAt: now }),
			step(1, { email: "c@example.org", sentAt: yesterday, deliveredAt: yesterday }),
			{ ...base, kind: "confirmation", email: "d@example.org", sentAt: now, deliveredAt: now },
			{ ...base, kind: "test", email: "hello@read-owner.mailcheapmail.com", sentAt: now },
			{ ...base, kind: "sequence", sequenceId: owner.sequenceId, enrollmentId: enrollmentId(), stepPosition: 1, email: "e@example.org", status: "queued" },
			{ accountId: stranger.accountId, newsletterId: stranger.newsletterId, kind: "sequence", sequenceId: stranger.sequenceId, enrollmentId: enrollmentId(), stepPosition: 1, email: "x@example.org", status: "sent", sentAt: now },
		]);
		await m.Contact.insertMany([
			{
				accountId: owner.accountId,
				newsletterId: owner.newsletterId,
				email: "gone@example.org",
				status: "unsubscribed",
				unsubscribedAt: now,
				statusChanges: [{ from: "active", to: "unsubscribed", at: now, via: "link" }],
			},
			{
				accountId: stranger.accountId,
				newsletterId: stranger.newsletterId,
				email: "gone@example.org",
				status: "unsubscribed",
				unsubscribedAt: now,
				statusChanges: [{ from: "active", to: "unsubscribed", at: now, via: "link" }],
			},
		]);

		const response = await callApi("GET", "/api/v1/emails/counts?days=7", { key: owner.readKey });
		assert.equal(response.status, 200, JSON.stringify(response.body));
		const { from, to, emails, unsubscribed } = response.body;
		const today = now.toISOString().slice(0, 10);
		assert.equal(to, today);
		assert.equal(from, new Date(Date.parse(`${today}T00:00:00Z`) - 6 * DAY_MS).toISOString().slice(0, 10));
		assert.ok(emails.every(({ newsletterId }) => newsletterId === owner.newsletterId), "another account's emails never show");
		assert.ok(!emails.some(({ kind }) => kind === "test"), "test sends aren't a list's");

		const row = (date, kind, position = null) => emails.find((item) => item.date === date && item.kind === kind && item.stepPosition === position);
		assert.deepEqual(
			{ ...row(today, "sequence", 1) },
			{
				date: today,
				newsletterId: owner.newsletterId,
				kind: "sequence",
				campaignId: null,
				sequenceId: owner.sequenceId,
				stepPosition: 1,
				sent: 2,
				delivered: 1,
				bounced: 1,
				complained: 0,
				unsubscribed: 0,
				opened: 1,
				clicked: 0,
			}
		);
		assert.equal(row(today, "sequence", 2).clicked, 1);
		assert.equal(row(yesterday.toISOString().slice(0, 10), "sequence", 1).sent, 1);
		assert.equal(row(today, "confirmation").delivered, 1);
		assert.deepEqual(unsubscribed, [{ date: today, newsletterId: owner.newsletterId, count: 1 }]);
		assert.doesNotMatch(JSON.stringify(response.body), /@/, "counts and ids only");

		await m.Newsletter.updateOne({ accountId: owner.accountId, _id: owner.newsletterId }, { $set: { tracking: false } });
		const untracked = await callApi("GET", "/api/v1/emails/counts", { key: owner.readKey });
		assert.ok(untracked.body.emails.every(({ opened, clicked }) => opened === null && clicked === null), "an untracked list shows no opens or clicks");
		await m.Newsletter.updateOne({ accountId: owner.accountId, _id: owner.newsletterId }, { $unset: { tracking: 1 } });
	});
});
