import "server-only";
import mongoose from "mongoose";
import { connectDb } from "@/lib/db";

// maiteam (PATCHES.md P8d): the handoff from the old fork's database. scripts/maiteam/migrate-from-fork.mjs writes one
// document here. While it says "holding", the migrated account is blocked (upstream's own block: no email goes out
// and no new signup is taken) and every sequence is paused, while scripts/maiteam/catch-up.mjs copies what the old
// server wrote after its dump. A reader's click that names a contact the new database doesn't have yet is recorded
// here instead of being dropped, and the catch-up applies it once the contact has arrived.
//
// The "fork-cutover" document stays after the release: it names the account that owns the old fork's mail.

export const CUTOVER_ID = "fork-cutover";
const CUTOVER = "maiteam_cutover";
const PENDING = "maiteam_cutover_pending";
export const PENDING_KINDS = ["unsubscribe", "confirm", "keep"];

const collection = (name) => mongoose.connection.db.collection(name);

export async function readCutover() {
	await connectDb();
	return collection(CUTOVER).findOne({ _id: CUTOVER_ID });
}

export async function isHolding() {
	return (await readCutover())?.state === "holding";
}

// The account the migration created for the old fork's mail, while or after the handoff; null on any other install.
export async function forkAccountId() {
	const cutover = await readCutover();
	return cutover?.accountId ? new mongoose.Types.ObjectId(String(cutover.accountId)) : null;
}

// Recorded only while holding, and only for a contact this database doesn't have: anything else is upstream's own case.
export async function recordPendingAction(kind, { contactId, newsletterId }) {
	if (!PENDING_KINDS.includes(kind) || !(await isHolding())) return false;
	const id = String(contactId ?? "");
	if (!mongoose.isValidObjectId(id)) return false;
	const contact = new mongoose.Types.ObjectId(id);
	if (await collection("contacts").findOne({ _id: contact }, { projection: { _id: 1 } })) return false;
	await collection(PENDING).updateOne(
		{ kind, contactId: contact, newsletterId: new mongoose.Types.ObjectId(String(newsletterId)) },
		{ $setOnInsert: { at: new Date(), appliedAt: null } },
		{ upsert: true }
	);
	return true;
}
