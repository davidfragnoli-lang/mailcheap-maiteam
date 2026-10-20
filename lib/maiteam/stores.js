// Mongo stores for maiteam's send gates (PATCHES.md P4): the rolling SES quota ledger, the per-newsletter daily cap
// and the per sender-domain warm-up. Same collections as the old fork (ses_quota_holds, newsletter_daily_caps,
// sender_warmups), so the migration carries their state over as it is. Every write is a compare-and-swap; a throw
// or a lost race is a refusal upstream of here.

import { connectDb } from "@/lib/db";
import { capDocumentId, normalizeCapState } from "@/lib/maiteam/newsletter-cap";
import { normalizeQuotaState } from "@/lib/maiteam/send-quota";
import { normalizeWarmupState, summarizeStepEvidence, warmupDocumentId } from "@/lib/maiteam/sender-warmup";
import Message from "@/models/Message";
import NewsletterCap from "@/models/NewsletterCap";
import SenderWarmup from "@/models/SenderWarmup";
import SesQuota from "@/models/SesQuota";

const QUOTA_ID = "ses-rolling-24h";

function swapError(error) {
	if (error?.code === 11000) return false;
	throw error;
}

export function mongoQuotaStore() {
	return {
		async read() {
			await connectDb();
			return normalizeQuotaState((await SesQuota.findById(QUOTA_ID).lean()) ?? {});
		},
		async compareAndSwap(current, next) {
			await connectDb();
			try {
				const result = await SesQuota.updateOne(
					{ _id: QUOTA_ID, revision: current.revision },
					{ $set: { revision: current.revision + 1, reserved: next.reserved, issued: next.issued, accountedSent: next.accountedSent, holds: next.holds } },
					{ upsert: current.revision === 0 }
				);
				return result.upsertedCount === 1 || result.modifiedCount === 1;
			} catch (error) {
				return swapError(error);
			}
		},
	};
}

export function mongoCapStore(newsletterId, now = Date.now()) {
	const id = capDocumentId(newsletterId, now);
	return {
		async read() {
			await connectDb();
			return normalizeCapState((await NewsletterCap.findById(id).lean()) ?? {});
		},
		async compareAndSwap(current, next) {
			await connectDb();
			const stored = normalizeCapState(next);
			try {
				const result = await NewsletterCap.updateOne(
					{ _id: id, revision: current.revision },
					{ $set: { revision: current.revision + 1, issued: stored.issued, holds: stored.holds } },
					{ upsert: current.revision === 0 }
				);
				return result.upsertedCount === 1 || result.modifiedCount === 1;
			} catch (error) {
				return swapError(error);
			}
		},
	};
}

export function mongoWarmupStore(newsletterId, domain) {
	const id = warmupDocumentId(newsletterId, domain);
	return {
		async read() {
			await connectDb();
			return normalizeWarmupState((await SenderWarmup.findById(id).lean()) ?? {});
		},
		async compareAndSwap(current, next) {
			await connectDb();
			const stored = normalizeWarmupState(next);
			try {
				const result = await SenderWarmup.updateOne(
					{ _id: id, revision: current.revision },
					{
						$set: {
							newsletterId,
							domain,
							revision: current.revision + 1,
							startedAt: stored.startedAt,
							level: stored.level,
							levelStartedAt: stored.levelStartedAt,
							checkedAt: stored.checkedAt,
							hold: stored.hold,
							history: stored.history,
						},
					},
					{ upsert: current.revision === 0 }
				);
				return result.upsertedCount === 1 || result.modifiedCount === 1;
			} catch (error) {
				return swapError(error);
			}
		},
	};
}

// The step's Message rows, as the pure summary reads them. Upstream stores the provider's id as providerMessageId; the
// old fork called it sesMessageId. Nothing here takes a number from a caller.
export async function readWarmupEvidence({ accountId, newsletterId, domain, stepStartedAt, now }) {
	await connectDb();
	const cursor = Message.find({
		accountId,
		newsletterId,
		senderDomain: domain,
		handoffAt: { $gte: new Date(stepStartedAt), $lte: new Date(now) },
	})
		.select({ providerMessageId: 1, handoffAt: 1, deliveredAt: 1, bouncedAt: 1, complainedAt: 1, status: 1, error: 1 })
		.lean()
		.cursor();
	async function* rows() {
		for await (const row of cursor) yield { ...row, sesMessageId: row.providerMessageId };
	}
	try {
		return await summarizeStepEvidence(rows(), { stepStartedAt, now });
	} finally {
		await cursor.close?.();
	}
}
