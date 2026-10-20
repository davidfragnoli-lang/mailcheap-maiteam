import assert from "node:assert/strict";
import crypto from "node:crypto";
import { after, before, test } from "node:test";
import mongoose from "mongoose";
import { compareDatabases } from "../scripts/maiteam/compare-databases.mjs";
import { EVENT_TYPES, mapTheme, migrateFork } from "../scripts/maiteam/migrate-from-fork.mjs";
import { startTestApp } from "./helpers/app.mjs";

// P8 (PATCHES.md): the old fork's documents, synthetic, through the migration into upstream's shape, then through
// upstream's own code: unsubscribe links, API keys, suppression, late bounces.
let app;
let sourceDb;
let targetDb;
// The old SESSION_SECRET is the new BETTER_AUTH_SECRET: the test app sets it (tests/helpers/app.mjs).
const oldSecret = () => process.env.BETTER_AUTH_SECRET;
const id = () => new mongoose.Types.ObjectId();

// The old fork's unsubscribe token (origin/production lib/unsubscribe.js).
function oldUnsubscribeToken(contactId, newsletterId) {
	const key = Buffer.from(crypto.hkdfSync("sha256", oldSecret(), "", "mailcheap-unsubscribe-v1", 32));
	const payload = Buffer.from(JSON.stringify({ c: String(contactId), n: String(newsletterId) })).toString("base64url");
	return `${payload}.${crypto.createHmac("sha256", key).update(payload).digest("base64url")}`;
}

const newsletterId = id();
const fortunaId = id();
const contacts = [
	{ _id: id(), newsletterId, email: "a@reader.example.org", status: "active" },
	{ _id: id(), newsletterId, email: "b@reader.example.org", status: "unsubscribed", unsubscribedAt: new Date() },
	{ _id: id(), newsletterId, email: "c@reader.example.org", status: "bounced" },
	{ _id: id(), newsletterId: fortunaId, email: "d@reader.example.org", status: "pending" },
];
const campaignId = id();
const sequenceId = id();
const messageId = id();
const LANDING = {
	preset: "landing",
	layout: "card",
	headingFont: "grotesk",
	bodyFont: "serif",
	wordmark: "David Fragnoli",
	titleFromSubject: false,
	footerTone: "quiet",
	light: { page: "#f4f1ea", card: "#fcfbf8", text: "#121212", accent: "#b8380f", muted: "#6b675f" },
	dark: { enabled: true, page: "#121212", card: "#1c1b19", text: "#ebe7de", accent: "#ff8a63", muted: "#a8a39a" },
};
const apiKey = "mc_testkey_0123456789abcdefghijklmnopqrstuvwxyz";

before(async () => {
	app = await startTestApp();
	const client = mongoose.connection.getClient();
	sourceDb = client.db("fork-source");
	targetDb = client.db("upstream-target");
	await sourceDb.collection("newsletters").insertMany([
		{ _id: newsletterId, name: "David Fragnoli", slug: "david-fragnoli", fromEmail: "hello@mail.maiteam.ch", fromName: "David", postalAddress: "1 Main St", requireConfirmation: true, dailySendCap: 50, theme: LANDING, createdAt: new Date(), updatedAt: new Date() },
		{ _id: fortunaId, name: "fortuna", slug: "maifortune", fromEmail: "welcome@mail.maiteam.ch", requireConfirmation: true, dailySendCap: 0, theme: { preset: "maiteam", product: "fortuna" }, createdAt: new Date(), updatedAt: new Date() },
	]);
	await sourceDb.collection("contacts").insertMany(contacts);
	await sourceDb.collection("campaigns").insertOne({ _id: campaignId, newsletterId, subject: "Issue 1", format: "markdown", markdown: "Hi", status: "sent", theme: { ...LANDING, preset: "letter" }, createdAt: new Date() });
	await sourceDb.collection("messages").insertOne({ _id: messageId, newsletterId, campaignId, contactId: contacts[0]._id, kind: "campaign", email: contacts[0].email, status: "delivered", sesMessageId: "old-ses-0001", sentAt: new Date(), createdAt: new Date() });
	await sourceDb.collection("events").insertMany([
		{ _id: id(), type: "Delivery", sesMessageId: "old-ses-0001", messageId, campaignId, email: contacts[0].email, occurredAt: new Date() },
		{ _id: id(), type: "Open", messageId, campaignId, email: contacts[0].email, occurredAt: new Date() },
	]);
	await sourceDb.collection("suppressions").insertMany([
		{ _id: id(), email: "c@reader.example.org", reason: "bounce", createdAt: new Date() },
		{ _id: id(), email: "gone@elsewhere.example.org", reason: "complaint", createdAt: new Date() },
	]);
	await sourceDb.collection("apikeys").insertOne({ _id: id(), name: "Landing", prefix: apiKey.slice(0, 12), hash: crypto.createHash("sha256").update(apiKey).digest("hex"), createdAt: new Date() });
	await sourceDb.collection("alerts").insertOne({ _id: id(), key: "signup-flood:x", title: "Signup flood", lastSentAt: new Date() });
	await sourceDb.collection("newsletter_daily_caps").insertOne({ _id: `${newsletterId}:2026-10-20`, revision: 3, issued: 2, holds: [] });
	await sourceDb.collection("sender_warmups").insertOne({ _id: `${newsletterId}:mail.maiteam.ch`, newsletterId, domain: "mail.maiteam.ch", revision: 2, level: 1, startedAt: Date.now() - 9 * 86_400_000 });
	await sourceDb.collection("sequence_demo_ledger").insertOne({ _id: "welcome-series-en-fr-2026-10-16", sent: 6 });
	await sourceDb.collection("sequences").insertOne({
		_id: sequenceId,
		newsletterId,
		name: "welcome",
		slug: "welcome",
		status: "draft",
		steps: [
			{ position: 1, delayDays: 0, delayFromEnrollmentMs: 0, subject: "Hi", markdown: "Hi", theme: { ...LANDING, preset: "letter" } },
			{ position: 2, delayDays: 3, delayFromEnrollmentMs: 259_200_000, subject: "Day 3", markdown: "Day 3" },
		],
		createdAt: new Date(),
		updatedAt: new Date(),
	});
});

after(() => app?.stop());

test("a plan validates everything and writes nothing", async () => {
	const report = await migrateFork({ sourceDb, targetDb, owner: { email: "David@Example.com" }, dumpedAt: new Date() });
	assert.equal(report.mode, "plan");
	assert.deepEqual(report.problems.filter((line) => !line.includes("kept whole") && !line.includes("unvalidated")), []);
	assert.equal(report.collections.contacts.source, 4);
	assert.equal((await targetDb.listCollections().toArray()).length, 0);
});

test("execute: same ids, states, keys and suppressions in one owner account, and upstream's code reads them", async () => {
	const report = await migrateFork({ sourceDb, targetDb, owner: { email: "David@Example.com" }, mailFrom: "bounce.mail.maiteam.ch", archiveHost: "news.mail.maiteam.ch", dumpedAt: new Date(), execute: true });
	assert.equal(report.checks.ok, true, JSON.stringify(report.checks));
	for (const [name, counts] of Object.entries(report.collections)) assert.equal(counts.target, counts.source, name);
	assert.equal(report.legacy.sequence_demo_ledger, 1);
	const accountId = new mongoose.Types.ObjectId(report.accountId);
	const user = await targetDb.collection("users").findOne({});
	assert.equal(user.email, "david@example.com");
	assert.equal(user.emailVerified, true);
	assert.equal(String((await targetDb.collection("accounts").findOne({ _id: accountId })).ownerId), String(user._id));
	const domain = await targetDb.collection("domains").findOne({ domain: "mail.maiteam.ch" });
	assert.equal(domain.verified, true);
	assert.equal(domain.mailFromDomain, "bounce.mail.maiteam.ch");

	// Looks: the landing look whole at theme.look, the issue's own at Campaign.look, the site preset mapped.
	const david = await targetDb.collection("newsletters").findOne({ _id: newsletterId });
	assert.deepEqual(david.theme, { preset: "landing", look: LANDING });
	assert.equal((await targetDb.collection("newsletters").findOne({ _id: fortunaId })).theme.preset, "fortuna");
	assert.equal((await targetDb.collection("campaigns").findOne({ _id: campaignId })).look.preset, "letter");
	assert.equal(david.dailySendCap, 50);
	const sequence = await targetDb.collection("sequences").findOne({ _id: sequenceId });
	assert.equal(sequence.steps[0].look.preset, "letter", "a step's own look moves to steps[].look");
	assert.equal(sequence.steps[0].theme, undefined);
	assert.equal(sequence.steps[1].look, undefined);

	// Messages and events: provider ids renamed, event names upstream's, marked as the fork's.
	const message = await targetDb.collection("messages").findOne({ _id: messageId });
	assert.equal(message.providerMessageId, "old-ses-0001");
	assert.equal(message.migratedFromFork, true);
	assert.deepEqual((await targetDb.collection("events").find({}).toArray()).map(({ type }) => type).sort(), ["delivered", "open"]);

	// Upstream's code on the migrated data, pointed at the target database.
	await mongoose.disconnect();
	await mongoose.connect(process.env.MONGODB_URI.replace("/mailcheap-test", "/upstream-target"));
	const { verifyUnsubscribeToken } = await import("../lib/unsubscribe.js");
	const reference = verifyUnsubscribeToken(oldUnsubscribeToken(contacts[0]._id, newsletterId));
	assert.equal(String(reference?.contactId), String(contacts[0]._id), "an unsubscribe link from a sent email still verifies");
	const Suppression = (await import("../models/Suppression.js")).default;
	for (const email of ["c@reader.example.org", "gone@elsewhere.example.org"]) {
		assert.ok(await Suppression.exists({ accountId, email }), `${email} still suppressed`);
	}
	const ApiKey = (await import("../models/ApiKey.js")).default;
	const key = await ApiKey.findOne({ accountId, hash: crypto.createHash("sha256").update(apiKey).digest("hex") }).lean();
	assert.equal(key.level, "full");
	const { handleSesEvent } = await import("../lib/ses-events.js");
	await handleSesEvent({ eventType: "Complaint", mail: { messageId: "old-ses-0001", destination: [contacts[0].email] }, complaint: { complainedRecipients: [{ emailAddress: contacts[0].email }], timestamp: new Date().toISOString() } });
	assert.ok(await Suppression.exists({ accountId, email: contacts[0].email }), "a late complaint for a pre-migration email suppresses");
	assert.deepEqual(Object.keys(EVENT_TYPES).length, 9);
});

test("a target that holds anything is refused", async () => {
	// The previous test reconnected to the target database; both databases are on the same server.
	const client = mongoose.connection.getClient();
	sourceDb = client.db("fork-source");
	targetDb = client.db("upstream-target");
	await assert.rejects(() => migrateFork({ sourceDb, targetDb, owner: { email: "david@example.com" }, dumpedAt: new Date(), execute: true }), /not empty/);
});

test("old looks map to the upstream preset for the site and stay whole for email", () => {
	assert.deepEqual(mapTheme({ preset: "maiteam" }), { preset: "maiteam", look: { preset: "maiteam" } });
	assert.equal(mapTheme({ preset: "maiteam", product: "quote-to-invoice" }).preset, "quote-to-invoice");
	assert.equal(mapTheme({ preset: "letter" }).preset, "mailcheap");
	assert.equal(mapTheme({ preset: "default" }).preset, "mailcheap");
	assert.equal(mapTheme(undefined), undefined);
});

// QA r1 item 5 (FRA-25999): the restore proof compares every document and index, and a broken reference stops the copy.
test("a restore that changed one contact's address and status, or lost an index, is not the same", async () => {
	const client = mongoose.connection.getClient();
	const target = client.db("upstream-target");
	const restored = client.db("upstream-restore-probe");
	for (const { name } of await target.listCollections().toArray()) {
		const docs = await target.collection(name).find({}).toArray();
		await restored.createCollection(name);
		if (docs.length) await restored.collection(name).insertMany(docs);
		for (const { key, name: indexName, v, ...options } of await target.collection(name).indexes()) {
			if (indexName !== "_id_") await restored.collection(name).createIndex(key, { name: indexName, ...options });
		}
	}
	const faithful = await compareDatabases(target, restored);
	assert.equal(faithful.same, true, JSON.stringify(Object.entries(faithful.collections).filter(([, value]) => !value.same)));
	await restored.collection("contacts").updateOne({ _id: contacts[0]._id }, { $set: { status: "unsubscribed", email: "changed@reader.example.org" } });
	const changed = await compareDatabases(target, restored);
	assert.equal(changed.same, false);
	assert.deepEqual(changed.collections.contacts.documents, { missing: 0, changed: 1, extra: 0 });
	const original = await target.collection("contacts").findOne({ _id: contacts[0]._id });
	await restored.collection("contacts").updateOne({ _id: contacts[0]._id }, { $set: { status: original.status, email: original.email } });
	const back = await compareDatabases(target, restored);
	assert.equal(back.same, true, JSON.stringify(Object.entries(back.collections).filter(([, value]) => !value.same)));
	await restored.collection("contacts").dropIndex("newsletterId_1_email_1");
	assert.equal((await compareDatabases(target, restored)).collections.contacts.same, false, "a lost unique index is caught");
});

test("a contact pointing at no newsletter, or a duplicate address, stops the migration before anything is written", async () => {
	const client = mongoose.connection.getClient();
	const source = client.db("fork-dangling");
	const nid = id();
	await source.collection("newsletters").insertOne({ _id: nid, name: "n", slug: "dangling-n", fromEmail: "hello@mail.maiteam.ch", createdAt: new Date(), updatedAt: new Date() });
	await source.collection("contacts").insertOne({ _id: id(), newsletterId: id(), email: "lost@reader.example.org", status: "active", createdAt: new Date(), updatedAt: new Date() });
	const plan = await migrateFork({ sourceDb: source, targetDb: client.db("upstream-dangling"), owner: { email: "owner@example.org" }, dumpedAt: new Date() });
	assert.deepEqual(plan.relationships.hard, { "contacts.newsletterId": 1 });
	await assert.rejects(() => migrateFork({ sourceDb: source, targetDb: client.db("upstream-dangling"), owner: { email: "owner@example.org" }, dumpedAt: new Date(), execute: true }), /nothing was written/);
	assert.equal((await client.db("upstream-dangling").listCollections().toArray()).length, 0);

	await source.collection("contacts").deleteMany({});
	await source.collection("contacts").insertMany([
		{ _id: id(), newsletterId: nid, email: "twice@reader.example.org", status: "active", createdAt: new Date(), updatedAt: new Date() },
		{ _id: id(), newsletterId: nid, email: "twice@reader.example.org", status: "pending", createdAt: new Date(), updatedAt: new Date() },
	]);
	await assert.rejects(() => migrateFork({ sourceDb: source, targetDb: client.db("upstream-duplicate"), owner: { email: "owner@example.org" }, dumpedAt: new Date(), execute: true }), /duplicate key/);
});
