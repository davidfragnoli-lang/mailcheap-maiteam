// P8 (PATCHES.md): one-time move of the old single-admin fork's MongoDB data into upstream's multi-account shape.
//
//   MIGRATE_SOURCE_URI=… MIGRATE_TARGET_URI=… node scripts/maiteam/migrate-from-fork.mjs \
//     --owner-email <email> --mail-from <host> --archive-host <host> --dumped-at <ISO time> [--execute] [--report <file>]
//
// The URIs come from the environment only, so they never appear in argv or logs. The source is only ever read. The
// target must be an empty database: the script refuses one that holds any document. Without --execute it plans and
// validates every converted document against upstream's own models and writes nothing.
//
// Every _id is kept: unsubscribe and confirmation tokens embed contact and newsletter ids, tracking links embed message
// ids, and the ledgers embed newsletter ids. Links in emails already sent keep working only if the new server's
// BETTER_AUTH_SECRET is the old SESSION_SECRET (same HKDF info and payload on both sides).
//
// The report holds counts, histograms and hashes of id sets only: no address, name or content.
//
// The new database starts in the cutover hold (P8d, lib/maiteam/cutover.js): the account is blocked with upstream's own
// block, every active sequence is paused, and maiteam_cutover records what each was. --dumped-at is when the dump
// began: scripts/maiteam/catch-up.mjs copies what the old server wrote from then on, and releases the hold.
// A campaign scheduled or sending refuses the migration: its jobs would reach the new server mid-send.

import fs from "node:fs";
import mongoose from "mongoose";
import { checkDumpStart } from "./dump-start.mjs";
import { checkRelationships, compareContent, idSetHash as sha } from "./integrity.mjs";

export const CUTOVER_ID = "fork-cutover";
export const HOLD_REASON = "Cutover from the old server: catching up. scripts/maiteam/catch-up.mjs --release ends it.";
const BUSY_CAMPAIGN_STATUSES = ["scheduled", "sending"];

// Old SES event names → upstream's (lib/ses-event-mapping.js EVENT_TYPES).
export const EVENT_TYPES = {
	Send: "sent",
	Delivery: "delivered",
	Bounce: "bounce",
	Complaint: "complaint",
	Open: "open",
	Click: "click",
	Reject: "dropped",
	RenderingFailure: "dropped",
	DeliveryDelay: "deferred",
};

// The old look's preset → the upstream preset for the newsletter's site and archive pages. The look itself is kept
// whole at theme.look (P3c), which the email renderer reads.
export function mapTheme(look) {
	if (!look || typeof look !== "object" || !look.preset) return undefined;
	const product = look.preset === "maiteam" ? look.product : null;
	const preset =
		look.preset === "landing"
			? "landing"
			: look.preset === "maiteam"
				? product === "fortuna" || product === "quote-to-invoice"
					? product
					: "maiteam"
				: "mailcheap";
	return { preset, look };
}


function histogram(docs, key) {
	const counts = {};
	for (const doc of docs) {
		const value = String(typeof key === "function" ? key(doc) : doc[key] ?? "(none)");
		counts[value] = (counts[value] ?? 0) + 1;
	}
	return counts;
}

function omit(doc, ...keys) {
	const copy = { ...doc };
	for (const key of keys) delete copy[key];
	return copy;
}

// One converter per old collection: the target collection and the document upstream stores.
export function converters({ accountId }) {
	const owned = (doc) => ({ ...doc, accountId });
	return {
		newsletters: {
			to: "newsletters",
			model: "Newsletter",
			convert: (doc) => {
				const theme = mapTheme(doc.theme);
				const out = owned(omit(doc, "theme"));
				if (theme) out.theme = theme;
				return out;
			},
		},
		contacts: { to: "contacts", model: "Contact", convert: owned },
		campaigns: {
			to: "campaigns",
			model: "Campaign",
			// The issue's own look moves to Campaign.look (P3c); none means the newsletter's.
			convert: (doc) => {
				const out = owned(omit(doc, "theme"));
				if (doc.theme) out.look = doc.theme;
				return out;
			},
		},
		messages: {
			to: "messages",
			model: "Message",
			convert: (doc) => {
				const out = owned(omit(doc, "sesMessageId"));
				if (doc.sesMessageId) out.providerMessageId = doc.sesMessageId;
				out.migratedFromFork = true;
				return out;
			},
		},
		events: {
			to: "events",
			model: "Event",
			convert: (doc) => {
				const out = owned(omit(doc, "sesMessageId"));
				if (doc.sesMessageId) out.providerMessageId = doc.sesMessageId;
				out.type = EVENT_TYPES[doc.type] ?? doc.type;
				return out;
			},
		},
		suppressions: { to: "suppressions", model: "Suppression", convert: owned },
		// The old fork's keys did everything the dashboard can: full access.
		apikeys: { to: "apikeys", model: "ApiKey", convert: (doc) => ({ ...owned(doc), level: doc.level ?? "full" }) },
		// Server-wide alerts.
		alerts: { to: "alerts", model: "Alert", convert: (doc) => ({ ...doc, accountId: null }) },
		// A step's own look moves from steps[].theme to steps[].look (P3c).
		sequences: {
			to: "sequences",
			model: "Sequence",
			convert: (doc) => ({
				...owned(doc),
				steps: (doc.steps ?? []).map(({ theme, ...step }) => (theme ? { ...step, look: theme } : step)),
			}),
		},
		enrollments: { to: "enrollments", model: "Enrollment", convert: owned },
		// maiteam's ledgers: same collections, the same documents (their ids embed newsletter ids).
		ses_quota_holds: { to: "ses_quota_holds", model: "SesQuota", convert: (doc) => doc },
		newsletter_daily_caps: { to: "newsletter_daily_caps", model: "NewsletterCap", convert: (doc) => doc },
		sender_warmups: { to: "sender_warmups", model: "SenderWarmup", convert: (doc) => doc },
	};
}

// Kept whole in migration_legacy, since upstream has no place for them: the spent bilingual demo ledger.
const LEGACY_ONLY = ["sequence_demo_ledger", "demoledgers"];

async function loadModels() {
	const names = ["Newsletter", "Contact", "Campaign", "Message", "Event", "Suppression", "ApiKey", "Alert", "SesQuota", "NewsletterCap", "SenderWarmup", "Account", "Domain", "Sequence", "Enrollment"];
	const models = {};
	for (const name of names) {
		try {
			models[name] = (await import(`../../models/${name}.js`)).default;
		} catch {
			models[name] = null;
		}
	}
	return models;
}

async function validate(Model, doc) {
	if (!Model) return null;
	try {
		await new Model(doc).validate();
		return null;
	} catch (error) {
		return error?.errors ? Object.values(error.errors).map((item) => `${item.path}: ${item.kind}`).join(", ") : String(error?.message ?? error);
	}
}

export async function migrateFork({ sourceDb, targetDb, owner, mailFrom, archiveHost, dumpedAt, execute = false, now = new Date() }) {
	if (!owner?.email) throw new Error("--owner-email is required");
	const since = new Date(dumpedAt ?? NaN);
	if (!Number.isFinite(since.getTime()) || since > now) throw new Error("--dumped-at must be the time the dump began, as an ISO date");
	const models = await loadModels();
	const report = { mode: execute ? "execute" : "plan", at: now.toISOString(), dumpedAt: since.toISOString(), collections: {}, created: {}, legacy: {}, problems: [], checks: {} };

	const targetCollections = await targetDb.listCollections().toArray();
	for (const { name } of targetCollections) {
		if ((await targetDb.collection(name).estimatedDocumentCount()) > 0) throw new Error(`The target database is not empty (${name}): migrate into a fresh one`);
	}

	const userId = new mongoose.Types.ObjectId();
	const accountId = new mongoose.Types.ObjectId();
	const email = String(owner.email).trim().toLowerCase();
	const user = { _id: userId, name: owner.name ?? email.split("@")[0], email, emailVerified: true, image: null, createdAt: now, updatedAt: now };
	// Blocked with upstream's own block until the catch-up releases it: no email goes out and no new signup is taken.
	const account = { _id: accountId, ownerId: userId, status: "paused", pausedAt: now, pauseReason: HOLD_REASON, pausedBy: "admin", createdAt: now, updatedAt: now };
	const problem = await validate(models.Account, account);
	if (problem) report.problems.push(`account: ${problem}`);

	const sourceNames = new Set((await sourceDb.listCollections().toArray()).map(({ name }) => name));
	const plan = converters({ accountId });
	const converted = {};
	const heldSequences = [];
	for (const [name, { to, model, convert }] of Object.entries(plan)) {
		if (!sourceNames.has(name)) continue;
		const docs = await sourceDb.collection(name).find({}).toArray();
		let out = docs.map(convert);
		// The hold: every sequence that was running waits for the release; what each was is kept for it.
		if (name === "sequences") {
			out = out.map((doc) => {
				heldSequences.push({ _id: doc._id, status: doc.status, pauseReason: doc.pauseReason ?? null });
				return doc.status === "active" ? { ...doc, status: "paused", pauseReason: HOLD_REASON } : doc;
			});
		}
		const Model = models[model];
		const invalid = [];
		for (const doc of out) {
			const error = await validate(Model, doc);
			if (error) invalid.push({ _id: String(doc._id), error });
		}
		if (!Model) report.problems.push(`${name}: upstream has no ${model} model on this branch, documents copied unvalidated`);
		for (const item of invalid.slice(0, 5)) report.problems.push(`${name} ${item._id}: ${item.error}`);
		if (invalid.length > 5) report.problems.push(`${name}: ${invalid.length - 5} more invalid documents`);
		converted[name] = { to, docs, out, Model };
		report.collections[name] = { to, source: docs.length, invalid: invalid.length, ids: sha(docs.map(({ _id }) => _id)) };
	}

	const busy = (converted.campaigns?.docs ?? []).filter(({ status }) => BUSY_CAMPAIGN_STATUSES.includes(status)).length;
	if (busy) report.problems.push(`campaigns: ${busy} scheduled or sending. Unschedule them, or let them finish, before the dump`);
	report.relationships = checkRelationships(Object.fromEntries(Object.entries(converted).map(([name, { out }]) => [name, out])));
	for (const [key, broken] of Object.entries(report.relationships.hard)) report.problems.push(`${key}: ${broken} documents point at nothing`);

	// The sending domains the newsletters use, as upstream's verified Domain documents (no new verification: "Check now"
	// re-reads SES). Adding the domain in the UI instead would rewrite its MAIL FROM.
	const domains = [...new Set((converted.newsletters?.out ?? []).map(({ fromEmail }) => String(fromEmail ?? "").split("@").pop().toLowerCase()).filter(Boolean))];
	const domainDocs = domains.map((domain) => ({
		_id: new mongoose.Types.ObjectId(),
		accountId,
		domain,
		mailFromDomain: mailFrom ?? `bounce.${domain}`,
		archiveHost: archiveHost ?? `news.${domain}`,
		archiveHostVerified: false,
		provider: "ses",
		verified: true,
		dkimStatus: "SUCCESS",
		mailFromStatus: "SUCCESS",
		createdAt: now,
		updatedAt: now,
	}));
	for (const doc of domainDocs) {
		const error = await validate(models.Domain, doc);
		if (error) report.problems.push(`domain ${doc.domain}: ${error}`);
	}
	report.created = { users: 1, accounts: 1, domains: domainDocs.length };

	const legacy = [];
	for (const name of LEGACY_ONLY) {
		if (!sourceNames.has(name)) continue;
		const docs = await sourceDb.collection(name).find({}).toArray();
		legacy.push(...docs.map((doc) => ({ _id: new mongoose.Types.ObjectId(), collection: name, document: doc })));
		report.legacy[name] = docs.length;
	}
	const unknown = [...sourceNames].filter((name) => !plan[name] && !LEGACY_ONLY.includes(name) && !name.startsWith("system."));
	for (const name of unknown) {
		const docs = await sourceDb.collection(name).find({}).toArray();
		legacy.push(...docs.map((doc) => ({ _id: new mongoose.Types.ObjectId(), collection: name, document: doc })));
		report.legacy[name] = docs.length;
		report.problems.push(`${name}: no converter, kept whole in migration_legacy`);
	}

	if (!execute) return report;
	if (report.problems.some((line) => !line.includes("copied unvalidated") && !line.includes("kept whole"))) {
		throw Object.assign(new Error("Validation problems: nothing was written"), { report });
	}

	// Upstream's indexes first, unique ones included, so a duplicate stops the copy instead of reaching the app.
	report.indexes = await createModelIndexes({ targetDb, models, collections: ["users", "accounts", "domains", ...Object.values(converted).map(({ to }) => to)] });
	await targetDb.collection("users").insertOne(user);
	await targetDb.collection("accounts").insertOne(account);
	if (domainDocs.length) await targetDb.collection("domains").insertMany(domainDocs);
	for (const [name, { to, out }] of Object.entries(converted)) {
		if (out.length) await targetDb.collection(to).insertMany(out, { ordered: true });
		report.collections[name].target = await targetDb.collection(to).countDocuments({});
	}
	if (legacy.length) await targetDb.collection("migration_legacy").insertMany(legacy);
	await targetDb.collection("maiteam_cutover").insertOne({ _id: CUTOVER_ID, state: "holding", accountId, since, migratedAt: now, sequences: heldSequences, passes: [] });
	const levels = models.ApiKey?.schema.path("level")?.enumValues ?? null;
	report.checks = await verify({ sourceDb, targetDb, converted, accountId, indexes: report.indexes, levels });
	report.accountId = String(accountId);
	return report;
}

// The indexes upstream's models declare, created on the target. Returns each collection's index names.
async function createModelIndexes({ targetDb, models, collections }) {
	const created = {};
	for (const Model of Object.values(models)) {
		if (!Model || !collections.includes(Model.collection.collectionName)) continue;
		const name = Model.collection.collectionName;
		created[name] = ["_id_"];
		for (const [keys, options] of Model.schema.indexes()) {
			const { background, ...rest } = options ?? {};
			created[name].push(await targetDb.collection(name).createIndex(keys, rest));
		}
	}
	return created;
}

// After the copy: every document exactly as converted, the same states, every reference resolving, upstream's indexes
// in place, and every suppressed address still ineligible.
export async function verify({ sourceDb, targetDb, converted, accountId, indexes = {}, levels = null }) {
	const checks = {};
	for (const [name, { to, docs, out }] of Object.entries(converted)) {
		const target = await targetDb.collection(to).find({}).toArray();
		checks[`${name}:ids`] = sha(target.map(({ _id }) => _id)) === sha(docs.map(({ _id }) => _id));
		const content = compareContent(out, target);
		checks[`${name}:documents`] = content.same;
		if (!content.same) checks[`${name}:documents-detail`] = `${content.missing} missing, ${content.changed} changed, ${content.extra} extra`;
	}
	for (const [collection, names] of Object.entries(indexes)) {
		const present = new Set((await targetDb.collection(collection).indexes()).map(({ name }) => name));
		checks[`${collection}:indexes`] = names.every((name) => present.has(name));
	}
	const targetCollections = {};
	for (const name of ["newsletters", "contacts", "campaigns", "sequences", "enrollments", "messages", "events"]) {
		targetCollections[name] = await targetDb.collection(name).find({}).toArray();
	}
	checks["relationships:hard"] = checkRelationships(targetCollections).ok;
	const sourceContacts = converted.contacts?.docs ?? [];
	const targetContacts = await targetDb.collection("contacts").find({}).toArray();
	const statusKey = (doc) => `${doc.newsletterId}:${doc.status}`;
	checks["contacts:status-per-newsletter"] = JSON.stringify(histogram(sourceContacts, statusKey)) === JSON.stringify(histogram(targetContacts, statusKey));
	checks["contacts:all-in-account"] = targetContacts.every((doc) => String(doc.accountId) === String(accountId));
	const enrollmentKey = (doc) => `${doc.sequenceId}:${doc.status}`;
	if (converted.enrollments) {
		checks["enrollments:status-per-sequence"] =
			JSON.stringify(histogram(converted.enrollments.docs, enrollmentKey)) === JSON.stringify(histogram(await targetDb.collection("enrollments").find({}).toArray(), enrollmentKey));
	}
	if (converted.apikeys) {
		checks["apikeys:hashes"] = sha(converted.apikeys.docs.map(({ hash }) => hash)) === sha((await targetDb.collection("apikeys").find({}).toArray()).map(({ hash }) => hash));
	}
	// Suppression: every address the old list held is on the account's list, which upstream reads both when the
	// audience is chosen and again for each batch (lib/sending.js findSuppressedEmails, sendMessageBatch). The new
	// SUPPRESSION_HASH_KEY only keys upstream's separate global list, which none of these records depend on.
	const sourceSuppressed = (converted.suppressions?.docs ?? []).map(({ email }) => email);
	const targetSuppressed = new Set((await targetDb.collection("suppressions").find({ accountId }).toArray()).map(({ email }) => email));
	checks["suppressions:every-address-still-suppressed"] = sourceSuppressed.every((address) => targetSuppressed.has(address));
	// Per address: a contact the old list kept from mail can't be eligible here. Upstream sends only to active or dormant
	// contacts whose address its account's list doesn't hold.
	const eligible = targetContacts.filter(({ status, email }) => ["active", "dormant"].includes(status) && !targetSuppressed.has(email));
	const oldSuppressed = new Set(sourceSuppressed);
	checks["suppressions:no-suppressed-address-eligible"] = !eligible.some(({ email }) => oldSuppressed.has(email));
	// Per key: each old key's hash, now in the owner account with a level upstream accepts.
	if (converted.apikeys) {
		const keys = new Map((await targetDb.collection("apikeys").find({}).toArray()).map((doc) => [String(doc._id), doc]));
		checks["apikeys:usable"] = converted.apikeys.docs.every(({ _id, hash }) => {
			const key = keys.get(String(_id));
			return key && key.hash === hash && String(key.accountId) === String(accountId) && (!levels || levels.includes(key.level));
		});
	}
	const messageStatus = (doc) => `${doc.kind}:${doc.status}`;
	if (converted.messages) {
		checks["messages:kind-status"] = JSON.stringify(histogram(converted.messages.docs, messageStatus)) === JSON.stringify(histogram(await targetDb.collection("messages").find({}).toArray(), messageStatus));
		checks["messages:provider-ids"] =
			sha(converted.messages.docs.map(({ sesMessageId }) => sesMessageId ?? "")) ===
			sha((await targetDb.collection("messages").find({}).toArray()).map(({ providerMessageId }) => providerMessageId ?? ""));
	}
	checks.ok = Object.values(checks).every(Boolean);
	return checks;
}

// ---------- CLI ----------
const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
	const args = {};
	const argv = process.argv.slice(2);
	for (let index = 0; index < argv.length; index += 1) {
		const name = argv[index].replace(/^--/, "");
		args[name] = argv[index + 1] && !argv[index + 1].startsWith("--") ? argv[++index] : true;
	}
	const { MIGRATE_SOURCE_URI: sourceUri, MIGRATE_TARGET_URI: targetUri } = process.env;
	if (!sourceUri || !targetUri) throw new Error("Set MIGRATE_SOURCE_URI and MIGRATE_TARGET_URI");
	if (sourceUri === targetUri) throw new Error("Source and target are the same database");
	const source = await new mongoose.mongo.MongoClient(sourceUri, { readPreference: "secondaryPreferred" }).connect();
	await mongoose.connect(targetUri);
	try {
		const report = await migrateFork({
			sourceDb: source.db(),
			targetDb: mongoose.connection.db,
			owner: { email: args["owner-email"], name: args["owner-name"] },
			mailFrom: args["mail-from"],
			archiveHost: args["archive-host"],
			dumpedAt: checkDumpStart(args["dumped-at"]),
			execute: args.execute === true,
		});
		const text = `${JSON.stringify(report, null, 2)}\n`;
		if (args.report) fs.writeFileSync(args.report, text);
		process.stdout.write(text);
		process.exitCode = report.checks?.ok === false || (args.execute && !report.checks?.ok) ? 1 : 0;
	} finally {
		await source.close();
		await mongoose.disconnect();
	}
}
