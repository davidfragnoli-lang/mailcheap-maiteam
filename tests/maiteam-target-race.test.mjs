import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import mongoose from "mongoose";
import { catchUp } from "../scripts/maiteam/catch-up.mjs";
import { MERGE_ATTEMPTS, mergeContact, upsertMerged } from "../scripts/maiteam/fork-sync.mjs";
import { migrateFork } from "../scripts/maiteam/migrate-from-fork.mjs";
import { replay } from "../scripts/maiteam/rollback-replay.mjs";
import { startTestApp } from "./helpers/app.mjs";

// P8e (PATCHES.md), QA r2 item 1 (FRA-25999): the side a catch-up or a rollback writes to keeps taking writes of its
// own: a reader unsubscribes during the hold, or on the old server once the alias moved back. A write landing between
// the merge's read and its replace is merged in, never overwritten. QA's probe: a real update injected right after the
// merge reads the document.
let app;
let client;
const id = () => new mongoose.Types.ObjectId();

// `db`, whose `contacts` collection runs `action` once, right after its `nth` findOne returned a document.
function afterRead(db, action, nth = 1) {
	let reads = 0;
	return {
		collection(name) {
			const collection = db.collection(name);
			if (name !== "contacts") return collection;
			return new Proxy(collection, {
				get(inner, key) {
					if (key === "findOne")
						return async (...args) => {
							const found = await inner.findOne(...args);
							if (found && (reads += 1) === nth) {
								await action();
							}
							return found;
						};
					const value = inner[key];
					return typeof value === "function" ? value.bind(inner) : value;
				},
			});
		},
		listCollections: (...args) => db.listCollections(...args),
	};
}

async function migrated(prefix) {
	const source = client.db(`${prefix}-old`);
	const target = client.db(`${prefix}-new`);
	const newsletterId = id();
	const contactId = id();
	const t = new Date(Date.now() - 60_000);
	await source.collection("newsletters").insertOne({ _id: newsletterId, name: "QA", slug: prefix, fromEmail: "qa@example.invalid", createdAt: t, updatedAt: t });
	await source.collection("contacts").insertOne({ _id: contactId, newsletterId, email: "qa@example.invalid", status: "active", createdAt: t, updatedAt: t });
	await migrateFork({ sourceDb: source, targetDb: target, owner: { email: "owner@example.invalid" }, dumpedAt: new Date(t.getTime() - 1000), execute: true });
	return { source, target, contactId, t };
}

before(async () => {
	app = await startTestApp();
	client = mongoose.connection.getClient();
});

after(() => app?.stop());

test("catch-up: an unsubscribe on the new server between the merge's read and its write is kept, and the release still holds", async () => {
	const { source, target, contactId, t } = await migrated("race-catchup");
	await source.collection("contacts").updateOne({ _id: contactId }, { $set: { firstName: "Later old-server edit", updatedAt: new Date(t.getTime() + 1000) } });
	const unsubscribe = () => target.collection("contacts").updateOne({ _id: contactId }, { $set: { status: "unsubscribed", unsubscribedAt: new Date(), updatedAt: new Date() } });

	const report = await catchUp({ sourceDb: source, targetDb: afterRead(target, unsubscribe), execute: true, release: true, quietMs: 0 });
	const contact = await target.collection("contacts").findOne({ _id: contactId });
	assert.equal(contact.status, "unsubscribed");
	assert.ok(contact.unsubscribedAt);
	assert.equal(report.converged, true);
	assert.equal(report.checks.ok, true);
	assert.ok(report.released);
});

test("rollback: an unsubscribe on the old server between the merge's read and its write is kept over the new server's later change", async () => {
	const { source: oldDb, target: newDb, contactId } = await migrated("race-rollback");
	await new Promise((resolve) => setTimeout(resolve, 5));
	// The new server's own change to the reader, then the reader unsubscribes on the old one just as the merge reads it
	// (the replay's first read of the contact looks it up by address; the second is the merge's).
	await newDb.collection("contacts").updateOne({ _id: contactId }, { $set: { status: "dormant", updatedAt: new Date() } });
	await new Promise((resolve) => setTimeout(resolve, 5));
	const unsubscribe = () => oldDb.collection("contacts").updateOne({ _id: contactId }, { $set: { status: "unsubscribed", unsubscribedAt: new Date(), updatedAt: new Date() } });

	const report = await replay({ newDb, oldDb: afterRead(oldDb, unsubscribe, 2), execute: true, quietMs: 0 });
	const contact = await oldDb.collection("contacts").findOne({ _id: contactId });
	assert.equal(contact.status, "unsubscribed");
	assert.ok(contact.unsubscribedAt);
	assert.equal(report.converged, true);
	assert.equal(report.checks.ok, true);
});

test("the compare-and-swap sees any change, an added field too, and gives up rather than overwrite", async () => {
	const collection = client.db("race-unit").collection("contacts");
	const _id = id();
	const at = new Date(Date.now() - 1000);
	await collection.insertOne({ _id, email: "a@example.invalid", status: "active", updatedAt: at });
	// A field added between read and write (no existing field changed) still sends the merge round again.
	let added = false;
	const racing = new Proxy(collection, {
		get(inner, key) {
			if (key === "findOne")
				return async (...args) => {
					const found = await inner.findOne(...args);
					if (!added) {
						added = true;
						await inner.updateOne({ _id }, { $set: { note: "kept" } });
					}
					return found;
				};
			const value = inner[key];
			return typeof value === "function" ? value.bind(inner) : value;
		},
	});
	const incoming = { _id, email: "a@example.invalid", status: "active", firstName: "Edit", updatedAt: new Date() };
	assert.equal(await upsertMerged({ collection: racing, doc: incoming, merge: (current, doc) => ({ ...mergeContact(current, doc), note: current.note }), execute: true }), 1);
	const merged = await collection.findOne({ _id });
	assert.equal(merged.note, "kept");
	assert.equal(merged.firstName, "Edit");

	// A document that changes on every attempt: an error, and the last write by the other side stays.
	let writes = 0;
	const restless = new Proxy(collection, {
		get(inner, key) {
			if (key === "findOne")
				return async (...args) => {
					const found = await inner.findOne(...args);
					await inner.updateOne({ _id }, { $set: { other: (writes += 1) } });
					return found;
				};
			const value = inner[key];
			return typeof value === "function" ? value.bind(inner) : value;
		},
	});
	await assert.rejects(upsertMerged({ collection: restless, doc: { ...incoming, firstName: "Never", updatedAt: new Date(Date.now() + 1000) }, merge: mergeContact, execute: true }), /kept changing/);
	const untouched = await collection.findOne({ _id });
	assert.equal(untouched.firstName, "Edit");
	assert.equal(untouched.other, MERGE_ATTEMPTS);

	// An insert that loses to the same document arriving meanwhile merges into it.
	const fresh = id();
	const late = new Proxy(collection, {
		get(inner, key) {
			if (key === "insertOne")
				return async (doc) => {
					await inner.insertOne({ _id: fresh, email: "b@example.invalid", status: "unsubscribed", unsubscribedAt: new Date(), updatedAt: new Date(Date.now() - 500) });
					return inner.insertOne(doc);
				};
			const value = inner[key];
			return typeof value === "function" ? value.bind(inner) : value;
		},
	});
	assert.equal(await upsertMerged({ collection: late, doc: { _id: fresh, email: "b@example.invalid", status: "active", updatedAt: new Date() }, merge: mergeContact, execute: true }), 1);
	assert.equal((await collection.findOne({ _id: fresh })).status, "unsubscribed");
});
