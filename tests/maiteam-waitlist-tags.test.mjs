import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { after, before, beforeEach, describe, test } from "node:test";
import { activate, as, callApi, catchRedirect, form, signIn, startTestApp } from "./helpers/app.mjs";
import { flushAfter } from "./stubs/next-server.mjs";
import { disableSignupProtection } from "./stubs/maiteam-signup-protection.mjs";
import {
	FORTUNA_LANGUAGES,
	WAITLIST_PRODUCTS,
	parseWaitlistPayload,
	resolveWaitlistProduct,
	signWaitlistBody,
	signupInputFor,
} from "../lib/maiteam/waitlist-webhook.js";

// QI-27989 (David, 2 Nov 2026): fortuna's waitlist products. One list per language; a generic signup is tagged
// `waitlist` and joins `welcome`, a Self-hosted signup is the same list, tagged `waitlist` and `selfhosted`, and joins
// `answer` only. The tags are the product's, never the payload's.

const SECRET = "synthetic-test-secret-at-least-32-characters";
const SH_SECRET = "synthetic-selfhosted-secret-at-least-32-chars";
const ENV = {
	WAITLIST_WEBHOOK_PRODUCTS: "fortuna-de,fortuna-selfhosted-de",
	WAITLIST_SECRET_FORTUNA_DE: SECRET,
	WAITLIST_SECRET_FORTUNA_SELFHOSTED_DE: SH_SECRET,
};
const COPY = JSON.parse(readFileSync(new URL("../fixtures/maifortune-welcome/copy.maiteam.en.json", import.meta.url), "utf8"));

describe("fortuna waitlist products", () => {
	test("five generic and five Self-hosted products, each on its language's one list, with its own secret and tags", () => {
		const lists = { en: "fortuna-waitlist", fr: "fortuna-waitlist-fr", it: "fortuna-waitlist-it", de: "fortuna-waitlist-de", es: "fortuna-waitlist-es" };
		assert.deepEqual([...FORTUNA_LANGUAGES], ["en", "fr", "it", "de", "es"]);
		const secrets = new Set();
		for (const lang of FORTUNA_LANGUAGES) {
			const upper = lang.toUpperCase();
			const generic = WAITLIST_PRODUCTS[`fortuna-${lang}`];
			const selfHosted = WAITLIST_PRODUCTS[`fortuna-selfhosted-${lang}`];
			assert.deepEqual(
				{ newsletter: generic.newsletter, sequence: generic.sequence, tags: [...generic.tags], secretEnv: generic.secretEnv },
				{ newsletter: lists[lang], sequence: "welcome", tags: ["waitlist"], secretEnv: `WAITLIST_SECRET_FORTUNA_${upper}` }
			);
			assert.deepEqual(
				{ newsletter: selfHosted.newsletter, sequence: selfHosted.sequence, tags: [...selfHosted.tags], secretEnv: selfHosted.secretEnv },
				{ newsletter: lists[lang], sequence: "answer", tags: ["waitlist", "selfhosted"], secretEnv: `WAITLIST_SECRET_FORTUNA_SELFHOSTED_${upper}` }
			);
			assert.ok(Object.isFrozen(selfHosted.tags), "a product's tags can't be changed at run time");
			secrets.add(generic.secretEnv).add(selfHosted.secretEnv);
		}
		assert.equal(secrets.size, 10, "no two products share a secret");
	});

	test("the tags come from the product: the payload can't send any, and each product's secret signs only for it", () => {
		const raw = JSON.stringify({ eventId: "evt-00000001", product: "fortuna-selfhosted-de", email: "a@example.invalid" });
		const payload = parseWaitlistPayload(raw, "fortuna-selfhosted-de");
		assert.deepEqual(signupInputFor(resolveWaitlistProduct("fortuna-selfhosted-de", ENV), payload).tags, ["waitlist", "selfhosted"]);
		assert.deepEqual(signupInputFor(resolveWaitlistProduct("fortuna-de", ENV), { ...payload }).tags, ["waitlist"]);
		const withTags = JSON.stringify({ ...JSON.parse(raw), tags: ["vip"] });
		assert.match(parseWaitlistPayload(withTags, "fortuna-selfhosted-de").error, /^Unknown field: tags/);
		assert.equal(resolveWaitlistProduct("fortuna-selfhosted-de", { ...ENV, WAITLIST_SECRET_FORTUNA_SELFHOSTED_DE: "" }), null, "the generic secret never stands in");
		assert.equal(resolveWaitlistProduct("fortuna-selfhosted-fr", ENV), null, "a product that isn't listed is off");
	});
});

describe("fortuna waitlist products on the route", () => {
	let app;
	let m;
	let user;
	let welcome;
	let answer;
	let segment;
	let nextEvent = 0;

	before(async () => {
		app = await startTestApp(ENV);
		m = {
			apiKeys: await import("../app/(app)/api-keys/actions.js"),
			newsletters: await import("../app/(app)/newsletters/actions.js"),
			route: await import("../app/api/webhooks/waitlist/[product]/route.js"),
			replay: await import("../lib/maiteam/webhook-replay-store.js"),
			Contact: (await import("../models/Contact.js")).default,
			Enrollment: (await import("../models/Enrollment.js")).default,
			Newsletter: (await import("../models/Newsletter.js")).default,
		};
		user = await signIn("fortuna-de-owner@example.com");
		await activate(user);
		const url = await as(user, () =>
			catchRedirect(m.newsletters.saveNewsletter(null, form({ name: "fortuna (DE)", slug: "fortuna-waitlist-de", fromEmail: "hallo@fortuna.mailcheapmail.com", postalAddress: "1 Main St, Paris" })))
		);
		user.newsletterId = url.split("/").at(-1);
		await m.Newsletter.updateOne({ accountId: user.accountId, _id: user.newsletterId }, { $set: { requireConfirmation: true, confirmation: COPY.confirmation } });
		user.key = (await as(user, () => m.apiKeys.createApiKey(null, form({ name: "Admin", level: "full" })))).key;
		const steps = COPY.steps.map(({ delayDays, subject, previewText, markdown }) => ({ delayDays, subject, previewText, markdown }));
		const create = async (body) => {
			const created = await callApi("POST", "/api/v1/sequences", { key: user.key, body: { newsletter: user.newsletterId, status: "active", ...body } });
			assert.equal(created.status, 201, JSON.stringify(created.body));
			return created.body;
		};
		welcome = await create({ name: "fortuna welcome", slug: "welcome", steps });
		answer = await create({ name: "fortuna Self-hosted answer", slug: "answer", steps: steps.slice(0, 1) });
		const created = await callApi("POST", "/api/v1/segments", {
			key: user.key,
			body: { newsletter: user.newsletterId, name: "Self-hosted interest", conditions: [{ field: "tag", op: "has", value: "selfhosted" }] },
		});
		assert.equal(created.status, 201, JSON.stringify(created.body));
		segment = created.body;
	});

	after(() => app?.stop());

	beforeEach(() => {
		m.replay.setReplayStoreForTests(memoryReplayStore());
		disableSignupProtection();
	});

	async function deliver(product, email, secret) {
		const rawBody = JSON.stringify({ eventId: `evt-tag-${String(++nextEvent).padStart(6, "0")}`, product, email });
		const timestamp = String(Date.now());
		const request = new Request(`http://localhost:3000/api/webhooks/waitlist/${product}`, {
			method: "POST",
			headers: { "content-type": "application/json", "x-waitlist-timestamp": timestamp, "x-waitlist-signature": signWaitlistBody({ secret, timestamp, product, rawBody }) },
			body: rawBody,
		});
		const response = await m.route.POST(request, { params: Promise.resolve({ product }) });
		await flushAfter();
		return { status: response.status, body: await response.json() };
	}

	const contactOf = (email) => m.Contact.findOne({ accountId: user.accountId, email }).lean();
	const sequencesOf = async (contact) =>
		(await m.Enrollment.find({ accountId: user.accountId, contactId: contact._id }).lean()).map((enrollment) => String(enrollment.sequenceId));
	const inSegment = async () =>
		(await callApi("GET", `/api/v1/contacts?segment=${segment.id}`, { key: user.key })).body.contacts.map((contact) => contact.email);

	test("a Self-hosted signup lands on the shared list, tagged, in the Self-hosted interest segment, and in answer only", async () => {
		const email = "selbst@fortuna.example.org";
		const response = await deliver("fortuna-selfhosted-de", email, SH_SECRET);
		assert.equal(response.status, 201, JSON.stringify(response.body));
		const contact = await contactOf(email);
		assert.equal(String(contact.newsletterId), user.newsletterId, "the language's one fortuna list");
		assert.equal(contact.status, "pending");
		assert.equal(contact.source, "waitlist:fortuna-selfhosted-de");
		assert.deepEqual([...contact.tags].sort(), ["selfhosted", "waitlist"]);
		assert.deepEqual(await sequencesOf(contact), [answer.id], "the answer sequence, not welcome");
		assert.ok((await inSegment()).includes(email));
	});

	test("a generic signup on the same list is tagged waitlist, joins welcome, and stays out of the segment", async () => {
		const email = "allgemein@fortuna.example.org";
		const response = await deliver("fortuna-de", email, SECRET);
		assert.equal(response.status, 201, JSON.stringify(response.body));
		const contact = await contactOf(email);
		assert.equal(String(contact.newsletterId), user.newsletterId);
		assert.deepEqual([...contact.tags], ["waitlist"]);
		assert.deepEqual(await sequencesOf(contact), [welcome.id]);
		assert.ok(!(await inSegment()).includes(email));
	});

	test("an existing contact keeps their own tags and gains the product's", async () => {
		const email = "bekannt@fortuna.example.org";
		const added = await callApi("POST", "/api/v1/contacts", { key: user.key, body: { newsletter: user.newsletterId, email, tags: ["trial"] } });
		assert.ok([200, 201].includes(added.status), JSON.stringify(added.body));
		const response = await deliver("fortuna-selfhosted-de", email, SH_SECRET);
		assert.equal(response.status, 200, JSON.stringify(response.body));
		assert.deepEqual([...(await contactOf(email)).tags].sort(), ["selfhosted", "trial", "waitlist"]);
		assert.ok((await inSegment()).includes(email));
	});
});

function memoryReplayStore() {
	const keys = new Map();
	return {
		keys,
		async claim({ product, eventId, hash }) {
			const key = `${product}:${eventId}`;
			if (keys.has(key)) return { claimed: false, state: "done", sameBody: keys.get(key) === `d:${hash}` };
			const claim = `p:${hash}:${crypto.randomBytes(6).toString("hex")}`;
			keys.set(key, claim);
			return { claimed: true, claim };
		},
		async complete({ product, eventId, hash, claim }) {
			const key = `${product}:${eventId}`;
			if (keys.get(key) !== claim) return false;
			keys.set(key, `d:${hash}`);
			return true;
		},
		async release({ product, eventId, claim }) {
			const key = `${product}:${eventId}`;
			if (keys.get(key) === claim) keys.delete(key);
		},
	};
}
