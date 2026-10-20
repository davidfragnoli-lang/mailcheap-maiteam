import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import mongoose from "mongoose";
import { migrateFork } from "../scripts/maiteam/migrate-from-fork.mjs";
import { replay } from "../scripts/maiteam/rollback-replay.mjs";
import { startTestApp } from "./helpers/app.mjs";

// P8c: after a cutover, a rollback carries readers' unsubscribes, suppressions, confirmations and signups back.
let app;
let oldDb;
let newDb;
const id = () => new mongoose.Types.ObjectId();
const newsletterId = id();
const [stays, leaves, confirms] = [id(), id(), id()];

before(async () => {
	app = await startTestApp();
	const client = mongoose.connection.getClient();
	oldDb = client.db("rollback-old");
	newDb = client.db("rollback-new");
	const created = new Date("2026-10-01T00:00:00Z");
	await oldDb.collection("newsletters").insertOne({ _id: newsletterId, name: "n", slug: "rollback-n", fromEmail: "hello@mail.maiteam.ch", createdAt: created, updatedAt: created });
	await oldDb.collection("contacts").insertMany([
		{ _id: stays, newsletterId, email: "stays@r.invalid", status: "active", createdAt: created, updatedAt: created },
		{ _id: leaves, newsletterId, email: "leaves@r.invalid", status: "active", createdAt: created, updatedAt: created },
		{ _id: confirms, newsletterId, email: "confirms@r.invalid", status: "pending", createdAt: created, updatedAt: created },
	]);
	await migrateFork({ sourceDb: oldDb, targetDb: newDb, owner: { email: "owner@r.invalid" }, execute: true });
});

after(() => app?.stop());

test("a rollback replays what readers did on the new server, once", async () => {
	const cutover = new Date();
	const later = new Date(cutover.getTime() + 60_000);
	const accountId = (await newDb.collection("accounts").findOne({}))._id;
	await newDb.collection("contacts").updateOne({ _id: leaves }, { $set: { status: "unsubscribed", unsubscribedAt: later, updatedAt: later } });
	await newDb.collection("contacts").updateOne({ _id: confirms }, { $set: { status: "active", confirmedAt: later, updatedAt: later } });
	await newDb.collection("contacts").insertOne({ _id: id(), accountId, newsletterId, email: "new@r.invalid", status: "pending", createdAt: later, updatedAt: later });
	await newDb.collection("suppressions").insertOne({ _id: id(), accountId, email: "bounced@r.invalid", reason: "bounce", createdAt: later, updatedAt: later });

	const plan = await replay({ newDb, oldDb, since: cutover.toISOString() });
	assert.deepEqual([plan.suppressions, plan.contactsLeft, plan.contactsConfirmed, plan.contactsNew], [1, 1, 1, 1]);
	assert.equal((await oldDb.collection("contacts").findOne({ _id: leaves })).status, "active", "a plan writes nothing");

	await replay({ newDb, oldDb, since: cutover.toISOString(), execute: true });
	assert.equal((await oldDb.collection("contacts").findOne({ _id: leaves })).status, "unsubscribed");
	assert.equal((await oldDb.collection("contacts").findOne({ _id: confirms })).status, "active");
	assert.equal((await oldDb.collection("contacts").findOne({ _id: stays })).status, "active");
	assert.ok(await oldDb.collection("contacts").findOne({ email: "new@r.invalid", accountId: { $exists: false } }));
	assert.ok(await oldDb.collection("suppressions").findOne({ email: "bounced@r.invalid", reason: "bounce" }));

	const again = await replay({ newDb, oldDb, since: cutover.toISOString(), execute: true });
	assert.deepEqual([again.contactsLeft, again.contactsConfirmed, again.contactsNew], [0, 0, 0], "a second run changes nothing");
	assert.equal(await oldDb.collection("suppressions").countDocuments({ email: "bounced@r.invalid" }), 1);
});
