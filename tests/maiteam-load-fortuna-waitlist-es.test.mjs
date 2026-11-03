import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { after, before, describe, test } from "node:test";
import { activate, addVerifiedDomain, as, callApi, form, signIn, startTestApp } from "./helpers/app.mjs";
import { COPY_SHA256, loadRecord, planRecord, readSpec, receiptOf } from "../scripts/maiteam/load-fortuna-waitlist-es.mjs";

// QI-27854 gate 4: the fortuna-waitlist-es record, loaded through the REST API from the locked copy. Made-up spec.
const COPY_BYTES = readFileSync(new URL("../fixtures/maifortune-welcome/copy.maiteam.es.json", import.meta.url));
const COPY = JSON.parse(COPY_BYTES);
const SPEC = { fromName: "fortuna", fromEmail: "hello@mail.example.com", replyTo: "hello@example.com", postalAddress: "1 Main St, 2520 Example" };

test("the loader's copy is the fixture's bytes, and the spec takes only its four fields", () => {
	assert.equal(createHash("sha256").update(COPY_BYTES).digest("hex"), COPY_SHA256);
	assert.throws(() => readSpec({ ...SPEC, language: "en" }), /unknown fields: language/);
	assert.throws(() => readSpec({ ...SPEC, replyTo: "nope" }), /replyTo/);
	assert.throws(() => readSpec({ ...SPEC, postalAddress: " " }), /postalAddress/);
	const receipt = JSON.stringify(receiptOf(planRecord(readSpec(SPEC), COPY)));
	assert.doesNotMatch(receipt, /Main St/, "the receipt never prints the address");
});

describe("loading fortuna-waitlist-es", () => {
	let app;
	let user;
	let key;
	const plan = planRecord(SPEC, COPY);
	const api = (method, path, body) => callApi(method, path, { key, body });

	before(async () => {
		app = await startTestApp();
		user = await signIn("fortuna-loader@example.com");
		await activate(user);
		await addVerifiedDomain(user, "mail.example.com");
		key = (await as(user, () => import("../app/(app)/api-keys/actions.js").then((m) => m.createApiKey(null, form({ name: "Loader", level: "full" }))))).key;
	});

	after(() => app?.stop());

	test("creates the Spanish newsletter and a draft welcome sequence, and a second run changes nothing", async () => {
		const first = await loadRecord({ api, plan });
		assert.equal(first.created, true);
		assert.equal(first.sequenceCreated, true);
		const again = await loadRecord({ api, plan });
		assert.deepEqual(again, { ...first, created: false, sequenceCreated: false });

		const newsletter = (await api("GET", `/newsletters/${first.newsletterId}`)).body;
		assert.deepEqual(
			[newsletter.name, newsletter.slug, newsletter.language, newsletter.requireConfirmation, newsletter.fromEmail, newsletter.replyTo],
			["fortuna", "fortuna-waitlist-es", "es", true, SPEC.fromEmail, SPEC.replyTo]
		);
		const sequence = (await api("GET", `/sequences/${first.sequenceId}`)).body;
		assert.equal(sequence.status, "draft");
		assert.deepEqual(sequence.steps.map(({ delayDays, subject }) => [delayDays, subject]), COPY.steps.map(({ delayDays, subject }) => [delayDays, subject]));
	});

	test("leaves a started sequence alone", async () => {
		const { sequenceId } = await loadRecord({ api, plan });
		assert.equal((await api("PATCH", `/sequences/${sequenceId}`, { status: "active" })).status, 200);
		await assert.rejects(loadRecord({ api, plan }), /is active, not a draft/);
	});
});
