// P8d (PATCHES.md): the merge both directions of the cutover use. scripts/maiteam/catch-up.mjs brings what the old
// server wrote after its dump into the new database; scripts/maiteam/rollback-replay.mjs carries what the new server
// wrote after the cutover back to the old one. Both run while the other side takes no writes (the hold, or the alias
// moved back and drained), pass after pass until a pass changes nothing, and a lost race only means one more pass.
//
// Merge rules, the same both ways. Nothing a reader did is undone, and nothing already sent can be sent again:
// - a contact who left (unsubscribed, bounced, complained) stays left; a confirmed one stays confirmed;
// - a sequence step only moves forward (pending → … → sent/skipped/failed/cancelled), and so does its enrollment;
// - an email with a send time or a provider id keeps them;
// - a suppression is added, never removed; a complaint outranks a bounce or a manual entry;
// - an event is added once, by its id;
// - otherwise the newer document (updatedAt) wins.

import mongoose from "mongoose";
import { canonical } from "./integrity.mjs";

export const LEFT = ["unsubscribed", "bounced", "complained"];
export const TIMESTAMPED = ["newsletters", "contacts", "campaigns", "messages", "events", "suppressions", "apikeys", "sequences", "enrollments", "alerts"];
export const CANCELLED_BEFORE_HANDOFF = "Cancelled before the provider call";
export const OPEN_STEP = ["pending", "scheduled", "held"];
const STEP_RANK = { pending: 0, held: 1, scheduled: 2, claimed: 3, sending: 4, "in-flight": 5, sent: 6, skipped: 6, failed: 6, cancelled: 6 };
const ENROLLMENT_RANK = { awaiting_confirmation: 0, active: 1, completed: 2, cancelled: 2 };

const time = (value) => (value ? new Date(value).getTime() || 0 : 0);
const newer = (a, b) => (time(b?.updatedAt) > time(a?.updatedAt) ? b : a);
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

export function mergeContactStatus(current, incoming) {
	if (LEFT.includes(current)) return current;
	if (LEFT.includes(incoming)) return incoming;
	if (current === "pending" && incoming !== "pending") return incoming;
	if (incoming === "pending") return current;
	return null;
}

export function mergeContact(current, incoming) {
	const base = { ...newer(current, incoming) };
	const status = mergeContactStatus(current.status, incoming.status);
	if (status) base.status = status;
	for (const field of ["confirmedAt", "unsubscribedAt"]) {
		const value = current[field] ?? incoming[field];
		if (value !== undefined) base[field] = value;
	}
	return base;
}

export function mergeSteps(current = [], incoming = []) {
	const byPosition = new Map(current.map((step) => [step.position, step]));
	for (const step of incoming) {
		const held = byPosition.get(step.position);
		if (!held || (STEP_RANK[step.status] ?? -1) > (STEP_RANK[held.status] ?? -1)) byPosition.set(step.position, step);
	}
	return [...byPosition.values()].sort((a, b) => a.position - b.position);
}

export function mergeEnrollment(current, incoming) {
	const base = { ...newer(current, incoming) };
	const rank = (status) => ENROLLMENT_RANK[status] ?? -1;
	base.status = rank(incoming.status) > rank(current.status) ? incoming.status : current.status;
	base.steps = mergeSteps(current.steps, incoming.steps);
	return base;
}

export function mergeMessage(current, incoming) {
	const base = { ...newer(current, incoming) };
	const sent = current.sentAt ? current : incoming.sentAt ? incoming : null;
	if (sent && !base.sentAt) Object.assign(base, { sentAt: sent.sentAt, status: sent.status });
	for (const field of ["providerMessageId", "sesMessageId"]) {
		const value = current[field] ?? incoming[field];
		if (value !== undefined && value !== null) base[field] = value;
	}
	return base;
}

// A ledger counts what was handed to the provider: the higher count is the true one.
// The revision moves with it, so a compare-and-swap that read the old count writes nothing.
export function mergeCap(current, incoming) {
	if ((incoming.issued ?? 0) <= (current.issued ?? 0)) return current;
	return { ...current, issued: incoming.issued, revision: Math.max(current.revision ?? 0, incoming.revision ?? 0) + 1 };
}

export const MERGE_ATTEMPTS = 20;

// Writes one document by the rules, unless the result is what the target already holds. Returns 1 for a write.
// The side written to still takes writes of its own while this runs (a reader's click during the hold, a late provider
// event), so the write is a compare-and-swap: it replaces the document only if it is still exactly the one merged. One
// changed in between is read again and merged again, the reader's change included. An insert that lost to the same
// document arriving meanwhile is merged the same way.
export async function upsertMerged({ collection, doc, merge, execute, filter = { _id: doc._id } }) {
	for (let attempt = 0; attempt < MERGE_ATTEMPTS; attempt += 1) {
		const current = await collection.findOne(filter);
		if (!current) {
			if (!execute) return 1;
			try {
				await collection.insertOne(doc);
				return 1;
			} catch (error) {
				// A duplicate of this very document (by the filter) is a race to merge; any other is a real collision.
				if (error?.code !== 11000 || !(await collection.findOne(filter))) throw error;
				continue;
			}
		}
		const merged = merge ? merge(current, doc) : current;
		if (same(merged, current)) return 0;
		if (!execute) return 1;
		const { matchedCount } = await collection.replaceOne(
			{ _id: current._id, $expr: { $eq: ["$$ROOT", { $literal: current }] } },
			{ ...merged, _id: current._id }
		);
		if (matchedCount === 1) return 1;
	}
	throw new Error(`${collection.collectionName}: a document kept changing during the merge (${MERGE_ATTEMPTS} attempts); nothing was overwritten`);
}

// What a side wrote at or after `since`: by its timestamps, or by its id's creation time for a document written
// without them.
// An id holds whole seconds: rounded down, the copy can only take a document more; rounded up, the quiet check
// below can only miss one written without timestamps in that same second.
export function changedFilter(since, round = Math.floor) {
	const at = new Date(since);
	return { $or: [{ updatedAt: { $gte: at } }, { createdAt: { $gte: at } }, { _id: { $gte: mongoose.Types.ObjectId.createFromTime(round(at.getTime() / 1000)) } }] };
}

export function changedSince(collection, name, since) {
	if (!TIMESTAMPED.includes(name)) return collection.find({}).toArray();
	return collection.find(changedFilter(since)).toArray();
}

// How many documents the source side wrote since `start`: a pass that changed nothing still doesn't count while the
// source kept writing during it.
export async function writtenSince(db, start) {
	let count = 0;
	for (const name of TIMESTAMPED) count += await db.collection(name).countDocuments(changedFilter(start, Math.ceil));
	return count;
}

// Pass after pass, until one changes nothing and the source wrote nothing while it ran. Without execute, one counting
// pass. `quietMs` reaches back before each pass's start, for clocks a little apart.
export async function converge({ pass, execute, maxPasses = 10, source = null, quietMs = 2_000 }) {
	const passes = [];
	for (let index = 0; index < (execute ? maxPasses : 1); index += 1) {
		const start = new Date(Date.now() - quietMs);
		const result = await pass(index);
		const sourceWrites = source ? await writtenSince(source, start) : 0;
		passes.push({ ...result, sourceWrites });
		if (result.writes === 0 && sourceWrites === 0) return { converged: true, passes };
		if (result.writes === 0) await new Promise((resolve) => setTimeout(resolve, quietMs));
	}
	return { converged: false, passes };
}
