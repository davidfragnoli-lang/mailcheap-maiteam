// P8d (PATCHES.md): the final catch-up of the cutover. The migration copied the old database as it was when the dump
// began, and left the new one in the hold (lib/maiteam/cutover.js). Once mailcheap.maiteam.ch serves the new
// deployment and the old one has drained, this copies everything the old server wrote since the dump: signups,
// confirmations, unsubscribes, suppressions, SES events, emails and sequence progress. It applies the clicks the new
// server recorded during the hold for contacts it didn't have yet. It repeats until a pass changes nothing.
//
//   CATCHUP_SOURCE_URI=<old, read-only> CATCHUP_TARGET_URI=<new> node scripts/maiteam/catch-up.mjs [--execute] [--release]
//
// --release ends the hold only after a pass changed nothing, every check holds and no recorded click is left
// unresolved: the account is unblocked and the report lists the sequences to Resume in the dashboard. Resume publishes
// each enrollment's earliest unresolved step again (lib/maiteam/sequence-store.js startSequence), so jobs the old
// server published and the new one acknowledged during the hold are rebuilt, once. The report holds counts only.

import mongoose from "mongoose";
import { CUTOVER_ID, HOLD_REASON, converters } from "./migrate-from-fork.mjs";
import { CANCELLED_BEFORE_HANDOFF, LEFT, changedSince, converge, mergeCap, mergeContact, mergeEnrollment, mergeMessage, upsertMerged } from "./fork-sync.mjs";
import { checkRelationships } from "./integrity.mjs";

const OPEN_ENROLLMENT_STEPS = ["pending", "scheduled", "held", "claimed", "sending"];
export const RESUME_REASON = "Cutover done. Resume starts it again where each contact left off.";

function mergeFor(name) {
	switch (name) {
		case "contacts":
			return mergeContact;
		case "enrollments":
			return mergeEnrollment;
		case "messages":
			return mergeMessage;
		case "newsletter_daily_caps":
			return mergeCap;
		case "events":
			return (current) => current;
		// The hold keeps every sequence paused: only what was edited comes over.
		case "sequences":
			return (current, incoming) => {
				const base = time(incoming.updatedAt) > time(current.updatedAt) ? { ...incoming } : { ...current };
				return { ...base, status: current.status, pauseReason: current.pauseReason };
			};
		// The new server reconciles its own ledger from SES. The old one's sends not yet absorbed are added to it, with no
		// time (lib/maiteam/send-quota.js: only a rising count absorbs them).
		case "ses_quota_holds":
			return (current, incoming) => {
				const held = Array.isArray(current.issuedLog) ? current.issuedLog.reduce((sum, entry) => sum + (entry.amount ?? 0), 0) : (current.issued ?? 0);
				const extra = (incoming.issued ?? 0) - held;
				if (extra <= 0) return current;
				const next = { ...current, issued: held + extra, reserved: (current.reserved ?? 0) + extra, revision: (current.revision ?? 0) + 1 };
				if (Array.isArray(current.issuedLog)) next.issuedLog = [...current.issuedLog, { at: null, amount: extra }];
				return next;
			};
		case "sender_warmups":
			return (current, incoming) => ((incoming.revision ?? 0) > (current.revision ?? 0) ? { ...incoming, revision: incoming.revision + 1 } : current);
		default:
			return (current, incoming) => (time(incoming.updatedAt) > time(current.updatedAt) ? incoming : current);
	}
}

const time = (value) => (value ? new Date(value).getTime() || 0 : 0);

// A click recorded during the hold, applied as the new server would have.
async function applyPending({ targetDb, action, execute }) {
	const contacts = targetDb.collection("contacts");
	const contact = await contacts.findOne({ _id: action.contactId, newsletterId: action.newsletterId });
	if (!contact) return { writes: 0, unresolved: 1 };
	if (!execute) return { writes: 1, unresolved: 0 };
	const at = action.at ?? new Date();
	if (action.kind === "unsubscribe" && ["active", "dormant", "pending"].includes(contact.status)) {
		await contacts.updateOne({ _id: contact._id }, { $set: { status: "unsubscribed", unsubscribedAt: at, updatedAt: new Date() } });
		await cancelEnrollments({ targetDb, contactId: contact._id });
	}
	if (action.kind === "confirm" && contact.status === "pending") {
		await contacts.updateOne({ _id: contact._id }, { $set: { status: "active", confirmedAt: at, updatedAt: new Date() } });
		for (const enrollment of await targetDb.collection("enrollments").find({ contactId: contact._id, status: "awaiting_confirmation" }).toArray()) {
			await targetDb.collection("enrollments").updateOne(
				{ _id: enrollment._id, status: "awaiting_confirmation" },
				{ $set: { status: "active", enrolledAt: at, steps: enrollment.steps.map(({ position }) => ({ position, status: "held" })), updatedAt: new Date() }, $inc: { __v: 1 } }
			);
		}
	}
	if (action.kind === "keep" && contact.status === "dormant") {
		await contacts.updateOne({ _id: contact._id }, { $set: { status: "active", updatedAt: new Date() } });
	}
	await targetDb.collection("maiteam_cutover_pending").updateOne({ _id: action._id }, { $set: { appliedAt: new Date() } });
	return { writes: 1, unresolved: 0 };
}

async function cancelEnrollments({ targetDb, contactId }) {
	const enrollments = targetDb.collection("enrollments");
	for (const enrollment of await enrollments.find({ contactId, status: { $in: ["awaiting_confirmation", "active"] } }).toArray()) {
		const steps = enrollment.steps.map((step) => (OPEN_ENROLLMENT_STEPS.includes(step.status) ? { ...step, status: "cancelled" } : step));
		await enrollments.updateOne({ _id: enrollment._id, __v: enrollment.__v }, { $set: { status: "cancelled", steps, updatedAt: new Date() }, $inc: { __v: 1 } });
		await targetDb.collection("messages").updateMany({ enrollmentId: enrollment._id, status: "queued" }, { $set: { status: "skipped", error: CANCELLED_BEFORE_HANDOFF } });
	}
}

export async function catchUp({ sourceDb, targetDb, execute = false, release = false, maxPasses = 10, quietMs, now = new Date() }) {
	const cutover = await targetDb.collection("maiteam_cutover").findOne({ _id: CUTOVER_ID });
	if (!cutover) throw new Error("The target has no cutover record: run scripts/maiteam/migrate-from-fork.mjs first");
	if (cutover.state !== "holding") throw new Error(`The cutover is ${cutover.state}: a catch-up now would overwrite the new server's own writes`);
	const since = new Date(cutover.since);
	const accountId = cutover.accountId;
	const plan = converters({ accountId });
	const sourceNames = new Set((await sourceDb.listCollections().toArray()).map(({ name }) => name));
	const report = { mode: execute ? "execute" : "plan", since: since.toISOString(), at: now.toISOString(), problems: [] };
	const heldSequences = new Map((cutover.sequences ?? []).map((item) => [String(item._id), item]));

	const pass = async () => {
		const counts = {};
		let writes = 0;
		for (const [name, { to, convert }] of Object.entries(plan)) {
			if (!sourceNames.has(name)) continue;
			const docs = await changedSince(sourceDb.collection(name), name, since);
			let changed = 0;
			for (const doc of docs) {
				const converted = convert(doc);
				// An old suppression is one per address; upstream's, one per account and address.
				const filter = name === "suppressions" ? { accountId, email: converted.email } : { _id: converted._id };
				const merge =
					name === "suppressions"
						? (current, incoming) => (incoming.reason === "complaint" && current.reason !== "complaint" ? { ...current, reason: "complaint", detail: incoming.detail } : current)
						: mergeFor(name);
				try {
					changed += await upsertMerged({ collection: targetDb.collection(to), doc: converted, merge, execute, filter });
				} catch (error) {
					if (error?.code !== 11000) throw error;
					report.problems.push(`${name}: a document collides with one the new server wrote (unique index ${Object.keys(error.keyPattern ?? {}).join(",")})`);
				}
				if (name === "sequences") {
					const held = heldSequences.get(String(doc._id));
					if (!held || held.status !== doc.status) heldSequences.set(String(doc._id), { _id: doc._id, status: doc.status, pauseReason: doc.pauseReason ?? null });
				}
			}
			counts[name] = { changedOnOld: docs.length, written: changed };
			writes += changed;
		}
		// The old server deletes a sequence email it never handed off. The copy here goes the same way.
		const oldMessages = sourceDb.collection("messages");
		let deleted = 0;
		for (const message of await targetDb.collection("messages").find({ migratedFromFork: true, status: "queued", sentAt: null }).toArray()) {
			if (await oldMessages.findOne({ _id: message._id }, { projection: { _id: 1 } })) continue;
			deleted += 1;
			if (execute) await targetDb.collection("messages").deleteOne({ _id: message._id, status: "queued" });
		}
		counts.messagesDeletedOnOld = deleted;
		writes += deleted;
		let unresolved = 0;
		let applied = 0;
		for (const action of await targetDb.collection("maiteam_cutover_pending").find({ appliedAt: null }).toArray()) {
			const result = await applyPending({ targetDb, action, execute });
			applied += result.writes;
			unresolved += result.unresolved;
		}
		counts.recordedClicks = { applied, unresolved };
		writes += applied;
		if (execute) await targetDb.collection("maiteam_cutover").updateOne({ _id: CUTOVER_ID }, { $push: { passes: { at: new Date(), writes } }, $set: { sequences: [...heldSequences.values()] } });
		return { writes, unresolved, counts };
	};

	const { converged, passes } = await converge({ pass, execute, maxPasses, source: sourceDb, quietMs });
	report.converged = converged;
	report.passes = passes;
	report.checks = await verifyCatchUp({ sourceDb, targetDb, since, accountId });
	const last = passes.at(-1);
	report.unresolvedClicks = last.unresolved;

	if (release) {
		const ready = execute && converged && report.checks.ok && last.unresolved === 0 && report.problems.length === 0;
		if (!ready) throw Object.assign(new Error("Not released: the catch-up has not converged cleanly"), { report });
		await targetDb.collection("accounts").updateOne({ _id: accountId, pauseReason: HOLD_REASON }, { $set: { status: "active", updatedAt: new Date() }, $unset: { pausedAt: 1, pauseReason: 1, pausedBy: 1 } });
		const toResume = [...heldSequences.values()].filter(({ status }) => status === "active").map(({ _id }) => _id);
		await targetDb.collection("sequences").updateMany({ _id: { $in: toResume }, status: "paused", pauseReason: HOLD_REASON }, { $set: { pauseReason: RESUME_REASON } });
		await targetDb.collection("maiteam_cutover").updateOne({ _id: CUTOVER_ID }, { $set: { state: "released", releasedAt: new Date() } });
		report.released = { sequencesToResume: toResume.map(String) };
	}
	return report;
}

// What must hold after the passes: every change on the old side is here, by the merge rules.
export async function verifyCatchUp({ sourceDb, targetDb, since, accountId }) {
	const checks = {};
	const targetIds = async (name, ids) => new Set((await targetDb.collection(name).find({ _id: { $in: ids } }, { projection: { _id: 1 } }).toArray()).map(({ _id }) => String(_id)));
	for (const name of ["contacts", "enrollments", "events", "campaigns", "sequences"]) {
		const docs = await changedSince(sourceDb.collection(name), name, since);
		const present = await targetIds(name, docs.map(({ _id }) => _id));
		checks[`${name}:all-present`] = docs.every(({ _id }) => present.has(String(_id)));
	}
	const oldMessages = await changedSince(sourceDb.collection("messages"), "messages", since);
	const presentMessages = await targetIds("messages", oldMessages.map(({ _id }) => _id));
	checks["messages:all-present"] = oldMessages.every(({ _id }) => presentMessages.has(String(_id)));
	const sentOnOld = oldMessages.filter(({ sentAt }) => sentAt);
	const targetSent = new Map((await targetDb.collection("messages").find({ _id: { $in: sentOnOld.map(({ _id }) => _id) } }).toArray()).map((doc) => [String(doc._id), doc]));
	checks["messages:sent-stay-sent"] = sentOnOld.every(({ _id, sesMessageId }) => targetSent.get(String(_id))?.sentAt && (!sesMessageId || targetSent.get(String(_id)).providerMessageId === sesMessageId));
	const suppressed = new Set((await targetDb.collection("suppressions").find({ accountId }).project({ email: 1 }).toArray()).map(({ email }) => email));
	checks["suppressions:every-address-suppressed"] = (await sourceDb.collection("suppressions").find({}).project({ email: 1 }).toArray()).every(({ email }) => suppressed.has(email));
	const left = await sourceDb.collection("contacts").find({ status: { $in: LEFT } }).project({ _id: 1 }).toArray();
	const leftHere = await targetDb.collection("contacts").find({ _id: { $in: left.map(({ _id }) => _id) }, status: { $in: LEFT } }).project({ _id: 1 }).toArray();
	checks["contacts:left-stay-left"] = leftHere.length === left.length;
	const doneSteps = (enrollment) => enrollment.steps.filter(({ status }) => ["sent", "skipped", "failed", "cancelled"].includes(status)).map(({ position }) => position);
	const oldEnrollments = await sourceDb.collection("enrollments").find({}).toArray();
	const newEnrollments = new Map((await targetDb.collection("enrollments").find({ _id: { $in: oldEnrollments.map(({ _id }) => _id) } }).toArray()).map((doc) => [String(doc._id), doc]));
	checks["enrollments:finished-steps-stay-finished"] = oldEnrollments.every((doc) => {
		const here = newEnrollments.get(String(doc._id));
		return here && doneSteps(doc).every((position) => doneSteps(here).includes(position));
	});
	const collections = {};
	for (const name of ["newsletters", "contacts", "campaigns", "sequences", "enrollments", "messages", "events"]) collections[name] = await targetDb.collection(name).find({}).toArray();
	checks["relationships:hard"] = checkRelationships(collections).ok;
	checks.ok = Object.values(checks).every(Boolean);
	return checks;
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
	const argv = process.argv.slice(2);
	const { CATCHUP_SOURCE_URI: sourceUri, CATCHUP_TARGET_URI: targetUri } = process.env;
	if (!sourceUri || !targetUri || sourceUri === targetUri) throw new Error("Set CATCHUP_SOURCE_URI and CATCHUP_TARGET_URI to two different databases");
	const [source, target] = await Promise.all([new mongoose.mongo.MongoClient(sourceUri, { readPreference: "secondaryPreferred" }).connect(), new mongoose.mongo.MongoClient(targetUri).connect()]);
	try {
		const report = await catchUp({ sourceDb: source.db(), targetDb: target.db(), execute: argv.includes("--execute"), release: argv.includes("--release") }).catch((error) => {
			if (error.report) process.stdout.write(`${JSON.stringify(error.report, null, 2)}\n`);
			throw error;
		});
		process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
		process.exitCode = report.converged && report.checks.ok ? 0 : 1;
	} finally {
		await Promise.all([source.close(), target.close()]);
	}
}
