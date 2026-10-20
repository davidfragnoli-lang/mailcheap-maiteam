import "server-only";
import { commitPlannedState, planProviderHandoff } from "@/lib/maiteam/sequence-handoff";
import { getCampaignRateProblem } from "@/lib/sending-rules";
import Enrollment from "@/models/Enrollment";
import Message from "@/models/Message";
import Sequence from "@/models/Sequence";

// maiteam (PATCHES.md P6): what upstream's batch (lib/sending.js) and its email events (lib/email-events.js) call for a
// sequence email, kind "sequence". The email itself takes upstream's path whole: account checks, suppression, global
// suppression, contact status, SENDING_ENABLED, then deliver() and maiteam's send gates (lib/maiteam/send-gate.js).

export const SEQUENCE_KIND = "sequence";
export const CANCELLED_BEFORE_HANDOFF = "Cancelled before the provider call";
const SEQUENCE_STATS = new Set(["delivered", "bounced", "complained", "failed"]);

// One version of the enrollment at a time: every step write bumps __v, so a compare-and-swap that read an older one
// writes nothing and reads again.
export function enrollmentStore(accountId, enrollmentId) {
	return {
		read: () => Enrollment.findOne({ accountId, _id: enrollmentId }).lean(),
		async compareAndSwap(current, next) {
			if (!current?._id) return false;
			const { matchedCount } = await Enrollment.updateOne(
				{ accountId, _id: enrollmentId, __v: current.__v ?? 0 },
				{ $set: { status: next.status, steps: next.steps }, $inc: { __v: 1 } }
			);
			return matchedCount === 1;
		},
	};
}

// The sequences a batch's sequence emails belong to, by id, so their content comes from the step (getMessageContent).
export async function findMessageSequences(accountId, messages) {
	const ids = [...new Set(messages.filter(({ kind }) => kind === SEQUENCE_KIND).map(({ sequenceId }) => String(sequenceId)))];
	if (ids.length === 0) return new Map();
	const sequences = await Sequence.find({ accountId, _id: { $in: ids } }).lean();
	return new Map(sequences.map((sequence) => [String(sequence._id), sequence]));
}

// Right before deliver(): this send takes the provider call for the step, unless the enrollment was cancelled or the
// step isn't the one authorized (the email is skipped), or its sequence was paused since (the email waits, queued, for
// the sequence to start again). Either way nothing is handed off.
export async function claimSequenceHandoff(message, sequence) {
	const { accountId } = message;
	const claimable = { accountId, _id: message._id, status: "sent", sentAt: null };
	if (sequence?.status !== "active") {
		await Message.updateOne(claimable, { $set: { status: "queued" } });
		return false;
	}
	const claimed = await commitPlannedState(enrollmentStore(accountId, message.enrollmentId), (state) =>
		planProviderHandoff(state, { position: message.stepPosition })
	);
	if (claimed.ok) return true;
	await Message.updateOne(claimable, { $set: { status: "skipped", error: CANCELLED_BEFORE_HANDOFF } });
	return false;
}

// A sequence keeps its own delivered, bounced and complained counts, and pauses on upstream's campaign rate levels: a
// bad list stops its welcome series as it would stop a campaign. The account-wide checks still count these emails
// (lib/account-health.js).
export async function recordSequenceStats(message, increments) {
	if (message.kind !== SEQUENCE_KIND || !message.sequenceId) return;
	const inc = Object.fromEntries(
		Object.entries(increments)
			.filter(([key]) => SEQUENCE_STATS.has(key.replace(/^stats\./, "")))
			.map(([key, value]) => [`stats.${key.replace(/^stats\./, "")}`, value])
	);
	if (Object.keys(inc).length === 0) return;
	const filter = { accountId: message.accountId, _id: message.sequenceId };
	const sequence = await Sequence.findOneAndUpdate(filter, { $inc: inc }, { returnDocument: "after" }).select({ status: 1, stats: 1 }).lean();
	const problem = sequence?.status === "active" ? getCampaignRateProblem(sequence.stats) : null;
	if (problem) {
		await Sequence.updateOne({ ...filter, status: "active" }, { $set: { status: "paused", pauseReason: problem.reason.replaceAll("campaign", "sequence") } });
	}
}
