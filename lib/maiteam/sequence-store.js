import "server-only";
import { getAppUrl, isSendingEnabled } from "@/lib/config";
import { connectDb } from "@/lib/db";
import { CANCELLED_BEFORE_HANDOFF, SEQUENCE_KIND, enrollmentStore } from "@/lib/maiteam/sequence-delivery";
import { commitPlannedState, planEnrollmentCancel, planHandoffRelease } from "@/lib/maiteam/sequence-handoff";
import { getSequenceStepContent, signupDelivery, stepDueAt, stepIdempotencyKey } from "@/lib/maiteam/sequence-plan";
import { mailboxProvider } from "@/lib/providers";
import { loadSender } from "@/lib/sender";
import { publishJob, sendMessageBatch } from "@/lib/sending";
import { getSendProblem } from "@/lib/sending-rules";
import { isObjectIdString } from "@/lib/validation";
import Contact from "@/models/Contact";
import Enrollment from "@/models/Enrollment";
import Message from "@/models/Message";
import Newsletter from "@/models/Newsletter";
import Sequence from "@/models/Sequence";
import Suppression from "@/models/Suppression";

// maiteam (PATCHES.md P6): enrollments and the step job. Each step email is a Message of kind "sequence", queued and sent
// through upstream's sendMessageBatch like a signup email (lib/sending.js sendSignupEmail), so every check upstream and
// maiteam's send gates make applies to it. This file only decides when a step is due, owns its claim, and reads what
// the batch did with it.

const OPEN_STEP = ["pending", "scheduled", "held"];
// A step in one of these is done with; the next one may go.
const RESOLVED_STEP = ["sent", "skipped", "cancelled"];
const OPEN_ENROLLMENT = ["awaiting_confirmation", "active"];
const MIN_RETRY_SECONDS = 10;
const MAX_RETRY_SECONDS = 24 * 60 * 60;

function outcome(name, extra = {}) {
	return { outcome: name, sent: name === "sent", ...extra };
}

// Every step write bumps __v, so the compare-and-swaps in lib/maiteam/sequence-handoff.js never miss it.
async function setStep({ accountId, enrollmentId, position, from, set, enrollment = {} }) {
	const update = Object.fromEntries(Object.entries(set).map(([key, value]) => [`steps.$.${key}`, value]));
	const { matchedCount } = await Enrollment.updateOne(
		{ accountId, _id: enrollmentId, ...enrollment, steps: { $elemMatch: { position, status: { $in: from } } } },
		{ $set: update, $inc: { __v: 1 } }
	);
	return matchedCount === 1;
}

export async function publishSequenceStep({ accountId, enrollmentId, position, notBefore, scheduledFor }) {
	await publishJob({
		url: `${getAppUrl()}/api/jobs/sequence-step`,
		body: { accountId: String(accountId), enrollmentId: String(enrollmentId), position, scheduledFor },
		notBefore: Math.floor(notBefore / 1000),
		retries: 3,
	});
}

// Due at its delay after the enrollment, or at notBefore. A step that can't be published is held, and starting the
// sequence again publishes it.
async function scheduleStep({ enrollment, sequence, position, now = Date.now(), notBefore }) {
	const step = sequence.steps.find((item) => item.position === position);
	const dueAt = step ? stepDueAt(enrollment, step) : null;
	if (dueAt === null) return { scheduled: false };
	const at = Number.isFinite(notBefore) ? notBefore : Math.max(now, dueAt);
	const scheduledFor = new Date(at).toISOString();
	const where = { accountId: enrollment.accountId, enrollmentId: enrollment._id, position };
	if (!(await setStep({ ...where, from: OPEN_STEP, set: { status: "scheduled", scheduledFor } }))) return { scheduled: false };
	try {
		await publishSequenceStep({ accountId: enrollment.accountId, enrollmentId: enrollment._id, position, notBefore: at, scheduledFor });
	} catch (error) {
		await setStep({ ...where, from: ["scheduled"], set: { status: "held" } });
		console.error(`[sequence] Could not schedule step ${position} for ${enrollment._id}:`, error.message);
		return { scheduled: false };
	}
	return { scheduled: true, scheduledFor };
}

// Nothing is published while sending is off or the sequence isn't active: starting it publishes the held steps.
function freshSteps(sequence, { awaiting, sendingEnabled }) {
	return sequence.steps.map(({ position }) => ({ position, status: awaiting || !sendingEnabled ? "held" : "pending" }));
}

export async function enrollContact({ sequence, newsletter, contact, sendingEnabled = isSendingEnabled(), now = Date.now() }) {
	await connectDb();
	const { accountId } = newsletter;
	const existing = await Enrollment.findOne({ accountId, sequenceId: sequence._id, contactId: contact._id }).lean();
	if (existing) return { enrollment: existing, created: false };

	const awaiting = contact.status === "pending";
	let enrollment;
	try {
		enrollment = (
			await Enrollment.create({
				accountId,
				sequenceId: sequence._id,
				newsletterId: newsletter._id,
				contactId: contact._id,
				email: contact.email,
				status: awaiting ? "awaiting_confirmation" : "active",
				enrolledAt: new Date(now),
				steps: freshSteps(sequence, { awaiting, sendingEnabled }),
			})
		).toObject();
	} catch (error) {
		if (error?.code !== 11000) throw error;
		const raced = await Enrollment.findOne({ accountId, sequenceId: sequence._id, contactId: contact._id }).lean();
		return { enrollment: raced, created: false };
	}
	if (!awaiting && sendingEnabled && sequence.status === "active") await scheduleStep({ enrollment, sequence, position: 1, now });
	return { enrollment, created: true };
}

// A signup that names a sequence: only an active one of that newsletter. Unknown answers null, before any write.
export async function findSignupSequence({ newsletter, slug }) {
	const value = String(slug ?? "").trim().toLowerCase();
	if (!value) return null;
	await connectDb();
	return Sequence.findOne({ accountId: newsletter.accountId, newsletterId: newsletter._id, slug: value, status: "active" }).lean();
}

// After the contact is written. vouchedConsent false (the waitlist webhook): an active contact who never clicked a
// confirmation link (an import, say) doesn't start a series from it.
export async function enrollSignup({ newsletter, contact, created, sequence, vouchedConsent = true }) {
	const alreadyEnrolled = Boolean(await Enrollment.exists({ accountId: newsletter.accountId, sequenceId: sequence._id, contactId: contact._id }));
	const plan = signupDelivery({ contact, sequence, created, alreadyEnrolled });
	if (!vouchedConsent && contact.status === "active" && !contact.confirmedAt) plan.enroll = false;
	if (plan.enroll) await enrollContact({ sequence, newsletter, contact });
	return plan;
}

// The confirmation click. Starts the contact's waiting enrollments, timed from now. inSequence: the contact is in a
// sequence of this newsletter, which replaces the welcome email.
export async function activateAwaitingEnrollments({ accountId, contact, sendingEnabled = isSendingEnabled(), now = Date.now() }) {
	await connectDb();
	const waiting = await Enrollment.find({ accountId, contactId: contact._id, status: "awaiting_confirmation" }).lean();
	const started = [];
	for (const enrollment of waiting) {
		const updated = await Enrollment.findOneAndUpdate(
			{ accountId, _id: enrollment._id, status: "awaiting_confirmation" },
			{
				$set: { status: "active", enrolledAt: new Date(now), steps: enrollment.steps.map(({ position }) => ({ position, status: sendingEnabled ? "pending" : "held" })) },
				$inc: { __v: 1 },
			},
			{ returnDocument: "after" }
		).lean();
		if (!updated) continue;
		started.push(updated);
		const sequence = await Sequence.findOne({ accountId, _id: updated.sequenceId }).lean();
		if (sendingEnabled && sequence?.status === "active") await scheduleStep({ enrollment: updated, sequence, position: 1, now });
	}
	const inSequence =
		started.length > 0 || Boolean(await Enrollment.exists({ accountId, contactId: contact._id, status: { $in: ["active", "completed"] } }));
	return { started, inSequence };
}

async function scheduleNextOrComplete({ enrollment, sequence, position }) {
	const next = sequence.steps.find((step) => step.position === position + 1);
	const current = await Enrollment.findOne({ accountId: enrollment.accountId, _id: enrollment._id }).select({ status: 1 }).lean();
	if (current?.status !== "active") return;
	if (!next) {
		await Enrollment.updateOne({ accountId: enrollment.accountId, _id: enrollment._id, status: "active" }, { $set: { status: "completed" }, $inc: { __v: 1 } });
		return;
	}
	// Read again: a pause may have landed while this step was in flight. Starting the sequence publishes it then.
	const persisted = await Sequence.findOne({ accountId: enrollment.accountId, _id: sequence._id }).select({ status: 1 }).lean();
	if (persisted?.status === "active" && isSendingEnabled()) await scheduleStep({ enrollment, sequence, position: next.position });
}

// The step a Message already exists for: what its email became.
function stepStatusFor(message) {
	if (message.sentAt) return "sent";
	if (message.status === "skipped" || message.status === "suppressed") return message.error === CANCELLED_BEFORE_HANDOFF ? "cancelled" : "skipped";
	if (message.status === "failed") return "failed";
	if (message.status === "queued") return "sending";
	// Claimed by a batch with no result yet: it may have been handed off, so it is never sent again.
	return "in-flight";
}

async function cancelRest({ accountId, enrollmentId }) {
	await cancelEnrollmentById({ accountId, enrollmentId }).catch((error) => console.error(`[sequence] Could not cancel ${enrollmentId}:`, error.message));
}

// What the batch did with the step's email, read from its counts and the Message itself.
async function settleStep({ enrollment, sequence, position, message, result, key, now }) {
	const { accountId } = enrollment;
	const where = { accountId, enrollmentId: enrollment._id, position };
	const pending = ["sending", "in-flight"];
	const stored = await Message.findOne({ accountId, _id: message._id }).lean();

	if (result.sent > 0) {
		await setStep({ ...where, from: pending, set: { status: "sent", sentAt: stored?.sentAt ?? new Date() } });
		await Sequence.updateOne({ accountId, _id: sequence._id }, { $inc: { "stats.sent": 1 } });
		await scheduleNextOrComplete({ enrollment, sequence, position });
		return outcome("sent", { key, providerMessageId: stored?.providerMessageId ?? null });
	}
	if (result.retry) {
		// Not handed off: the provider or a send gate said later. The step is cancellable again until the next try.
		const released = await commitPlannedState(enrollmentStore(accountId, enrollment._id), (state) => planHandoffRelease(state, { position }));
		const current = released.write ? released.state : await Enrollment.findOne({ accountId, _id: enrollment._id }).lean();
		if (current?.status !== "active") {
			await Message.updateOne({ accountId, _id: message._id, status: "queued" }, { $set: { status: "skipped", error: CANCELLED_BEFORE_HANDOFF } });
			await setStep({ ...where, from: pending, set: { status: "cancelled" } });
			return outcome("cancelled", { key });
		}
		const seconds = Math.min(Math.max(Math.ceil(result.retryAfter || 60), MIN_RETRY_SECONDS), MAX_RETRY_SECONDS);
		const retryAt = now + seconds * 1000;
		const scheduledFor = current.steps.find((step) => step.position === position)?.scheduledFor;
		try {
			await publishSequenceStep({ accountId, enrollmentId: enrollment._id, position, notBefore: retryAt, scheduledFor });
		} catch (error) {
			console.error(`[sequence] Could not republish ${key}:`, error.message);
			return outcome("unavailable", { key });
		}
		return outcome("retry", { key, retryAt });
	}
	if (result.suppressed > 0) {
		await setStep({ ...where, from: pending, set: { status: "skipped" } });
		await cancelRest({ accountId, enrollmentId: enrollment._id });
		return outcome("suppressed", { key });
	}
	if (result.failed > 0) {
		await setStep({ ...where, from: pending, set: { status: "failed" } });
		await Sequence.updateOne({ accountId, _id: sequence._id }, { $inc: { "stats.failed": 1 } });
		return outcome("failed", { key, error: stored?.error ?? null });
	}
	if (stored?.status === "queued") {
		// The sequence was paused between the job's check and the handoff: the email waits for it to start again.
		await setStep({ ...where, from: pending, set: { status: "held" } });
		return outcome("paused", { key });
	}
	if (stored?.status === "skipped") {
		const status = stored.error === CANCELLED_BEFORE_HANDOFF ? "cancelled" : "skipped";
		await setStep({ ...where, from: pending, set: { status } });
		return outcome(status, { key });
	}
	// Another run's batch holds the email.
	return outcome("duplicate", { key });
}

async function deliverStep({ enrollment, sequence, position, message, key, now }) {
	if (message.status !== "queued") {
		const status = stepStatusFor(message);
		await setStep({ accountId: enrollment.accountId, enrollmentId: enrollment._id, position, from: ["claimed", "sending"], set: { status } });
		return outcome("duplicate", { key });
	}
	let result;
	try {
		result = await sendMessageBatch({ accountId: String(enrollment.accountId), messageIds: [String(message._id)] });
	} catch (error) {
		// The step stays `sending` with its queued email; QStash retries this job.
		console.error(`[sequence] ${key} could not be sent:`, error.message);
		return outcome("unavailable", { key });
	}
	return settleStep({ enrollment, sequence, position, message, result, key, now });
}

async function createStepMessage({ enrollment, sequence, contact, position }) {
	const { accountId } = enrollment;
	try {
		return (
			await Message.create({
				kind: SEQUENCE_KIND,
				accountId,
				newsletterId: enrollment.newsletterId,
				contactId: contact._id,
				email: contact.email,
				provider: mailboxProvider(contact.email),
				sequenceId: sequence._id,
				enrollmentId: enrollment._id,
				stepPosition: position,
			})
		).toObject();
	} catch (error) {
		if (error?.code !== 11000) throw error;
		// The step's one email exists already: an earlier run made it.
		return Message.findOne({ accountId, kind: SEQUENCE_KIND, enrollmentId: enrollment._id, stepPosition: position }).lean();
	}
}

// One step, from the QStash job. 200 for every handled outcome; "unavailable" answers 503 so QStash retries the job.
export async function runSequenceStep({ accountId, enrollmentId, position, scheduledFor, now = Date.now() }) {
	if (!isObjectIdString(String(accountId ?? "")) || !isObjectIdString(String(enrollmentId ?? "")) || !Number.isInteger(position)) {
		return outcome("refused");
	}
	await connectDb();
	const enrollment = await Enrollment.findOne({ accountId, _id: enrollmentId }).lean();
	if (!enrollment) return outcome("missing");
	const key = stepIdempotencyKey(enrollment._id, position);
	const stored = enrollment.steps.find((step) => step.position === position);
	if (!stored) return outcome("refused", { key });
	if (scheduledFor && stored.scheduledFor && stored.scheduledFor !== scheduledFor) return outcome("duplicate", { key, skipped: "rescheduled" });
	if (!isSendingEnabled()) return outcome("sending-off", { key });
	if (enrollment.status === "awaiting_confirmation") return outcome("not-confirmed", { key });
	if (enrollment.status !== "active") return outcome(enrollment.status === "cancelled" ? "cancelled" : "duplicate", { key });
	if (!["sending", ...OPEN_STEP].includes(stored.status)) return outcome(stored.status === "cancelled" ? "cancelled" : "duplicate", { key });

	const [sequence, contact, newsletter] = await Promise.all([
		Sequence.findOne({ accountId, _id: enrollment.sequenceId }).lean(),
		Contact.findOne({ accountId, _id: enrollment.contactId }).lean(),
		Newsletter.findOne({ accountId, _id: enrollment.newsletterId }).lean(),
	]);
	if (sequence?.status !== "active") return outcome("paused", { key });
	const where = { accountId, enrollmentId: enrollment._id, position };

	// A run that stopped after the email was queued, or a send the provider put off: the same email goes again.
	if (stored.status === "sending") {
		const message = stored.messageId ? await Message.findOne({ accountId, _id: stored.messageId }).lean() : null;
		if (!message) return outcome("refused", { key });
		return deliverStep({ enrollment, sequence, position, message, key, now });
	}

	// The batch checks all of this again; checked here first so the series stops instead of failing a step at a time.
	const suppressed = contact ? await Suppression.exists({ accountId, email: contact.email }) : false;
	if (contact?.status !== "active" || suppressed) {
		await setStep({ ...where, from: OPEN_STEP, set: { status: "skipped" } });
		await cancelRest({ accountId, enrollmentId: enrollment._id });
		return outcome("suppressed", { key });
	}
	const content = getSequenceStepContent(sequence, position, newsletter);
	const sender = newsletter ? await loadSender({ _id: accountId }, newsletter) : null;
	const problem = content ? getSendProblem({ campaign: content, newsletter, sender }) : "This step has nothing to send";
	if (problem) {
		await setStep({ ...where, from: OPEN_STEP, set: { status: "failed" } });
		return outcome("refused", { key, message: problem });
	}

	const dueAt = stepDueAt(enrollment, sequence.steps.find((step) => step.position === position));
	if (dueAt === null) {
		await setStep({ ...where, from: OPEN_STEP, set: { status: "failed" } });
		return outcome("refused", { key, message: "Sequence delays must be whole days." });
	}
	if (now + 1000 < dueAt) {
		const rescheduled = await scheduleStep({ enrollment, sequence, position, now, notBefore: dueAt });
		return outcome(rescheduled.scheduled ? "early" : "unavailable", { key, retryAt: dueAt });
	}

	if (!(await setStep({ ...where, enrollment: { status: "active" }, from: OPEN_STEP, set: { status: "claimed" } }))) return outcome("duplicate", { key });
	let message;
	try {
		message = await createStepMessage({ enrollment, sequence, contact, position });
	} catch (error) {
		await setStep({ ...where, from: ["claimed"], set: { status: "scheduled" } });
		console.error(`[sequence] ${key}: the email could not be queued:`, error.message);
		return outcome("unavailable", { key });
	}
	// Authorized only while the enrollment is still active: a cancellation since the claim wins.
	const authorized = await setStep({ ...where, enrollment: { status: "active" }, from: ["claimed"], set: { status: "sending", messageId: String(message._id) } });
	if (!authorized) {
		await Message.updateOne({ accountId, _id: message._id, status: "queued" }, { $set: { status: "skipped", error: CANCELLED_BEFORE_HANDOFF } });
		return outcome("cancelled", { key });
	}
	return deliverStep({ enrollment, sequence, position, message, key, now });
}

// The same transition the provider handoff races (lib/maiteam/sequence-handoff.js). A step already in flight is
// reported and left; every other open step is cancelled, and its queued email skipped.
export async function cancelEnrollmentById({ accountId, enrollmentId }) {
	await connectDb();
	const result = await commitPlannedState(enrollmentStore(accountId, enrollmentId), planEnrollmentCancel);
	if (!result.write) return { ok: false, error: result.error || "Enrollment not found", inFlight: Boolean(result.inFlight) };
	await Message.updateMany(
		{ accountId, kind: SEQUENCE_KIND, enrollmentId, status: "queued" },
		{ $set: { status: "skipped", error: CANCELLED_BEFORE_HANDOFF } }
	);
	if (result.inFlight) return { ok: false, inFlight: true, error: result.error };
	return { ok: true, inFlight: false };
}

// An unsubscribe, a hard bounce or a complaint ends the contact's open series. Each step still rechecks at execution,
// and the batch checks status and suppression again, so a lost write here can't release a send.
export async function cancelEnrollmentsFor({ accountId, contactIds = [], emails = [] } = {}) {
	if (!isObjectIdString(String(accountId ?? ""))) return [];
	await connectDb();
	const ids = [...contactIds];
	if (emails.length > 0) ids.push(...(await Contact.find({ accountId, email: { $in: emails } }).select({ _id: 1 }).lean()).map(({ _id }) => _id));
	if (ids.length === 0) return [];
	const open = await Enrollment.find({ accountId, contactId: { $in: ids }, status: { $in: OPEN_ENROLLMENT } }).select({ _id: 1 }).lean();
	const results = [];
	for (const { _id } of open) results.push({ enrollmentId: String(_id), ...(await cancelEnrollmentById({ accountId, enrollmentId: _id })) });
	return results;
}

// After the pause is written, no new provider handoff starts (claimSequenceHandoff reads it after its claim). A step
// already in flight was claimed before: it is reported, not taken back.
export async function pauseSequence({ accountId, sequenceId }) {
	await connectDb();
	const { matchedCount } = await Sequence.updateOne({ accountId, _id: sequenceId, status: "active" }, { $set: { status: "paused" } });
	if (!matchedCount) return { error: "Only an active sequence can be paused" };
	const inFlight = await Enrollment.countDocuments({ accountId, sequenceId, "steps.status": "in-flight" });
	return { ok: true, inFlight };
}

// The earliest step of the enrollment that isn't done with. Later steps never overtake it.
export function resumeStepFor(enrollment) {
	const steps = [...(enrollment.steps ?? [])].sort((a, b) => a.position - b.position);
	return steps.find((step) => !RESOLVED_STEP.includes(step.status)) ?? null;
}

// The explicit start: saving a sequence as active publishes nothing. Each active enrollment resumes at its earliest
// unresolved step. An open step is published, due at its delay or now. A step whose email is already queued
// (`sending`, say a retry that came back while the sequence was paused) is published again with that same email. A
// step in flight, being claimed or failed holds the enrollment where it is: nothing after it is published.
export async function startSequence({ accountId, sequenceId, now = Date.now() }) {
	if (!isSendingEnabled()) return { error: "Sending is off" };
	await connectDb();
	const sequence = await Sequence.findOneAndUpdate(
		{ accountId, _id: sequenceId },
		{ $set: { status: "active" }, $unset: { pauseReason: 1 } },
		{ returnDocument: "after" }
	).lean();
	if (!sequence) return { error: "Sequence not found" };
	let scheduled = 0;
	let waiting = 0;
	for await (const enrollment of Enrollment.find({ accountId, sequenceId: sequence._id, status: "active" }).lean().cursor()) {
		const next = resumeStepFor(enrollment);
		if (!next) continue;
		if (OPEN_STEP.includes(next.status)) {
			if ((await scheduleStep({ enrollment, sequence, position: next.position, now })).scheduled) scheduled++;
			continue;
		}
		if (next.status === "sending" && next.messageId) {
			try {
				await publishSequenceStep({ accountId, enrollmentId: enrollment._id, position: next.position, notBefore: now, scheduledFor: next.scheduledFor });
				scheduled++;
			} catch (error) {
				console.error(`[sequence] Could not republish step ${next.position} for ${enrollment._id}:`, error.message);
				waiting++;
			}
			continue;
		}
		waiting++;
	}
	return { ok: true, scheduled, waiting };
}
