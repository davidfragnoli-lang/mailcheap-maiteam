import "server-only";
import * as z from "zod";
import { scoped } from "@/lib/account-scope";
import { defineAction } from "@/lib/actions/define-action";
import { actionError } from "@/lib/actions/errors";
import { assertSendingEnabled, dateOutput, findNewsletter, idInput, newsletterFilterInput, newsletterInput, toIso } from "@/lib/actions/shared";
import { MAX_DELAY_DAYS, MAX_SEQUENCE_STEPS, getSavedWelcome, normalizeSequenceDraft } from "@/lib/maiteam/sequence-plan";
import { cancelEnrollmentById, pauseSequence, startSequence } from "@/lib/maiteam/sequence-store";
import { ENROLLMENT_STATUSES, ENROLLMENT_STEP_STATUSES } from "@/models/Enrollment";
import { isObjectIdString } from "@/lib/validation";
import Enrollment from "@/models/Enrollment";
import Newsletter from "@/models/Newsletter";
import Sequence from "@/models/Sequence";

// maiteam (PATCHES.md P6): welcome sequences as customer actions, so the dashboard, the REST API and MCP run the same
// code (lib/actions/run-action.js). Registered in lib/actions/registry.js.

const GROUP = "Sequences";
const MAX_SEQUENCES = 100;
const LISTED_ENROLLMENTS = 50;
const STATUSES = ["draft", "active", "paused"];

const sequenceId = idInput("sequence");
const stepInput = z.object({
	delayDays: z.number().int().min(0).max(MAX_DELAY_DAYS).describe("Days after the confirmed enrollment, each step later than the one before"),
	useWelcome: z.boolean().optional().describe("Step 1 only, on day 0: send the newsletter's saved welcome email instead"),
	subject: z.string().max(300).optional().describe("The step's subject, unless it uses the welcome email"),
	previewText: z.string().max(300).optional().describe("The line inboxes show after the subject"),
	markdown: z.string().max(100_000).optional().describe("The step's content, in Markdown"),
});
const stepsInput = z
	.array(stepInput)
	.min(1)
	.max(MAX_SEQUENCE_STEPS)
	.describe(`The steps in order, ${MAX_SEQUENCE_STEPS} at most. They replace the saved ones.`);
const nameInput = z.string().trim().min(1).max(100).describe("The sequence's name");
const slugInput = z
	.string()
	.trim()
	.min(1)
	.max(40)
	.describe("Lowercase letters, numbers and dashes, unique in the newsletter: add_contact's sequence takes it");
const statusInput = z
	.enum(STATUSES)
	.describe("draft or paused: no new enrollments. active: signups that name it join. Saving publishes nothing: start_sequence does.");

const StepSchema = z.object({
	position: z.number().int(),
	delayDays: z.number().int(),
	useWelcome: z.boolean(),
	subject: z.string(),
	previewText: z.string(),
	markdown: z.string(),
});
const StatsSchema = z.object({
	sent: z.number().int(),
	delivered: z.number().int(),
	bounced: z.number().int(),
	complained: z.number().int(),
	failed: z.number().int(),
});
const SequenceSchema = z.object({
	id: z.string(),
	newsletterId: z.string(),
	name: z.string(),
	slug: z.string(),
	status: z.enum(STATUSES),
	pauseReason: z.string().nullable().describe("Why it paused itself: its bounce or complaint rate"),
	steps: z.array(StepSchema),
	stats: StatsSchema,
	createdAt: dateOutput,
	updatedAt: dateOutput,
});
const EnrollmentSchema = z.object({
	id: z.string(),
	contactId: z.string(),
	email: z.string(),
	status: z.enum(ENROLLMENT_STATUSES),
	enrolledAt: dateOutput.describe("When the series started: the signup, or the confirmation click for a pending contact"),
	steps: z.array(
		z.object({ position: z.number().int(), status: z.enum(ENROLLMENT_STEP_STATUSES), scheduledFor: dateOutput, sentAt: dateOutput })
	),
});

function toSequence(sequence) {
	const stats = sequence.stats ?? {};
	return {
		id: String(sequence._id),
		newsletterId: String(sequence.newsletterId),
		name: sequence.name,
		slug: sequence.slug,
		status: sequence.status,
		pauseReason: sequence.pauseReason ?? null,
		steps: (sequence.steps ?? []).map((step) => ({
			position: step.position,
			delayDays: step.delayDays,
			useWelcome: Boolean(step.useWelcome),
			subject: step.subject ?? "",
			previewText: step.previewText ?? "",
			markdown: step.markdown ?? "",
		})),
		stats: Object.fromEntries(["sent", "delivered", "bounced", "complained", "failed"].map((key) => [key, stats[key] ?? 0])),
		createdAt: toIso(sequence.createdAt),
		updatedAt: toIso(sequence.updatedAt),
	};
}

function toEnrollment(enrollment) {
	return {
		id: String(enrollment._id),
		contactId: String(enrollment.contactId),
		email: enrollment.email,
		status: enrollment.status,
		enrolledAt: toIso(enrollment.enrolledAt),
		steps: (enrollment.steps ?? []).map((step) => ({
			position: step.position,
			status: step.status,
			scheduledFor: step.scheduledFor ?? null,
			sentAt: toIso(step.sentAt),
		})),
	};
}

async function findSequence(account, id) {
	const sequence = isObjectIdString(id) ? await Sequence.findOne(scoped(account, { _id: id })).lean() : null;
	if (!sequence) throw actionError("not_found", "Sequence not found");
	return sequence;
}

// The draft's rules, and a step 1 that reuses the welcome email needs one saved.
async function checkDraft(account, newsletterId, input) {
	const draft = normalizeSequenceDraft(input);
	if (!draft.ok) throw actionError("validation_failed", draft.error);
	if (draft.sequence.steps.some((step) => step.useWelcome)) {
		const newsletter = await Newsletter.findOne(scoped(account, { _id: newsletterId })).select({ welcome: 1 }).lean();
		if (!getSavedWelcome(newsletter)) throw actionError("validation_failed", "Save a welcome email on the newsletter before using it as step 1");
	}
	return draft.sequence;
}

async function saveOrConflict(save) {
	try {
		return await save();
	} catch (error) {
		if (error?.code === 11000) throw actionError("conflict", "This slug is already used on that newsletter");
		throw error;
	}
}

async function getSequenceOutput(account, sequence) {
	const enrollments = await Enrollment.find(scoped(account, { sequenceId: sequence._id }))
		.sort({ createdAt: -1 })
		.limit(LISTED_ENROLLMENTS)
		.lean();
	return { ...toSequence(sequence), enrollments: enrollments.map(toEnrollment) };
}

export const sequenceActions = [
	defineAction({
		name: "list_sequences",
		tryWithoutPlan: true,
		title: "List sequences",
		group: GROUP,
		description: "Lists welcome sequences, newest first, with their steps and how many emails they sent.",
		http: { method: "GET", path: "/sequences" },
		readOnly: true,
		input: z.object({ newsletter: newsletterFilterInput }),
		output: z.object({ sequences: z.array(SequenceSchema) }),
		handler: async ({ account, input }) => {
			const newsletter = input.newsletter ? await findNewsletter(account, input.newsletter, { _id: 1 }) : null;
			const sequences = await Sequence.find(scoped(account, newsletter ? { newsletterId: newsletter._id } : {}))
				.sort({ createdAt: -1, _id: -1 })
				.limit(MAX_SEQUENCES)
				.lean();
			return { sequences: sequences.map(toSequence) };
		},
	}),
	defineAction({
		name: "get_sequence",
		tryWithoutPlan: true,
		title: "Get a sequence",
		group: GROUP,
		description: `Gets one welcome sequence with its steps and its ${LISTED_ENROLLMENTS} latest enrollments, each with the state of every step.`,
		http: { method: "GET", path: "/sequences/{id}" },
		readOnly: true,
		input: z.object({ id: sequenceId }),
		output: SequenceSchema.extend({ enrollments: z.array(EnrollmentSchema) }),
		handler: async ({ account, input }) => getSequenceOutput(account, await findSequence(account, input.id)),
	}),
	defineAction({
		name: "create_sequence",
		tryWithoutPlan: true,
		title: "Create a sequence",
		group: GROUP,
		description:
			"Creates a welcome sequence: steps sent a number of days after a contact joins it, or after they confirm when the newsletter asks them to. Contacts join it through add_contact's sequence, and its emails replace the welcome email. Nothing is sent until start_sequence.",
		http: { method: "POST", path: "/sequences", status: 201 },
		example: { name: "Welcome", slug: "welcome", steps: [{ delayDays: 1, subject: "Day one", markdown: "Hello" }] },
		input: z.object({ newsletter: newsletterInput, name: nameInput, slug: slugInput, status: statusInput.optional(), steps: stepsInput }),
		output: SequenceSchema,
		handler: async ({ account, input }) => {
			const newsletter = await findNewsletter(account, input.newsletter, { _id: 1 });
			const draft = await checkDraft(account, newsletter._id, input);
			const created = await saveOrConflict(() => Sequence.create({ ...draft, accountId: account._id, newsletterId: newsletter._id }));
			return toSequence(created.toObject());
		},
	}),
	defineAction({
		name: "update_sequence",
		tryWithoutPlan: true,
		title: "Update a sequence",
		group: GROUP,
		description:
			"Changes a welcome sequence's name, slug, status or steps; what's left out stays. Steps given replace the saved ones, and contacts already in the series get the new words for the steps not sent yet. Saving publishes nothing: start_sequence does.",
		http: { method: "PATCH", path: "/sequences/{id}" },
		idempotent: true,
		input: z.object({ id: sequenceId, name: nameInput.optional(), slug: slugInput.optional(), status: statusInput.optional(), steps: stepsInput.optional() }),
		output: SequenceSchema,
		handler: async ({ account, input }) => {
			const saved = await findSequence(account, input.id);
			const draft = await checkDraft(account, saved.newsletterId, {
				name: input.name ?? saved.name,
				slug: input.slug ?? saved.slug,
				status: input.status ?? saved.status,
				steps: input.steps ?? saved.steps,
			});
			const updated = await saveOrConflict(() =>
				Sequence.findOneAndUpdate(scoped(account, { _id: saved._id }), { $set: draft }, { returnDocument: "after", runValidators: true }).lean()
			);
			if (!updated) throw actionError("not_found", "Sequence not found");
			return toSequence(updated);
		},
	}),
	defineAction({
		name: "pause_sequence",
		title: "Pause a sequence",
		tryWithoutPlan: true,
		whileBlocked: true,
		group: GROUP,
		description: "Pauses an active welcome sequence: no step is sent and no one joins it until start_sequence. Steps already handed to the email provider still arrive.",
		http: { method: "POST", path: "/sequences/{id}/pause" },
		idempotent: true,
		input: z.object({ id: sequenceId }),
		output: SequenceSchema,
		handler: async ({ account, input }) => {
			const sequence = await findSequence(account, input.id);
			const result = await pauseSequence({ accountId: account._id, sequenceId: sequence._id });
			if (result.error) throw actionError("conflict", result.error);
			return toSequence(await findSequence(account, input.id));
		},
	}),
	defineAction({
		name: "start_sequence",
		title: "Start a sequence",
		group: GROUP,
		description:
			"Starts a welcome sequence, or starts it again after a pause: it takes new contacts, and each contact in it gets their next step at its day, or now when that day has passed. Every step goes through the same checks as any email. Sending can't be undone.",
		http: { method: "POST", path: "/sequences/{id}/start" },
		destructive: true,
		openWorld: true,
		input: z.object({ id: sequenceId }),
		output: SequenceSchema.extend({ scheduled: z.number().int().describe("Contacts whose next step was scheduled") }),
		handler: async ({ account, input }) => {
			assertSendingEnabled();
			const sequence = await findSequence(account, input.id);
			const result = await startSequence({ accountId: account._id, sequenceId: sequence._id });
			if (result.error) throw actionError("conflict", result.error);
			return { ...toSequence(await findSequence(account, input.id)), scheduled: result.scheduled };
		},
	}),
	defineAction({
		name: "cancel_enrollment",
		title: "Cancel an enrollment",
		tryWithoutPlan: true,
		whileBlocked: true,
		group: GROUP,
		description:
			"Takes one contact out of a welcome sequence: none of their steps not yet sent goes out. A step already handed to the email provider can't be pulled back, and the answer says so (inFlight).",
		http: { method: "POST", path: "/enrollments/{id}/cancel" },
		destructive: true,
		idempotent: true,
		input: z.object({ id: idInput("enrollment") }),
		output: z.object({ cancelled: z.boolean(), inFlight: z.boolean().describe("A step was already in flight and still arrives") }),
		handler: async ({ account, input }) => {
			const enrollment = isObjectIdString(input.id) ? await Enrollment.findOne(scoped(account, { _id: input.id })).select({ _id: 1 }).lean() : null;
			if (!enrollment) throw actionError("not_found", "Enrollment not found");
			const result = await cancelEnrollmentById({ accountId: account._id, enrollmentId: enrollment._id });
			if (!result.ok && !result.inFlight) throw actionError("conflict", result.error);
			return { cancelled: true, inFlight: Boolean(result.inFlight) };
		},
	}),
];
