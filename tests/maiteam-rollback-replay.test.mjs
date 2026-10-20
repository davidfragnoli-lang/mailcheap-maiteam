import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import mongoose from "mongoose";
import { migrateFork } from "../scripts/maiteam/migrate-from-fork.mjs";
import { replay } from "../scripts/maiteam/rollback-replay.mjs";
import { startTestApp } from "./helpers/app.mjs";

// P8c, P8d: after a cutover, a rollback carries readers' unsubscribes, suppressions, confirmations and signups back.
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
	await migrateFork({ sourceDb: oldDb, targetDb: newDb, owner: { email: "owner@r.invalid" }, dumpedAt: new Date(), execute: true });
});

after(() => app?.stop());

test("a rollback replays what readers did on the new server, once", async () => {
	await new Promise((resolve) => setTimeout(resolve, 5));
	const later = new Date();
	const accountId = (await newDb.collection("accounts").findOne({}))._id;
	await newDb.collection("contacts").updateOne({ _id: leaves }, { $set: { status: "unsubscribed", unsubscribedAt: later, updatedAt: later } });
	await newDb.collection("contacts").updateOne({ _id: confirms }, { $set: { status: "active", confirmedAt: later, updatedAt: later } });
	await newDb.collection("contacts").insertOne({ _id: id(), accountId, newsletterId, email: "new@r.invalid", status: "pending", createdAt: later, updatedAt: later });
	await newDb.collection("suppressions").insertOne({ _id: id(), accountId, email: "bounced@r.invalid", reason: "bounce", createdAt: later, updatedAt: later });

	const plan = await replay({ newDb, oldDb });
	assert.equal(plan.passes[0].counts.suppressions, 1);
	assert.equal(plan.passes[0].counts.contacts, 3);
	assert.equal((await oldDb.collection("contacts").findOne({ _id: leaves })).status, "active", "a plan writes nothing");

	const done = await replay({ newDb, oldDb, execute: true });
	assert.equal(done.checks.ok, true, JSON.stringify(done.checks));
	assert.equal((await oldDb.collection("contacts").findOne({ _id: leaves })).status, "unsubscribed");
	assert.equal((await oldDb.collection("contacts").findOne({ _id: confirms })).status, "active");
	assert.equal((await oldDb.collection("contacts").findOne({ _id: stays })).status, "active");
	assert.ok(await oldDb.collection("contacts").findOne({ email: "new@r.invalid", accountId: { $exists: false } }));
	assert.ok(await oldDb.collection("suppressions").findOne({ email: "bounced@r.invalid", reason: "bounce" }));

	const again = await replay({ newDb, oldDb, execute: true });
	assert.deepEqual([again.passes.length, again.passes[0].writes], [1, 0], "a second run changes nothing");
	assert.equal(await oldDb.collection("suppressions").countDocuments({ email: "bounced@r.invalid" }), 1);
});

// QA r1 item 4: a write that lands during a pass with nothing else to do, and a document written without timestamps.
test("a pass that changes nothing still repeats when the new side wrote meanwhile; untimestamped documents are found", async () => {
	const accountId = (await newDb.collection("accounts").findOne({}))._id;
	await newDb.collection("messages").insertOne({ _id: id(), accountId, kind: "campaign", newsletterId, status: "sent", sentAt: new Date(), providerMessageId: "no-timestamps-1" });
	let injected = false;
	const racing = new Proxy(newDb, {
		get(target, prop) {
			if (prop !== "collection") return Reflect.get(target, prop).bind?.(target) ?? Reflect.get(target, prop);
			return (name) => {
				const collection = target.collection(name);
				if (name !== "contacts") return collection;
				return new Proxy(collection, {
					get(inner, key) {
						if (key !== "find") return Reflect.get(inner, key).bind?.(inner) ?? Reflect.get(inner, key);
						return (...args) => {
							const cursor = inner.find(...args);
							return {
								project: (...more) => cursor.project(...more),
								toArray: async () => {
									if (!injected) {
										injected = true;
										await target.collection("suppressions").insertOne({ _id: id(), accountId, email: "midpass@r.invalid", reason: "complaint", createdAt: new Date(), updatedAt: new Date() });
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
	const first = await replay({ newDb, oldDb, execute: true });
	assert.ok(await oldDb.collection("messages").findOne({ sesMessageId: "no-timestamps-1" }), "found by its id's creation time");
	assert.equal(first.converged, true);
	const report = await replay({ newDb: racing, oldDb, execute: true, quietMs: 0 });
	assert.equal(report.converged, true, JSON.stringify(report.passes));
	assert.deepEqual(report.passes.map(({ writes, sourceWrites }) => [writes, sourceWrites > 0]), [[0, true], [1, false], [0, false]]);
	assert.ok(await oldDb.collection("suppressions").findOne({ email: "midpass@r.invalid" }), "the mid-pass suppression reached the old database");
});
