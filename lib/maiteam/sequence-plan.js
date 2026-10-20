// maiteam (PATCHES.md P6): welcome-sequence decisions that don't touch the database. Delays are whole UTC days from a
// contact's enrollment, which for a pending contact is the click on the confirmation link. The emails themselves go
// through upstream's batch path (lib/sending.js sendMessageBatch), as kind "sequence".

import { DAY_MS } from "./newsletter-cap.js";
import { parseThemeInput } from "./email-look.js";

export { DAY_MS };
export const MAX_SEQUENCE_STEPS = 6;
export const MAX_DELAY_DAYS = 90;
export const SEQUENCE_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
// Statuses a contact can't join a sequence from: they left, bounced, complained or went cold.
const BLOCKED_STATUSES = new Set(["unsubscribed", "bounced", "complained", "dormant"]);

// What a signup with a sequence sends. Confirmation stays, because it is the consent step; a sequence replaces the
// welcome email, at signup and after the confirmation click.
export function signupDelivery({ contact, sequence, created = false, alreadyEnrolled = false } = {}) {
	const status = contact?.status;
	const confirmation = status === "pending";
	const canJoin = status === "active" || status === "pending";
	const enroll = Boolean(sequence) && canJoin && !alreadyEnrolled && !BLOCKED_STATUSES.has(status);
	const welcome = Boolean(created) && status === "active" && !sequence;
	return { confirmation, welcome, enroll };
}

// The key the old fork named each step by; the unique index on Message { enrollmentId, stepPosition } (kind "sequence")
// enforces it, so a step is emailed at most once whatever retries or redeliveries do.
export function stepIdempotencyKey(enrollmentId, position) {
	return `sequence:${enrollmentId}:${position}`;
}

// The newsletter's saved welcome email, whether or not it is switched on: a step 1 may reuse it.
export function getSavedWelcome(newsletter) {
	const { subject, previewText, markdown } = newsletter?.welcome ?? {};
	if (!subject?.trim() || !markdown?.trim()) return null;
	return { format: "markdown", subject: subject.trim(), markdown, previewText: previewText?.trim() ?? "" };
}

// What one step sends, in the shape lib/sending-rules.js buildRecipientEmail reads; null when there is nothing to send.
// look: the step's own email look (P3c), which buildRecipientEmail passes on; none is the newsletter's.
export function getSequenceStepContent(sequence, position, newsletter) {
	const step = sequence?.steps?.find((item) => item.position === Number(position));
	if (!step) return null;
	const look = hasLook(step.look) ? step.look : null;
	if (step.useWelcome) {
		const welcome = getSavedWelcome(newsletter);
		return welcome && { ...welcome, look };
	}
	if (!step.subject?.trim() || !step.markdown?.trim()) return null;
	return { format: "markdown", subject: step.subject.trim(), markdown: step.markdown, previewText: step.previewText?.trim() ?? "", look };
}

// A stored subdocument with no preset is no look.
function hasLook(look) {
	return Boolean(look?.preset);
}

// Saved delays are whole days; anything else is refused at send time too.
export function resolveStepDelay(delayFromEnrollmentMs) {
	if (!Number.isInteger(delayFromEnrollmentMs) || delayFromEnrollmentMs < 0 || delayFromEnrollmentMs % DAY_MS !== 0) {
		return { ok: false, message: "Sequence delays must be whole days." };
	}
	return { ok: true, ms: delayFromEnrollmentMs };
}

// When a step is due: its delay after the enrollment.
export function stepDueAt(enrollment, step) {
	const delay = resolveStepDelay(step?.delayFromEnrollmentMs);
	if (!delay.ok) return null;
	return new Date(enrollment.enrolledAt).getTime() + delay.ms;
}

// 503 asks QStash to retry the same job; everything else is final for that job (a retry it needs is published anew).
export function httpStatusForOutcome(outcome) {
	return outcome === "unavailable" ? 503 : 200;
}

export function normalizeSequenceDraft(input = {}) {
	const name = String(input.name ?? "").trim();
	const slug = String(input.slug ?? "").trim().toLowerCase();
	if (!name) return { ok: false, error: "Name is required" };
	if (name.length > 100) return { ok: false, error: "Name is 100 characters at most" };
	if (!SEQUENCE_SLUG_PATTERN.test(slug)) return { ok: false, error: "Slug can only use lowercase letters, numbers and dashes" };
	const status = input.status === "active" || input.status === "paused" ? input.status : "draft";
	const rawSteps = Array.isArray(input.steps) ? input.steps : [];
	if (rawSteps.length < 1 || rawSteps.length > MAX_SEQUENCE_STEPS) {
		return { ok: false, error: `A sequence needs 1 to ${MAX_SEQUENCE_STEPS} steps` };
	}
	const steps = [];
	let previousDay = -1;
	for (let index = 0; index < rawSteps.length; index += 1) {
		const raw = rawSteps[index] ?? {};
		const position = index + 1;
		const delayDays = Number(raw.delayDays);
		if (!Number.isInteger(delayDays) || delayDays < 0 || delayDays > MAX_DELAY_DAYS) {
			return { ok: false, error: `Step ${position} delay must be a whole number of days from 0 to ${MAX_DELAY_DAYS}` };
		}
		if (delayDays <= previousDay) return { ok: false, error: "Step days must come one after another" };
		previousDay = delayDays;
		const useWelcome = position === 1 && raw.useWelcome === true;
		// A series may start a day or more after confirmation (the confirmation email is then the first mail); the
		// welcome email itself always goes out on day 0.
		if (useWelcome && delayDays !== 0) return { ok: false, error: "The welcome email step is sent on day 0" };
		const subject = String(raw.subject ?? "").trim();
		const markdown = String(raw.markdown ?? "").trim();
		const previewText = String(raw.previewText ?? "").trim();
		if (!useWelcome && (!subject || !markdown)) return { ok: false, error: `Step ${position} needs a subject and content` };
		const look = readStepLook(raw.look);
		if (look.error) return { ok: false, error: `Step ${position}: ${look.error}` };
		steps.push({ position, delayDays, delayFromEnrollmentMs: delayDays * DAY_MS, useWelcome, subject, previewText, markdown, ...(look.theme && { look: look.theme }) });
	}
	return { ok: true, sequence: { name, slug, status, steps } };
}

// A step's own look, checked like an issue's (lib/maiteam/email-look.js); nothing, null or "" is the newsletter's.
function readStepLook(look) {
	if (look === undefined || look === null || look === "") return { theme: null };
	return parseThemeInput(look);
}

function fieldText(value) {
	return String(value ?? "").trim();
}

// The dashboard offers three steps. A blank step 3 is omitted. A blank step 2 cannot hide a filled step 3. Step 1's day
// is blank (day 0) on a new sequence; a saved later day comes back in the field and is kept.
export function stepsFromDashboardFields(fields = {}) {
	const later = [2, 3].map((position) => ({
		delayDays: fields[`step${position}Delay`],
		subject: fieldText(fields[`step${position}Subject`]),
		previewText: fieldText(fields[`step${position}Preview`]),
		markdown: fieldText(fields[`step${position}Markdown`]),
		look: fields[`step${position}Look`] ?? null,
	}));
	const filled = (step) => step.subject || step.markdown || step.previewText || fieldText(step.delayDays);
	if (!filled(later[0]) && filled(later[1])) return { ok: false, error: "Fill step 2 before step 3" };
	const steps = [
		{
			delayDays: fieldText(fields.step1Delay) === "" ? 0 : Number(fields.step1Delay),
			useWelcome: fields.step1UseWelcome === true,
			subject: fieldText(fields.step1Subject),
			previewText: fieldText(fields.step1Preview),
			markdown: fieldText(fields.step1Markdown),
			look: fields.step1Look ?? null,
		},
	];
	for (const step of later) {
		if (filled(step)) steps.push({ ...step, delayDays: Number(step.delayDays) });
	}
	return { ok: true, steps };
}
