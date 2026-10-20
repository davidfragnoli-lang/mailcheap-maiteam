// P8c, P8d (PATCHES.md): what a rollback to the old fork carries back. The migration left the old database untouched,
// so rolling back points mailcheap.maiteam.ch at the old deployment and the old database again. Whatever the new server
// did since the cutover reaches the old database first, by the merge rules both directions share
// (scripts/maiteam/fork-sync.mjs): unsubscribes, suppressions, confirmations, new signups and their enrollments, sequence
// progress, the emails sent with their provider ids, SES events, and today's send caps. A step finished on the new
// server is finished on the old one, so the old server never sends it again.
//
//   ROLLBACK_NEW_URI=… ROLLBACK_OLD_URI=… node scripts/maiteam/rollback-replay.mjs --hold [--execute]
//     (before the alias moves back: pauses the old database's running sequences, so it sends no step until the end)
//   … [--execute] [--since <ISO time, at or before the dump>]
//     (after the alias moved back and the new deployment drained: passes until one changes nothing)
//
// The old server's Resume takes each enrollment's first open step, so a step the new server queued but never handed off
// comes back open (held), without its unsent email, and is sent from there. A step left in flight or failed before an
// open one is counted as ambiguousSteps for the operator: Resume on the old server would go past it.
// The report holds counts only.

import mongoose from "mongoose";
import { EVENT_TYPES } from "./migrate-from-fork.mjs";
import { LEFT, OPEN_STEP, changedSince, converge, mergeCap, mergeContact, mergeEnrollment, mergeMessage, upsertMerged } from "./fork-sync.mjs";

const ROLLBACK_ID = "rollback";
const HOLD_REASON = "Rolled back from the new server: resume once the replay has converged.";
const EVENT_NAMES = Object.fromEntries(Object.entries(EVENT_TYPES).reverse().map(([oldName, newName]) => [newName, oldName]));
const FINISHED = ["sent", "skipped", "failed", "cancelled"];

const strip = ({ accountId, ...doc }) => doc;
const unsentSequenceEmail = (message) => message.kind === "sequence" && !message.sentAt && message.status === "queued";

function toOldMessage(doc) {
	const { providerMessageId, migratedFromFork, ...rest } = strip(doc);
	return providerMessageId ? { ...rest, sesMessageId: providerMessageId } : rest;
}

function toOldEvent(doc) {
	const { providerMessageId, ...rest } = strip(doc);
	return { ...rest, ...(providerMessageId && { sesMessageId: providerMessageId }), type: EVENT_NAMES[doc.type] ?? doc.type };
}

function toOldLook(doc, from = "look") {
	const { [from]: look, ...rest } = doc;
	return look ? { ...rest, theme: look } : rest;
}

// The old Resume starts at the first open step: a queued, never-sent step must be open again, and nothing unresolved may
// sit before an open one unnoticed.
export function mapStepsForOldResume(steps = []) {
	const sorted = [...steps].sort((a, b) => a.position - b.position);
	const mapped = sorted.map((step) => (step.status === "sending" ? { position: step.position, status: "held", ...(step.scheduledFor && { scheduledFor: step.scheduledFor }) } : step));
	const firstOpen = mapped.findIndex(({ status }) => OPEN_STEP.includes(status));
	const ambiguous = firstOpen > 0 && mapped.slice(0, firstOpen).some(({ status }) => !FINISHED.includes(status) || status === "failed");
	return { steps: mapped, ambiguous };
}

export async function holdOldSequences({ oldDb, execute = false }) {
	const running = await oldDb.collection("sequences").find({ status: "active" }).project({ _id: 1, status: 1 }).toArray();
	if (execute && running.length) {
		await oldDb.collection("maiteam_rollback").updateOne({ _id: ROLLBACK_ID }, { $setOnInsert: { heldAt: new Date(), sequences: running } }, { upsert: true });
		await oldDb.collection("sequences").updateMany({ _id: { $in: running.map(({ _id }) => _id) }, status: "active" }, { $set: { status: "paused", pauseReason: HOLD_REASON } });
	}
	return { mode: execute ? "execute" : "plan", sequencesHeld: running.length };
}

// `since` defaults to the dump time in the new database's cutover record: everything the new server did from the hold on,
// clicks during the hold included, goes back. Documents the old server already has merge to no change.
export async function replay({ newDb, oldDb, since, execute = false, maxPasses = 10 }) {
	const cutover = await newDb.collection("maiteam_cutover").findOne({ _id: "fork-cutover" });
	const at = new Date(since ?? cutover?.since ?? NaN);
	if (!Number.isFinite(at.getTime())) throw new Error("No cutover record: pass --since, the time the dump began, as an ISO date");
	if (cutover?.since && at > new Date(cutover.since)) throw new Error("--since is after the dump: the hold's clicks would stay behind");
	const report = { mode: execute ? "execute" : "plan", since: at.toISOString(), problems: [] };
	// A reader who signed up on the old server meanwhile, with the same address, is one contact: the old id stays.
	const contactIds = new Map();
	const oldContactId = (value) => (value ? (contactIds.get(String(value)) ?? value) : value);

	const pass = async () => {
		const counts = {};
		let writes = 0;
		let ambiguousSteps = 0;
		const write = async (name, doc, merge, filter) => {
			try {
				const changed = await upsertMerged({ collection: oldDb.collection(name), doc, merge, execute, filter });
				counts[name] = (counts[name] ?? 0) + changed;
				writes += changed;
			} catch (error) {
				if (error?.code !== 11000) throw error;
				report.problems.push(`${name}: collides with a document the old server wrote`);
			}
		};

		for (const doc of await changedSince(newDb.collection("suppressions"), "suppressions", at)) {
			const { _id, accountId, reason, ...rest } = doc;
			// The old list is one per server, unique by address; its reasons have no "provider".
			const incoming = { ...rest, _id, reason: reason === "provider" ? "manual" : reason };
			await write("suppressions", incoming, (current) => (incoming.reason === "complaint" && current.reason !== "complaint" ? { ...current, reason: "complaint", detail: incoming.detail } : current), { email: doc.email });
		}
		for (const doc of await changedSince(newDb.collection("contacts"), "contacts", at)) {
			const incoming = strip(doc);
			const byAddress = await oldDb.collection("contacts").findOne({ newsletterId: doc.newsletterId, email: doc.email });
			if (byAddress && String(byAddress._id) !== String(doc._id)) contactIds.set(String(doc._id), byAddress._id);
			await write("contacts", { ...incoming, _id: byAddress?._id ?? doc._id }, mergeContact, { _id: byAddress?._id ?? doc._id });
		}
		for (const doc of await changedSince(newDb.collection("sequences"), "sequences", at)) {
			const incoming = { ...strip(doc), steps: (doc.steps ?? []).map((step) => toOldLook(step)) };
			// A sequence the old server has keeps its own status: the hold, or whatever its owner set.
			await write("sequences", incoming, (current) => current);
		}
		for (const doc of await changedSince(newDb.collection("campaigns"), "campaigns", at)) {
			await write("campaigns", toOldLook(strip(doc)), (current, incoming) => (new Date(incoming.updatedAt) > new Date(current.updatedAt ?? 0) ? incoming : current));
		}
		for (const doc of await changedSince(newDb.collection("enrollments"), "enrollments", at)) {
			const { steps, ambiguous } = mapStepsForOldResume(doc.steps);
			if (ambiguous) ambiguousSteps += 1;
			const incoming = { ...strip(doc), contactId: oldContactId(doc.contactId), steps };
			const existing = await oldDb.collection("enrollments").findOne({ sequenceId: doc.sequenceId, contactId: incoming.contactId });
			// Only the new server's steps are mapped: a step the old server left queued keeps its own email there.
			await write("enrollments", { ...incoming, _id: existing?._id ?? doc._id }, mergeEnrollment, { _id: existing?._id ?? doc._id });
		}
		let unsent = 0;
		for (const doc of await changedSince(newDb.collection("messages"), "messages", at)) {
			if (unsentSequenceEmail(doc)) {
				// Its step went back to held: the old server writes that email itself when it sends the step.
				unsent += 1;
				if (execute) await oldDb.collection("messages").deleteOne({ _id: doc._id, sentAt: null });
				continue;
			}
			await write("messages", { ...toOldMessage(doc), contactId: oldContactId(doc.contactId) }, mergeMessage);
		}
		for (const doc of await changedSince(newDb.collection("events"), "events", at)) await write("events", toOldEvent(doc), (current) => current);
		for (const doc of await newDb.collection("newsletter_daily_caps").find({}).toArray()) await write("newsletter_daily_caps", doc, mergeCap);
		counts.unsentSequenceEmails = unsent;
		return { writes, counts, ambiguousSteps };
	};

	const { converged, passes } = await converge({ pass, execute, maxPasses });
	Object.assign(report, { converged, passes, ambiguousSteps: passes.at(-1).ambiguousSteps });
	report.checks = await verifyReplay({ newDb, oldDb, since: at, contactIds });
	return report;
}

// What must hold on the old database after the passes.
export async function verifyReplay({ newDb, oldDb, since, contactIds = new Map() }) {
	const checks = {};
	const mapId = (value) => contactIds.get(String(value)) ?? value;
	const oldSuppressed = new Set((await oldDb.collection("suppressions").find({}).project({ email: 1 }).toArray()).map(({ email }) => email));
	checks["suppressions:every-address-suppressed"] = (await changedSince(newDb.collection("suppressions"), "suppressions", since)).every(({ email }) => oldSuppressed.has(email));
	const left = await newDb.collection("contacts").find({ status: { $in: LEFT } }).project({ _id: 1 }).toArray();
	const leftOld = await oldDb.collection("contacts").find({ _id: { $in: left.map(({ _id }) => mapId(_id)) }, status: { $in: LEFT } }).project({ _id: 1 }).toArray();
	checks["contacts:left-stay-left"] = leftOld.length === new Set(left.map(({ _id }) => String(mapId(_id)))).size;
	const newContacts = await changedSince(newDb.collection("contacts"), "contacts", since);
	const presentContacts = new Set((await oldDb.collection("contacts").find({ _id: { $in: newContacts.map(({ _id }) => mapId(_id)) } }).project({ _id: 1 }).toArray()).map(({ _id }) => String(_id)));
	checks["contacts:all-present"] = newContacts.every(({ _id }) => presentContacts.has(String(mapId(_id))));
	const sent = (await changedSince(newDb.collection("messages"), "messages", since)).filter(({ sentAt }) => sentAt);
	const oldSent = new Map((await oldDb.collection("messages").find({ _id: { $in: sent.map(({ _id }) => _id) } }).toArray()).map((doc) => [String(doc._id), doc]));
	checks["messages:sent-stay-sent"] = sent.every(({ _id, providerMessageId }) => oldSent.get(String(_id))?.sentAt && (!providerMessageId || oldSent.get(String(_id)).sesMessageId === providerMessageId));
	const finished = (steps = []) => steps.filter(({ status }) => FINISHED.includes(status)).map(({ position }) => position);
	const enrollments = await changedSince(newDb.collection("enrollments"), "enrollments", since);
	let finishedKept = true;
	for (const doc of enrollments) {
		const old = await oldDb.collection("enrollments").findOne({ sequenceId: doc.sequenceId, contactId: mapId(doc.contactId) });
		if (!old || !finished(doc.steps).every((position) => finished(old.steps).includes(position))) finishedKept = false;
	}
	checks["enrollments:finished-steps-stay-finished"] = finishedKept;
	checks.ok = Object.values(checks).every(Boolean);
	return checks;
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
	const argv = process.argv.slice(2);
	const since = argv.includes("--since") ? argv[argv.indexOf("--since") + 1] : undefined;
	const { ROLLBACK_NEW_URI: newUri, ROLLBACK_OLD_URI: oldUri } = process.env;
	if (!newUri || !oldUri || newUri === oldUri) throw new Error("Set ROLLBACK_NEW_URI and ROLLBACK_OLD_URI to two different databases");
	const [newClient, oldClient] = await Promise.all([new mongoose.mongo.MongoClient(newUri).connect(), new mongoose.mongo.MongoClient(oldUri).connect()]);
	try {
		const execute = argv.includes("--execute");
		const report = argv.includes("--hold") ? await holdOldSequences({ oldDb: oldClient.db(), execute }) : await replay({ newDb: newClient.db(), oldDb: oldClient.db(), since, execute });
		console.log(JSON.stringify(report, null, 2));
		if (report.checks) process.exitCode = report.converged && report.checks.ok ? 0 : 1;
	} finally {
		await Promise.all([newClient.close(), oldClient.close()]);
	}
}
