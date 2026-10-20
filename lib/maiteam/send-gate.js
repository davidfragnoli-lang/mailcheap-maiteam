// maiteam's send gates (PATCHES.md P4), on top of upstream's own checks. Every email reaches the provider through
// lib/sending.js deliver(), and deliver() hands that call to gateDelivery. Before the handoff, each email takes:
// - a hold in the rolling 24-hour SES quota ledger (Max24HourSend minus SentLast24Hours, read fresh), so two
//   preflights can't both spend the last of it, and a missing or stale read refuses;
// - a hold in its newsletter's UTC-day cap, lowered by its sender domain's warm-up level (50 → 1000 a day). Zero is
//   closed and a missing cap refuses: there is no unlimited default;
// - a send slot at no more than SES's own MaxSendRate, and none at all when the shared Redis count can't be read.
// The holds are issued once the provider took the email. They are released only when the email provably wasn't
// handed off: an ambiguous provider error keeps them, so the ledgers can under-send but never overspend.
//
// MAITEAM_SEND_GATES=off turns them off. Only the test setup does that, for upstream's own tests; nothing turns them
// off in production by omission.

import { LIMITS } from "@/lib/config";
import { providerError, SEND_OUTCOMES } from "@/lib/email-provider/outcomes";
import { updateDocument } from "@/lib/maiteam/document-store";
import { nextUtcDayStart, normalizeCapState, planCapIssue, planCapRelease, readDailyCap, readNewsletterDailyCap } from "@/lib/maiteam/newsletter-cap";
import { effectiveReading, planIssueFromKey, planReleaseKey, planReservation, quotaRefusalMessage, reconcileQuota, SES_QUOTA_MAX_AGE_MS, updateQuota } from "@/lib/maiteam/send-quota";
import { advanceWarmup, effectiveDailyLimit, reserveWarmedCap, senderDomainOf } from "@/lib/maiteam/sender-warmup";
import { mongoCapStore, mongoQuotaStore, mongoWarmupStore, readWarmupEvidence } from "@/lib/maiteam/stores";
import { waitForSendSlot } from "@/lib/send-rate";
import { getSesAccount } from "@/lib/ses";
import Message from "@/models/Message";

// The old fork's app-wide target: never faster than this, whatever SEND_RATE_PER_SECOND or SES allow.
export const APP_RATE_TARGET = 6;
// One fresh account read serves the emails of a batch for this long; the ledger itself refuses anything older than
// SES_QUOTA_MAX_AGE_MS.
const QUOTA_READ_REUSE_MS = 10_000;
// Errors that mean the provider took nothing (lib/email-provider/outcomes.js, and SES's own throttling names).
const NOT_HANDED_OFF_OUTCOMES = new Set([SEND_OUTCOMES.throttled, SEND_OUTCOMES.unavailable]);
const NOT_HANDED_OFF_NAMES = new Set(["Throttling", "ThrottlingException", "TooManyRequestsException", "LimitExceededException", "SendGateRefused"]);

export function isGated(env = process.env) {
	return env.MAITEAM_SEND_GATES !== "off";
}

let lastRead = null;
// Seams for tests only: the SES account read and the shared slot. Production never changes them.
const seams = { readAccount: getSesAccount, waitForSlot: waitForSendSlot };

export function setSendGateSeamsForTests(overrides) {
	Object.assign(seams, overrides);
	lastRead = null;
}

// The SES account's quota, read fresh (no older than QUOTA_READ_REUSE_MS). Exported for tests.
export async function readFreshQuota({ now = Date.now(), readAccount = seams.readAccount } = {}) {
	if (lastRead && now - lastRead.fetchedAt <= QUOTA_READ_REUSE_MS && lastRead.fetchedAt <= now) return lastRead;
	const account = await readAccount({ fresh: true });
	const ok =
		account && !account.error && Number.isFinite(account.max24HourSend) && Number.isFinite(account.sentLast24Hours) && Number.isFinite(account.maxSendRate);
	if (!ok) {
		lastRead = null;
		return { ok: false, message: quotaRefusalMessage("unavailable") };
	}
	lastRead = { ok: true, max24HourSend: account.max24HourSend, sentLast24Hours: account.sentLast24Hours, maxSendRate: account.maxSendRate, fetchedAt: now };
	return lastRead;
}

// Nothing was sent: the batch keeps the email queued and comes back later (lib/sending-rules.js maps throttled to retry).
function refuseForNow(message, retryAfter = 60) {
	return providerError(SEND_OUTCOMES.throttled, message, { name: "SendGateRefused", retryAfter });
}

// The newsletter's own setup refuses it: a campaign pauses with the reason, a signup email fails with it.
function refuseSetup(message) {
	return providerError(SEND_OUTCOMES.misconfigured, message, { name: "SendGateRefused" });
}

function warmupFor(newsletter) {
	const domain = senderDomainOf(newsletter?.fromEmail);
	if (!newsletter?._id || !domain) return { fromEmail: newsletter?.fromEmail ?? null };
	return {
		fromEmail: newsletter.fromEmail,
		store: mongoWarmupStore(newsletter._id, domain),
		readEvidence: ({ stepStartedAt, now }) =>
			readWarmupEvidence({ accountId: newsletter.accountId, newsletterId: newsletter._id, domain, stepStartedAt, now }),
	};
}

// The rate a send slot is taken at: the lesser of the lane's configured rate, the app target and SES's MaxSendRate.
export function gatedRate(laneRate, maxSendRate) {
	return Math.max(1, Math.floor(Math.min(laneRate ?? LIMITS.sendRatePerSecond, APP_RATE_TARGET, maxSendRate)));
}

async function settle(key, { newsletter, at, sent }) {
	const quota = await updateQuota(mongoQuotaStore(), (state) => (sent ? planIssueFromKey(state, key, 1, Date.now()) : planReleaseKey(state, key, 1))).catch((error) => error);
	const cap = await updateDocument(mongoCapStore(newsletter._id, at), normalizeCapState, (state) =>
		sent ? planCapIssue(state, key, 1) : planCapRelease(state, key, 1)
	).catch((error) => error);
	for (const [name, result] of [["quota", quota], ["cap", cap]]) {
		if (result instanceof Error || result?.ok === false) {
			console.error(`[send-gate] Could not ${sent ? "issue" : "release"} the ${name} hold ${key}:`, result?.message ?? result?.reason);
		}
	}
}

function isNotHandedOff(error) {
	return NOT_HANDED_OFF_OUTCOMES.has(error?.outcome) || NOT_HANDED_OFF_NAMES.has(error?.name);
}

// What deliver() calls instead of waiting for a slot and calling the provider itself.
export async function gateDelivery({ message, newsletter, lane, send, now = Date.now() }) {
	if (!isGated()) {
		await seams.waitForSlot(lane);
		return send();
	}
	const quota = await readFreshQuota({ now });
	if (!quota.ok) throw refuseForNow(quota.message);
	const key = `message:${message._id}`;

	const quotaHold = await updateQuota(mongoQuotaStore(), (state) => planReservation(state, { ...quota, now, maxAgeMs: SES_QUOTA_MAX_AGE_MS, key, amount: 1 })).catch(
		() => ({ ok: false, reason: "unavailable", message: quotaRefusalMessage("unavailable") })
	);
	if (!quotaHold.ok) throw refuseForNow(quotaHold.message, ["none-left", "exceeds"].includes(quotaHold.reason) ? 3600 : 60);

	const configured = readDailyCap({ newsletterCap: newsletter.dailySendCap, envCap: readNewsletterDailyCap() });
	if (configured.ok && configured.cap === 0) {
		await updateQuota(mongoQuotaStore(), (state) => planReleaseKey(state, key, 1)).catch(() => {});
		throw refuseSetup("This newsletter's daily send cap is 0: sending is closed until it is opened.");
	}
	const capHold = await reserveWarmedCap({
		capStore: mongoCapStore(newsletter._id, now),
		warmup: warmupFor(newsletter),
		newsletterCap: newsletter.dailySendCap,
		envCap: readNewsletterDailyCap(),
		key,
		amount: 1,
		now,
	}).catch(() => ({ ok: false, reason: "unavailable", message: "The daily cap could not be read, so this send was refused." }));
	if (!capHold.ok) {
		await updateQuota(mongoQuotaStore(), (state) => planReleaseKey(state, key, 1)).catch(() => {});
		if (capHold.reason === "unconfigured") throw refuseSetup(capHold.message);
		const untilMidnight = Math.ceil((nextUtcDayStart(now) - now) / 1000);
		throw refuseForNow(capHold.message, ["none-left", "exceeds"].includes(capHold.reason) ? untilMidnight : 60);
	}

	try {
		await seams.waitForSlot({ ...lane, rate: gatedRate(lane?.rate, quota.maxSendRate), failClosed: true });
		// Stamped before the handoff, so the warm-up counts an email whose result is unknown.
		await Message.updateOne(
			{ accountId: message.accountId, _id: message._id },
			{ $set: { senderDomain: senderDomainOf(newsletter.fromEmail), handoffAt: new Date() } }
		);
	} catch (error) {
		await settle(key, { newsletter, at: now, sent: false });
		throw error?.name === "Throttling" ? refuseForNow(error.message) : error;
	}

	let result;
	try {
		result = await send();
	} catch (error) {
		await settle(key, { newsletter, at: now, sent: !isNotHandedOff(error) });
		throw error;
	}
	await settle(key, { newsletter, at: now, sent: true });
	return result;
}

// Before a campaign is queued: an audience larger than what today's quota and cap leave is refused whole, with the
// count that remains. The per-email gate above still decides each send.
export async function getSendRoom({ newsletter, now = Date.now() }) {
	if (!isGated()) return { ok: true, remaining: Infinity };
	const quota = await readFreshQuota({ now });
	if (!quota.ok) return { ok: false, remaining: 0, message: quota.message };
	const ledger = reconcileQuota(await mongoQuotaStore().read(), quota);
	const { sentLast24Hours } = effectiveReading(ledger, quota);
	const quotaRoom = Math.max(0, Math.floor(quota.max24HourSend - sentLast24Hours) - ledger.reserved);
	const configured = readDailyCap({ newsletterCap: newsletter?.dailySendCap, envCap: readNewsletterDailyCap() });
	if (!configured.ok) return { ok: false, remaining: 0, message: "This newsletter has no daily send cap, so nothing can be sent until one is set." };
	const warmup = warmupFor(newsletter);
	if (!warmup.store) return { ok: false, remaining: 0, message: "This newsletter has no valid sender domain for warm-up." };
	const { state } = await advanceWarmup({ store: warmup.store, readEvidence: warmup.readEvidence, now });
	const limit = effectiveDailyLimit(configured, state);
	const cap = normalizeCapState(await mongoCapStore(newsletter._id, now).read());
	const capRoom = Math.max(0, (limit ?? 0) - cap.reserved);
	return { ok: true, remaining: Math.min(quotaRoom, capRoom), quotaRoom, capRoom, limit };
}

export async function assertSendRoom({ newsletter, emails, fail }) {
	const room = await getSendRoom({ newsletter });
	if (!room.ok) throw fail("unavailable", room.message);
	if (emails > room.remaining) {
		throw fail("send_check_failed", `This send needs ${emails} emails and ${room.remaining} remain today (SES quota and this newsletter's daily cap). It was refused, not shortened.`);
	}
}
