import "server-only";
import * as z from "zod";
import { scoped } from "@/lib/account-scope";
import { defineAction } from "@/lib/actions/define-action";
import { actionError } from "@/lib/actions/errors";
import { findNewsletter, idInput, newsletterFilterInput } from "@/lib/actions/shared";
import { MAX_SEQUENCE_STEPS, getSequenceStepContent } from "@/lib/maiteam/sequence-plan";
import { SAMPLE_READER, fillForReader } from "@/lib/merge-tags";
import { TEST_CONTACT_ID, buildRecipientEmail } from "@/lib/sending-rules";
import { isObjectIdString } from "@/lib/validation";
import Contact from "@/models/Contact";
import Message from "@/models/Message";
import Newsletter from "@/models/Newsletter";
import Sequence from "@/models/Sequence";

// maiteam (PATCHES.md P19): what an outside report needs from a newsletter's sending, read only, so a read only key
// (P18) can show it: one sequence step rendered as it is sent, and the emails sent per day with their results. Counts
// and ids only: no address and no contact leaves through these two. Registered in lib/actions/registry.js.

const GROUP = "Reports";
const DAY_MS = 86_400_000;
export const MAX_COUNT_DAYS = 90;
const COUNTED_DAYS = 30;
// Test emails go to the sender, not to a list.
const LIST_KINDS = ["campaign", "last-chance", "welcome", "confirmation", "sequence"];

const isSet = (field) => ({ $gt: [`$${field}`, null] });
const countWhen = (condition) => ({ $sum: { $cond: [condition, 1, 0] } });

const EmailCountSchema = z.object({
	date: z.string().describe("The UTC day the emails went out, YYYY-MM-DD"),
	newsletterId: z.string(),
	kind: z.enum(LIST_KINDS),
	campaignId: z.string().nullable().describe("The issue, for campaign and last-chance emails"),
	sequenceId: z.string().nullable().describe("The welcome sequence, for sequence emails"),
	stepPosition: z.number().int().nullable().describe("The sequence step, from 1"),
	sent: z.number().int(),
	delivered: z.number().int().describe("Of those sent that day, delivered so far"),
	bounced: z.number().int(),
	complained: z.number().int(),
	unsubscribed: z.number().int().describe("Of those sent that day, left through the issue's unsubscribe link (issues only)"),
	opened: z.number().int().nullable().describe("Null when the newsletter sends untracked"),
	clicked: z.number().int().nullable().describe("Null when the newsletter sends untracked"),
});

function toDateKey(date) {
	return date.toISOString().slice(0, 10);
}

async function findSequence(account, id) {
	const sequence = isObjectIdString(id) ? await Sequence.findOne(scoped(account, { _id: id })).lean() : null;
	if (!sequence) throw actionError("not_found", "Sequence not found");
	return sequence;
}

export const reportActions = [
	defineAction({
		name: "preview_sequence_step",
		tryWithoutPlan: true,
		title: "Preview a sequence step",
		group: GROUP,
		description:
			"Shows one step of a welcome sequence as saved, the way a contact gets it, rendered by the code that sends it: the subject, the preview text, the HTML and the plain text, as a sample reader called Jane. Nothing is sent: the links aren't tracked and the unsubscribe link matches nobody.",
		http: { method: "GET", path: "/sequences/{id}/preview" },
		readOnly: true,
		example: { position: 1 },
		input: z.object({
			id: idInput("sequence"),
			position: z.number().int().min(1).max(MAX_SEQUENCE_STEPS).describe("The step, from 1"),
		}),
		output: z.object({
			position: z.number().int(),
			delayDays: z.number().int().describe("Days after the contact joins, or confirms when the newsletter asks them to"),
			useWelcome: z.boolean().describe("The step sends the newsletter's saved welcome email"),
			from: z.string().describe("The newsletter's sender, as inboxes show it"),
			subject: z.string(),
			previewText: z.string().describe("What inboxes show after the subject"),
			html: z.string().describe("The email as they get it"),
			text: z.string().describe("Its plain-text version"),
		}),
		handler: async ({ account, input }) => {
			const sequence = await findSequence(account, input.id);
			const step = sequence.steps?.find((item) => item.position === input.position);
			if (!step) throw actionError("not_found", "Step not found");
			const newsletter = await Newsletter.findOne(scoped(account, { _id: sequence.newsletterId })).lean();
			if (!newsletter) throw actionError("not_found", "Newsletter not found");
			// The send path's own content and email (lib/sending.js getMessageContent and deliver), without a message to track.
			const content = getSequenceStepContent(sequence, input.position, newsletter);
			if (!content) throw actionError("not_found", "This step has no email to show yet");
			const contactFields = account.contactFields ?? [];
			const email = buildRecipientEmail({
				campaign: content,
				newsletter,
				contact: { _id: TEST_CONTACT_ID, email: newsletter.fromEmail, firstName: SAMPLE_READER.firstName, fields: SAMPLE_READER.fields },
				contactFields,
			});
			return {
				position: step.position,
				delayDays: step.delayDays,
				useWelcome: Boolean(step.useWelcome),
				from: email.from,
				subject: email.subject,
				previewText: fillForReader({ previewText: content.previewText ?? "" }, SAMPLE_READER, contactFields).previewText ?? "",
				html: email.html,
				text: email.text,
			};
		},
	}),
	defineAction({
		name: "get_email_counts",
		tryWithoutPlan: true,
		title: "Count emails per day",
		group: GROUP,
		description: `The emails each newsletter sent per UTC day, the last ${COUNTED_DAYS} days unless days picks up to ${MAX_COUNT_DAYS}, today included: one row per day and per issue, sequence step, welcome or confirmation email, with how many of them were delivered, bounced, complained or unsubscribed so far, and opened and clicked where the newsletter tracks them (null where it sends untracked). Then the contacts who unsubscribed from each newsletter per day, whichever way they left. Counts and ids only.`,
		http: { method: "GET", path: "/emails/counts" },
		readOnly: true,
		example: { days: 30 },
		input: z.object({
			newsletter: newsletterFilterInput,
			days: z.number().int().min(1).max(MAX_COUNT_DAYS).optional().describe(`How many days back, today included. Default: ${COUNTED_DAYS}.`),
		}),
		output: z.object({
			from: z.string().describe("First day, YYYY-MM-DD, UTC"),
			to: z.string().describe("Last day, YYYY-MM-DD, UTC: today"),
			emails: z.array(EmailCountSchema).describe("Oldest day first"),
			unsubscribed: z
				.array(z.object({ date: z.string(), newsletterId: z.string(), count: z.number().int() }))
				.describe("Contacts who unsubscribed from a newsletter that UTC day, oldest first"),
		}),
		handler: async ({ account, input }) => {
			const now = new Date();
			const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - ((input.days ?? COUNTED_DAYS) - 1) * DAY_MS);
			const only = input.newsletter ? await findNewsletter(account, input.newsletter, { _id: 1 }) : null;
			const newsletters = await Newsletter.find(scoped(account, only ? { _id: only._id } : {}))
				.select({ _id: 1, tracking: 1 })
				.lean();
			const newsletterIds = newsletters.map(({ _id }) => _id);
			const untracked = new Set(newsletters.filter(({ tracking }) => tracking === false).map(({ _id }) => String(_id)));
			const { accountId } = scoped(account);

			const [emailRows, unsubscribeRows] = await Promise.all([
				Message.aggregate([
					{ $match: { accountId, newsletterId: { $in: newsletterIds }, kind: { $in: LIST_KINDS }, sentAt: { $gte: since } } },
					{
						$group: {
							_id: {
								date: { $dateToString: { date: "$sentAt", format: "%Y-%m-%d", timezone: "UTC" } },
								newsletterId: "$newsletterId",
								kind: "$kind",
								campaignId: "$campaignId",
								sequenceId: "$sequenceId",
								stepPosition: "$stepPosition",
							},
							sent: { $sum: 1 },
							delivered: countWhen(isSet("deliveredAt")),
							bounced: countWhen(isSet("bouncedAt")),
							complained: countWhen(isSet("complainedAt")),
							unsubscribed: countWhen(isSet("unsubscribedAt")),
							opened: countWhen(isSet("openedAt")),
							clicked: countWhen(isSet("clickedAt")),
						},
					},
				]),
				// Every unsubscribe kept in a contact's status history (lib/status-changes.js), so one who came back still counts.
				Contact.aggregate([
					{ $match: { accountId, newsletterId: { $in: newsletterIds }, statusChanges: { $elemMatch: { to: "unsubscribed", at: { $gte: since } } } } },
					{ $unwind: "$statusChanges" },
					{ $match: { "statusChanges.to": "unsubscribed", "statusChanges.at": { $gte: since } } },
					{
						$group: {
							_id: { date: { $dateToString: { date: "$statusChanges.at", format: "%Y-%m-%d", timezone: "UTC" } }, newsletterId: "$newsletterId" },
							count: { $sum: 1 },
						},
					},
				]),
			]);

			const byDate = (a, b) => a.date.localeCompare(b.date) || a.newsletterId.localeCompare(b.newsletterId);
			const emails = emailRows
				.map(({ _id, sent, delivered, bounced, complained, unsubscribed, opened, clicked }) => {
					const newsletterId = String(_id.newsletterId);
					const tracked = !untracked.has(newsletterId);
					return {
						date: _id.date,
						newsletterId,
						kind: _id.kind,
						campaignId: _id.campaignId ? String(_id.campaignId) : null,
						sequenceId: _id.sequenceId ? String(_id.sequenceId) : null,
						stepPosition: Number.isInteger(_id.stepPosition) ? _id.stepPosition : null,
						sent,
						delivered,
						bounced,
						complained,
						unsubscribed,
						opened: tracked ? opened : null,
						clicked: tracked ? clicked : null,
					};
				})
				.sort(
					(a, b) =>
						byDate(a, b) ||
						a.kind.localeCompare(b.kind) ||
						(a.campaignId ?? a.sequenceId ?? "").localeCompare(b.campaignId ?? b.sequenceId ?? "") ||
						(a.stepPosition ?? 0) - (b.stepPosition ?? 0)
				);
			const unsubscribed = unsubscribeRows
				.map(({ _id, count }) => ({ date: _id.date, newsletterId: String(_id.newsletterId), count }))
				.sort(byDate);
			return { from: toDateKey(since), to: toDateKey(now), emails, unsubscribed };
		},
	}),
];
