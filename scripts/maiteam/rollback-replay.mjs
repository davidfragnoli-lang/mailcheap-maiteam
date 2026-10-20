// P8c (PATCHES.md): what a rollback to the old fork must carry back. The migration writes a new database and leaves
// the old one untouched, so rolling back points mailcheap.maiteam.ch at the old deployment and the old database
// again. Whatever readers did on the new server since the cutover has to reach the old database first: an
// unsubscribe, a bounce or complaint suppression, a confirmation, a new signup. Nothing else is copied back.
//
//   ROLLBACK_NEW_URI=… ROLLBACK_OLD_URI=… node scripts/maiteam/rollback-replay.mjs --since <cutover ISO time> [--execute]
//
// Without --execute it only counts. Contacts keep their ids across the move, so a change lands on the same document.
// The report holds counts only.

import mongoose from "mongoose";

// The old fork's contact statuses are upstream's; a reader who left stays left, whatever the old document says.
const LEFT = new Set(["unsubscribed", "bounced", "complained"]);

export async function replay({ newDb, oldDb, since, execute = false }) {
	const at = new Date(since);
	if (!Number.isFinite(at.getTime())) throw new Error("--since must be the cutover time, as an ISO date");
	const report = { mode: execute ? "execute" : "plan", since: at.toISOString(), suppressions: 0, contactsLeft: 0, contactsConfirmed: 0, contactsNew: 0, skipped: 0 };

	for (const suppression of await newDb.collection("suppressions").find({ createdAt: { $gte: at } }).toArray()) {
		report.suppressions += 1;
		if (execute) {
			const { email, reason, detail, createdAt } = suppression;
			// The old list is one per server, unique by address; its reasons have no "provider".
			await oldDb.collection("suppressions").updateOne(
				{ email },
				{ $setOnInsert: { email, reason: reason === "provider" ? "manual" : reason, ...(detail && { detail }), createdAt, updatedAt: new Date() } },
				{ upsert: true }
			);
		}
	}

	for (const contact of await newDb.collection("contacts").find({ $or: [{ updatedAt: { $gte: at } }, { createdAt: { $gte: at } }] }).toArray()) {
		const old = await oldDb.collection("contacts").findOne({ _id: contact._id });
		const { accountId, ...fields } = contact;
		if (!old) {
			report.contactsNew += 1;
			if (execute) await oldDb.collection("contacts").insertOne(fields);
			continue;
		}
		if (LEFT.has(contact.status) && !LEFT.has(old.status)) {
			report.contactsLeft += 1;
			if (execute) {
				await oldDb.collection("contacts").updateOne(
					{ _id: contact._id },
					{ $set: { status: contact.status, ...(contact.unsubscribedAt && { unsubscribedAt: contact.unsubscribedAt }), updatedAt: new Date() } }
				);
			}
		} else if (contact.status === "active" && old.status === "pending") {
			report.contactsConfirmed += 1;
			if (execute) await oldDb.collection("contacts").updateOne({ _id: contact._id, status: "pending" }, { $set: { status: "active", ...(contact.confirmedAt && { confirmedAt: contact.confirmedAt }), updatedAt: new Date() } });
		} else report.skipped += 1;
	}
	return report;
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
	const argv = process.argv.slice(2);
	const since = argv[argv.indexOf("--since") + 1];
	const { ROLLBACK_NEW_URI: newUri, ROLLBACK_OLD_URI: oldUri } = process.env;
	if (!newUri || !oldUri || newUri === oldUri) throw new Error("Set ROLLBACK_NEW_URI and ROLLBACK_OLD_URI to two different databases");
	const [newClient, oldClient] = await Promise.all([new mongoose.mongo.MongoClient(newUri).connect(), new mongoose.mongo.MongoClient(oldUri).connect()]);
	try {
		console.log(JSON.stringify(await replay({ newDb: newClient.db(), oldDb: oldClient.db(), since, execute: argv.includes("--execute") })));
	} finally {
		await Promise.all([newClient.close(), oldClient.close()]);
	}
}
