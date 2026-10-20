// P8 (PATCHES.md): what the migration, the catch-up, the rollback and the restore proof compare. Everything here
// returns counts and hashes; no address or content leaves it.

import crypto from "node:crypto";

// A document as plain, key-sorted JSON: ids, dates and other BSON values keep their type, so a changed field, a
// changed type or a missing field all change the hash.
export function canonical(value) {
	if (value instanceof Date) return { $date: Number.isFinite(value.getTime()) ? value.toISOString() : "invalid" };
	if (value && typeof value === "object" && value._bsontype) {
		if (value._bsontype === "ObjectId" || value._bsontype === "ObjectID") return { $oid: value.toHexString() };
		return { [`$${value._bsontype}`]: String(value) };
	}
	if (Array.isArray(value)) return value.map(canonical);
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.keys(value)
				.filter((key) => value[key] !== undefined)
				.sort()
				.map((key) => [key, canonical(value[key])])
		);
	}
	return value;
}

export const sha256 = (text) => crypto.createHash("sha256").update(text).digest("hex");
export const documentHash = (doc) => sha256(JSON.stringify(canonical(doc)));
export const idSetHash = (values) => sha256(values.map(String).sort().join("\n"));

// One collection's content: count, a hash over every document's own hash (sorted by id), and the documents that differ
// from an expected set, by id only.
export function contentDigest(docs) {
	const byId = new Map(docs.map((doc) => [JSON.stringify(canonical(doc._id)), documentHash(doc)]));
	const lines = [...byId.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([key, hash]) => `${key} ${hash}`);
	return { count: docs.length, content: sha256(lines.join("\n")), byId };
}

export function compareContent(expectedDocs, actualDocs) {
	const expected = contentDigest(expectedDocs);
	const actual = contentDigest(actualDocs);
	let missing = 0;
	let changed = 0;
	for (const [key, hash] of expected.byId) {
		if (!actual.byId.has(key)) missing += 1;
		else if (actual.byId.get(key) !== hash) changed += 1;
	}
	const extra = [...actual.byId.keys()].filter((key) => !expected.byId.has(key)).length;
	return { same: missing === 0 && changed === 0 && extra === 0, expected: expected.count, actual: actual.count, missing, changed, extra };
}

// The indexes as MongoDB holds them, without the server's own version field.
export async function indexSpecs(collection) {
	const indexes = await collection.indexes().catch(() => []);
	return indexes
		.map(({ v, ns, background, ...spec }) => canonical(spec))
		.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

const idOf = (value) => (value === undefined || value === null ? null : String(value));

// The references a migrated database must hold. Hard ones stop the migration; soft ones (an email whose contact or
// campaign was deleted since, an event whose message was) are counted for the operator.
export function checkRelationships(collections) {
	const ids = (name) => new Set((collections[name] ?? []).map(({ _id }) => String(_id)));
	const newsletters = ids("newsletters");
	const contacts = ids("contacts");
	const sequences = ids("sequences");
	const enrollments = ids("enrollments");
	const campaigns = ids("campaigns");
	const messages = ids("messages");
	const hard = {};
	const soft = {};
	const count = (bucket, key, docs, test) => {
		const broken = docs.filter(test).length;
		if (broken) bucket[key] = broken;
	};
	const missingIn = (set, value) => idOf(value) !== null && !set.has(idOf(value));
	const requiredIn = (set, value) => idOf(value) === null || !set.has(idOf(value));
	count(hard, "contacts.newsletterId", collections.contacts ?? [], (doc) => requiredIn(newsletters, doc.newsletterId));
	count(hard, "campaigns.newsletterId", collections.campaigns ?? [], (doc) => requiredIn(newsletters, doc.newsletterId));
	count(hard, "sequences.newsletterId", collections.sequences ?? [], (doc) => requiredIn(newsletters, doc.newsletterId));
	for (const key of ["newsletterId", "sequenceId", "contactId"]) {
		const set = { newsletterId: newsletters, sequenceId: sequences, contactId: contacts }[key];
		count(hard, `enrollments.${key}`, collections.enrollments ?? [], (doc) => requiredIn(set, doc[key]));
	}
	count(hard, "enrollments.steps.messageId", collections.enrollments ?? [], (doc) => (doc.steps ?? []).some((step) => missingIn(messages, step.messageId)));
	count(hard, "messages.newsletterId", collections.messages ?? [], (doc) => requiredIn(newsletters, doc.newsletterId));
	const sequenceMessages = (collections.messages ?? []).filter(({ kind }) => kind === "sequence");
	count(hard, "messages.sequenceId", sequenceMessages, (doc) => requiredIn(sequences, doc.sequenceId));
	count(hard, "messages.enrollmentId", sequenceMessages, (doc) => requiredIn(enrollments, doc.enrollmentId));
	count(soft, "messages.contactId", collections.messages ?? [], (doc) => missingIn(contacts, doc.contactId));
	count(soft, "messages.campaignId", collections.messages ?? [], (doc) => missingIn(campaigns, doc.campaignId));
	count(soft, "events.messageId", collections.events ?? [], (doc) => missingIn(messages, doc.messageId));
	return { ok: Object.keys(hard).length === 0, hard, soft };
}
