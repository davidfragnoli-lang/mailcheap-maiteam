import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import mongoose from "mongoose";
import { catchUp, RESUME_REASON } from "../scripts/maiteam/catch-up.mjs";
import { HOLD_REASON, migrateFork } from "../scripts/maiteam/migrate-from-fork.mjs";
import { holdOldSequences, replay } from "../scripts/maiteam/rollback-replay.mjs";
import { startTestApp } from "./helpers/app.mjs";
import { published } from "./stubs/qstash.mjs";

// P8d (PATCHES.md), QA r1 item 4 (FRA-25999): the write boundary of the cutover, both ways. The migration copies the
// old database as of its dump and holds the new one; the old server keeps writing until the alias moves and it drains;
// the catch-up brings all of it over, pass after pass, together with the clicks the new server recorded during the
// hold. A rollback carries the new server's writes back the same way. Writes land between passes on purpose.
let app;
let oldDb;
let newDb;
let m;
const id = () => new mongoose.Types.ObjectId();
const DAY = 86_400_000;
const before1 = new Date(Date.now() - DAY);
const newsletterId = id();
const sequenceId = id();
const [readerA, readerB, readerC] = [id(), id(), id()];
const [enrollmentA, enrollmentB, enrollmentC] = [id(), id(), id()];
const firstStepFor = new Date(before1.getTime() + 60_000).toISOString();

// A database whose `name` collection runs `action` once, right before its first read: a write landing mid-pass.
function racing(db, name, action) {
	let done = false;
	return new Proxy(db, {
		get(target, prop) {
			if (prop !== "collection") return Reflect.get(target, prop).bind?.(target) ?? Reflect.get(target, prop);
			return (collectionName) => {
				const collection = target.collection(collectionName);
				if (collectionName !== name) return collection;
				return new Proxy(collection, {
					get(inner, key) {
						if (key !== "find") return Reflect.get(inner, key).bind?.(inner) ?? Reflect.get(inner, key);
						return (...args) => {
							const cursor = inner.find(...args);
							return {
								project: (...more) => cursor.project(...more),
								toArray: async () => {
									if (!done) {
										done = true;
										await action();
									}
									return cursor.toArray();
								},
							};
						};
					},
				});
			};
		},
	});
}

before(async () => {
	app = await startTestApp({ MAILCHEAP_CLOUD: "" });
	await mongoose.disconnect();
	await mongoose.connect(process.env.MONGODB_URI.replace("/mailcheap-test", "/cutover-new"));
	const client = mongoose.connection.getClient();
	oldDb = client.db("cutover-old");
	newDb = mongoose.connection.db;
	await oldDb.collection("newsletters").insertOne({ _id: newsletterId, name: "fortuna", slug: "fortuna", fromEmail: "welcome@mail.maiteam.ch", requireConfirmation: true, dailySendCap: 50, createdAt: before1, updatedAt: before1 });
	await oldDb.collection("sequences").insertOne({
		_id: sequenceId,
		newsletterId,
		name: "welcome",
		slug: "welcome",
		status: "active",
		steps: [
			{ position: 1, delayDays: 0, delayFromEnrollmentMs: 0, subject: "One", markdown: "One" },
			{ position: 2, delayDays: 1, delayFromEnrollmentMs: DAY, subject: "Two", markdown: "Two" },
		],
		createdAt: before1,
		updatedAt: before1,
	});
	await oldDb.collection("contacts").insertOne({ _id: readerA, newsletterId, email: "a@reader.example.org", status: "active", createdAt: before1, updatedAt: before1 });
	await oldDb.collection("enrollments").insertOne({
		_id: enrollmentA,
		newsletterId,
		sequenceId,
		contactId: readerA,
		email: "a@reader.example.org",
		status: "active",
		enrolledAt: before1,
		steps: [
			{ position: 1, status: "scheduled", scheduledFor: firstStepFor },
			{ position: 2, status: "pending" },
		],
		createdAt: before1,
		updatedAt: before1,
	});
	await oldDb.collection("suppressions").insertOne({ _id: id(), email: "old@reader.example.org", reason: "bounce", createdAt: before1, updatedAt: before1 });
	m = {
		cutover: await import("../lib/maiteam/cutover.js"),
		store: await import("../lib/maiteam/sequence-store.js"),
		unsubscribeRoute: await import("../app/api/unsubscribe/route.js"),
		unsubscribe: await import("../lib/unsubscribe.js"),
		confirm: await import("../app/confirm/actions.js"),
		confirmation: await import("../lib/confirmation.js"),
		ses: await import("../lib/ses-events.js"),
	};
});

after(() => app?.stop());

let dumpedAt;
let accountId;

test("the migration lands in the hold: account blocked, running sequences paused, campaigns mid-send refused", async () => {
	const busy = await migrateFork({ sourceDb: racing(oldDb, "none", async () => {}), targetDb: newDb, owner: { email: "owner@example.org" }, dumpedAt: new Date() });
	assert.deepEqual(busy.relationships.hard, {});
	await oldDb.collection("campaigns").insertOne({ _id: id(), newsletterId, subject: "Mid-send", status: "sending", createdAt: before1, updatedAt: before1 });
	const refused = await migrateFork({ sourceDb: oldDb, targetDb: newDb, owner: { email: "owner@example.org" }, dumpedAt: new Date() });
	assert.ok(refused.problems.some((line) => line.startsWith("campaigns: 1 scheduled or sending")));
	await oldDb.collection("campaigns").deleteMany({});

	dumpedAt = new Date();
	const report = await migrateFork({ sourceDb: oldDb, targetDb: newDb, owner: { email: "owner@example.org" }, dumpedAt, execute: true });
	assert.equal(report.checks.ok, true, JSON.stringify(report.checks));
	accountId = new mongoose.Types.ObjectId(report.accountId);
	const account = await newDb.collection("accounts").findOne({ _id: accountId });
	assert.deepEqual([account.status, account.pauseReason], ["paused", HOLD_REASON]);
	assert.equal((await newDb.collection("sequences").findOne({ _id: sequenceId })).status, "paused");
	const cutover = await newDb.collection("maiteam_cutover").findOne({});
	assert.equal(cutover.state, "holding");
	assert.deepEqual(cutover.sequences.map(({ status }) => status), ["active"]);
});

test("between the dump and the switch, the old server's writes and the new server's clicks are all kept", async () => {
	const later = new Date(dumpedAt.getTime() + 1_000);
	// The old server, still serving: step 1 goes out, two readers sign up, an address bounces.
	const sentMessage = id();
	await oldDb.collection("messages").insertOne({ _id: sentMessage, kind: "sequence", newsletterId, contactId: readerA, sequenceId, enrollmentId: enrollmentA, stepPosition: 1, email: "a@reader.example.org", status: "sent", sentAt: later, sesMessageId: "old-ses-after-dump", createdAt: later, updatedAt: later });
	await oldDb.collection("enrollments").updateOne(
		{ _id: enrollmentA },
		{ $set: { "steps.0.status": "sent", "steps.0.sentAt": later, "steps.0.messageId": String(sentMessage), "steps.1.status": "scheduled", "steps.1.scheduledFor": new Date(before1.getTime() + DAY).toISOString(), updatedAt: later } }
	);
	for (const [contactId, enrollmentId, email] of [
		[readerB, enrollmentB, "b@reader.example.org"],
		[readerC, enrollmentC, "c@reader.example.org"],
	]) {
		await oldDb.collection("contacts").insertOne({ _id: contactId, newsletterId, email, status: "pending", createdAt: later, updatedAt: later });
		await oldDb.collection("enrollments").insertOne({ _id: enrollmentId, newsletterId, sequenceId, contactId, email, status: "awaiting_confirmation", enrolledAt: later, steps: [{ position: 1, status: "held" }, { position: 2, status: "held" }], createdAt: later, updatedAt: later });
	}
	await oldDb.collection("suppressions").insertOne({ _id: id(), email: "late1@reader.example.org", reason: "bounce", createdAt: later, updatedAt: later });

	// The alias moved: the new server, in the hold, gets clicks for readers it doesn't have yet.
	const token = m.unsubscribe.createUnsubscribeToken({ contactId: readerB, newsletterId });
	const response = await m.unsubscribeRoute.POST(new Request(`http://localhost:3000/api/unsubscribe?token=${token}`, { method: "POST" }));
	assert.equal(response.status, 200);
	assert.deepEqual(await m.confirm.confirmSubscription(m.confirmation.createConfirmToken({ contactId: readerC, newsletterId })), { ok: true });
	assert.equal(await newDb.collection("maiteam_cutover_pending").countDocuments({ appliedAt: null }), 2);
	// A late bounce for mail the old server sent after the dump: no Message here yet, and the address is still suppressed.
	await m.ses.handleSesEvent({ eventType: "Bounce", mail: { messageId: "old-ses-unknown", destination: ["late2@reader.example.org"] }, bounce: { bounceType: "Permanent", bouncedRecipients: [{ emailAddress: "late2@reader.example.org" }], timestamp: new Date().toISOString() } });
	assert.ok(await newDb.collection("suppressions").findOne({ accountId, email: "late2@reader.example.org" }));
	// Jobs the old server published, with no account: resolved by enrollment, and nothing is sent while held.
	assert.equal((await m.store.runSequenceStep({ enrollmentId: String(enrollmentA), position: 2, scheduledFor: firstStepFor })).outcome, "paused");
	const unknown = await m.store.runSequenceStep({ enrollmentId: String(id()), position: 1 });
	assert.equal(unknown.outcome, "unavailable", "retried (503) while the catch-up may still bring it");

	// The catch-up, with one more bounce landing on the old database while its first pass runs.
	const source = racing(oldDb, "contacts", () => oldDb.collection("suppressions").insertOne({ _id: id(), email: "late3@reader.example.org", reason: "complaint", createdAt: new Date(), updatedAt: new Date() }));
	const report = await catchUp({ sourceDb: source, targetDb: newDb, execute: true });
	assert.equal(report.converged, true, JSON.stringify(report.passes));
	assert.ok(report.passes.length >= 2, "the mid-pass write needed another pass");
	assert.equal(report.passes.at(-1).writes, 0);
	assert.equal(report.checks.ok, true, JSON.stringify(report.checks));
	assert.deepEqual(report.problems, []);

	for (const email of ["old@reader.example.org", "late1@reader.example.org", "late2@reader.example.org", "late3@reader.example.org"]) {
		assert.ok(await newDb.collection("suppressions").findOne({ accountId, email }), `${email} suppressed`);
	}
	assert.equal((await newDb.collection("contacts").findOne({ _id: readerB })).status, "unsubscribed");
	assert.equal((await newDb.collection("enrollments").findOne({ _id: enrollmentB })).status, "cancelled");
	assert.equal((await newDb.collection("contacts").findOne({ _id: readerC })).status, "active");
	const enrollmentOfC = await newDb.collection("enrollments").findOne({ _id: enrollmentC });
	assert.deepEqual([enrollmentOfC.status, enrollmentOfC.steps.map(({ status }) => status)], ["active", ["held", "held"]]);
	const migratedA = await newDb.collection("enrollments").findOne({ _id: enrollmentA });
	assert.deepEqual(migratedA.steps.map(({ status }) => status), ["sent", "scheduled"]);
	const message = await newDb.collection("messages").findOne({ _id: sentMessage });
	assert.deepEqual([message.providerMessageId, message.migratedFromFork, Boolean(message.sentAt)], ["old-ses-after-dump", true, true]);

	// The same catch-up again: nothing to do.
	const again = await catchUp({ sourceDb: oldDb, targetDb: newDb, execute: true });
	assert.equal(again.passes.length, 1);
	assert.equal(again.passes[0].writes, 0);
});

let releasedAt;

test("the release unblocks the account; Resume rebuilds each job once and never resends a finished step", async () => {
	const report = await catchUp({ sourceDb: oldDb, targetDb: newDb, execute: true, release: true });
	assert.deepEqual(report.released.sequencesToResume, [String(sequenceId)]);
	releasedAt = new Date();
	assert.equal((await newDb.collection("accounts").findOne({ _id: accountId })).status, "active");
	assert.equal((await newDb.collection("sequences").findOne({ _id: sequenceId })).pauseReason, RESUME_REASON);
	await assert.rejects(() => catchUp({ sourceDb: oldDb, targetDb: newDb, execute: true }), /released/);

	const from = published.length;
	const started = await m.store.startSequence({ accountId, sequenceId });
	assert.deepEqual(started, { ok: true, scheduled: 2, waiting: 0 });
	const jobs = published.slice(from).filter(({ url }) => url.endsWith("/api/jobs/sequence-step")).map(({ body }) => [body.enrollmentId, body.position]);
	assert.deepEqual(jobs.sort(), [[String(enrollmentA), 2], [String(enrollmentC), 1]].sort(), "A's sent step 1 is not published again");
	// The old server's job for A's step 2 arrives too: the rebuilt one replaced it.
	const legacy = await m.store.runSequenceStep({ enrollmentId: String(enrollmentA), position: 2, scheduledFor: new Date(before1.getTime() + DAY).toISOString() });
	assert.equal(legacy.outcome, "duplicate");
});

test("a rollback carries the new server's writes back, with a write landing mid-pass, and finished steps stay finished", async () => {
	const later = new Date(Math.max(Date.now(), releasedAt.getTime()) + 1_000);
	const [sentStep2, readerD, enrollmentD, queuedD] = [id(), id(), id(), id()];
	// The new server after the release: A's step 2 sent, A then unsubscribes, D signs up and its step 1 is put off.
	await newDb.collection("messages").insertOne({ _id: sentStep2, accountId, kind: "sequence", newsletterId, contactId: readerA, sequenceId, enrollmentId: enrollmentA, stepPosition: 2, email: "a@reader.example.org", status: "delivered", sentAt: later, providerMessageId: "new-ses-step-2", createdAt: later, updatedAt: later });
	await newDb.collection("enrollments").updateOne({ _id: enrollmentA }, { $set: { status: "completed", "steps.1.status": "sent", "steps.1.messageId": String(sentStep2), updatedAt: later } });
	await newDb.collection("contacts").updateOne({ _id: readerA }, { $set: { status: "unsubscribed", unsubscribedAt: later, updatedAt: later } });
	await newDb.collection("events").insertOne({ _id: id(), accountId, type: "delivered", messageId: sentStep2, providerMessageId: "new-ses-step-2", email: "a@reader.example.org", occurredAt: later, createdAt: later, updatedAt: later });
	await newDb.collection("contacts").insertOne({ _id: readerD, accountId, newsletterId, email: "d@reader.example.org", status: "active", createdAt: later, updatedAt: later });
	await newDb.collection("enrollments").insertOne({ _id: enrollmentD, accountId, newsletterId, sequenceId, contactId: readerD, email: "d@reader.example.org", status: "active", enrolledAt: later, steps: [{ position: 1, status: "sending", messageId: String(queuedD), scheduledFor: later.toISOString() }, { position: 2, status: "pending" }], createdAt: later, updatedAt: later });
	await newDb.collection("messages").insertOne({ _id: queuedD, accountId, kind: "sequence", newsletterId, contactId: readerD, sequenceId, enrollmentId: enrollmentD, stepPosition: 1, email: "d@reader.example.org", status: "queued", sentAt: null, createdAt: later, updatedAt: later });
	await newDb.collection("suppressions").insertOne({ _id: id(), accountId, email: "late4@reader.example.org", reason: "complaint", createdAt: later, updatedAt: later });
	// The old server, back on the alias while the new one drains, takes D's signup again under its own id.
	const oldD = id();
	await oldDb.collection("contacts").insertOne({ _id: oldD, newsletterId, email: "d@reader.example.org", status: "pending", createdAt: later, updatedAt: later });

	assert.deepEqual(await holdOldSequences({ oldDb, execute: true }), { mode: "execute", sequencesHeld: 1 });
	assert.equal((await oldDb.collection("sequences").findOne({ _id: sequenceId })).status, "paused");
	const plan = await replay({ newDb, oldDb });
	assert.equal(plan.since, dumpedAt.toISOString(), "from the dump: the hold's clicks go back too");
	await assert.rejects(() => replay({ newDb, oldDb, since: releasedAt }), /after the dump/);
	assert.equal(plan.mode, "plan");
	assert.equal((await oldDb.collection("contacts").findOne({ _id: readerA })).status, "active", "a plan writes nothing");

	const draining = racing(newDb, "contacts", () => newDb.collection("suppressions").insertOne({ _id: id(), accountId, email: "late5@reader.example.org", reason: "bounce", createdAt: new Date(), updatedAt: new Date() }));
	const report = await replay({ newDb: draining, oldDb, execute: true });
	assert.equal(report.converged, true, JSON.stringify(report.passes));
	assert.ok(report.passes.length >= 2);
	assert.equal(report.checks.ok, true, JSON.stringify(report.checks));
	assert.equal(report.ambiguousSteps, 0);

	const oldA = await oldDb.collection("enrollments").findOne({ _id: enrollmentA });
	assert.deepEqual([oldA.status, oldA.steps.map(({ status }) => status)], ["completed", ["sent", "sent"]], "the old server can't send A's steps again");
	assert.equal((await oldDb.collection("messages").findOne({ _id: sentStep2 })).sesMessageId, "new-ses-step-2");
	assert.equal((await oldDb.collection("events").findOne({ messageId: sentStep2 })).type, "Delivery");
	assert.equal((await oldDb.collection("contacts").findOne({ _id: readerA })).status, "unsubscribed");
	assert.equal(await oldDb.collection("contacts").countDocuments({ email: "d@reader.example.org" }), 1, "one D, under the old server's id");
	assert.equal((await oldDb.collection("contacts").findOne({ _id: oldD })).status, "active");
	const oldEnrollmentD = await oldDb.collection("enrollments").findOne({ sequenceId, contactId: oldD });
	assert.deepEqual(oldEnrollmentD.steps.map(({ status }) => status), ["held", "pending"], "the put-off step is open again for the old Resume");
	assert.equal(await oldDb.collection("messages").countDocuments({ _id: queuedD }), 0, "its unsent email stays behind");
	for (const email of ["late4@reader.example.org", "late5@reader.example.org"]) assert.ok(await oldDb.collection("suppressions").findOne({ email }), `${email} suppressed`);

	const again = await replay({ newDb, oldDb, execute: true });
	assert.equal((await oldDb.collection("contacts").findOne({ _id: readerB })).status, "unsubscribed", "B's click during the hold went back too");
	assert.deepEqual([again.passes.length, again.passes[0].writes], [1, 0], "a second run changes nothing");
});
