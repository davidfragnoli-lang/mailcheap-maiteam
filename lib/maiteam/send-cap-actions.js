import "server-only";
import * as z from "zod";
import { scoped } from "@/lib/account-scope";
import { defineAction } from "@/lib/actions/define-action";
import { actionError } from "@/lib/actions/errors";
import { findNewsletter, idInput } from "@/lib/actions/shared";
import { normalizeCapState, readDailyCap, readNewsletterDailyCap } from "@/lib/maiteam/newsletter-cap";
import { decidePromotion, describeWarmup, senderDomainOf } from "@/lib/maiteam/sender-warmup";
import { mongoCapStore, mongoWarmupStore, readWarmupEvidence } from "@/lib/maiteam/stores";
import Newsletter from "@/models/Newsletter";

// maiteam (PATCHES.md P4b): the operator's control over P4's daily cap, as the old fork had it in the newsletter form.
// The cap is the newsletter's own number, or NEWSLETTER_DAILY_CAP when it has none; zero sends nothing, and no number
// in either place refuses every send. The sender domain's warm-up lowers it (lib/maiteam/sender-warmup.js). Reading
// the status changes nothing: a promotion happens only at a send.
export const MAX_DAILY_SEND_CAP = 1_000_000;

export async function readSendCapStatus(newsletter, now = Date.now()) {
	const envCap = readNewsletterDailyCap();
	const configured = readDailyCap({ newsletterCap: newsletter.dailySendCap, envCap });
	const domain = senderDomainOf(newsletter.fromEmail);
	let warmup = null;
	if (domain) {
		const state = await mongoWarmupStore(newsletter._id, domain).read();
		const evidence =
			state.startedAt === null
				? null
				: await readWarmupEvidence({ accountId: newsletter.accountId, newsletterId: newsletter._id, domain, stepStartedAt: state.levelStartedAt, now }).catch(() => null);
		warmup = { domain, ...describeWarmup(state, { now, configuredCap: configured.ok ? configured.cap : null, decision: decidePromotion(state, evidence, now) }) };
	}
	const cap = normalizeCapState(await mongoCapStore(newsletter._id, now).read());
	return {
		dailySendCap: Number.isInteger(newsletter.dailySendCap) ? newsletter.dailySendCap : null,
		envCap,
		source: configured.source,
		limit: configured.ok ? (warmup ? warmup.limit : configured.cap) : null,
		usedToday: cap.reserved,
		warmup: warmup && { domain: warmup.domain, day: warmup.day, cap: warmup.cap, label: warmup.label, status: warmup.status, holding: warmup.holding },
	};
}

const SendCapOutput = z.object({
	id: z.string(),
	dailySendCap: z.number().int().nullable().describe("The newsletter's own cap, or null for NEWSLETTER_DAILY_CAP"),
	envCap: z.number().int().nullable().describe("NEWSLETTER_DAILY_CAP, or null when unset"),
	source: z.string().nullable().describe("newsletter, env, or null: no cap anywhere, every send refused"),
	limit: z.number().int().nullable().describe("Today's limit: the cap lowered by the warm-up. null refuses every send"),
	usedToday: z.number().int().describe("Emails reserved or sent this UTC day"),
	warmup: z
		.object({ domain: z.string(), day: z.number().int().nullable(), cap: z.number().int(), label: z.string(), status: z.string(), holding: z.boolean() })
		.nullable()
		.describe("The sender domain's warm-up, or null without a valid sender address"),
});

const SELECT = { _id: 1, accountId: 1, fromEmail: 1, dailySendCap: 1 };

export const sendCapActions = [
	defineAction({
		name: "get_newsletter_send_cap",
		tryWithoutPlan: true,
		whileBlocked: true,
		title: "Read a newsletter's daily send cap",
		group: "Newsletters",
		description: "The newsletter's daily send cap, today's limit after its sender domain's warm-up, what is used today, and why a warm-up step is holding. Changes nothing.",
		http: { method: "GET", path: "/newsletters/{id}/send-cap" },
		readOnly: true,
		input: z.object({ id: idInput("newsletter").describe("The newsletter's ID or slug") }),
		output: SendCapOutput,
		handler: async ({ account, input }) => {
			const newsletter = await findNewsletter(account, input.id, SELECT);
			return { id: String(newsletter._id), ...(await readSendCapStatus(newsletter)) };
		},
	}),
	defineAction({
		name: "update_newsletter_send_cap",
		tryWithoutPlan: true,
		title: "Set a newsletter's daily send cap",
		group: "Newsletters",
		description:
			"Sets how many emails the newsletter may send in one UTC day, shared by campaigns, signup mail, tests and sequences. 0 sends nothing. null uses NEWSLETTER_DAILY_CAP; with neither, every send is refused. The sender domain's warm-up can lower it further.",
		http: { method: "PATCH", path: "/newsletters/{id}/send-cap" },
		idempotent: true,
		example: { dailySendCap: 50 },
		input: z.object({
			id: idInput("newsletter").describe("The newsletter's ID or slug"),
			dailySendCap: z.number().int().min(0).max(MAX_DAILY_SEND_CAP).nullable().describe("Emails per UTC day, or null for NEWSLETTER_DAILY_CAP"),
		}),
		output: SendCapOutput,
		handler: async ({ account, input }) => {
			const newsletter = await findNewsletter(account, input.id, SELECT);
			const { matchedCount } = await Newsletter.updateOne(
				scoped(account, { _id: newsletter._id }),
				input.dailySendCap === null ? { $unset: { dailySendCap: 1 } } : { $set: { dailySendCap: input.dailySendCap } },
				{ runValidators: true }
			);
			if (!matchedCount) throw actionError("not_found", "Newsletter not found");
			return { id: String(newsletter._id), ...(await readSendCapStatus({ ...newsletter, dailySendCap: input.dailySendCap ?? undefined })) };
		},
	}),
];
