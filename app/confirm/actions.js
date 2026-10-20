"use server";

import { after } from "next/server";
import { isSendingEnabled } from "@/lib/config";
import { verifyConfirmToken } from "@/lib/confirmation";
import { confirmContact } from "@/lib/contacts";
import { connectDb } from "@/lib/db";
import { recordPendingAction } from "@/lib/maiteam/cutover";
import { activateAwaitingEnrollments } from "@/lib/maiteam/sequence-store";
import { findOpenNewsletter } from "@/lib/public-newsletters";
import { queueWelcomeEmail } from "@/lib/sending";

export async function confirmSubscription(token) {
	const reference = verifyConfirmToken(token);
	if (!reference) return { error: "invalid" };

	await connectDb();
	const newsletter = await findOpenNewsletter({ _id: reference.newsletterId });
	if (!newsletter) return { error: "invalid" };
	const { contact, confirmed } = await confirmContact({ accountId: newsletter.accountId, ...reference });
	// maiteam (P8d): a signup the old server took after its dump, clicked during the cutover hold: the catch-up confirms it.
	if (!contact && (await recordPendingAction("confirm", reference))) return { ok: true };
	if (contact?.status !== "active") return { error: "invalid" };
	// maiteam (P6): the click starts the contact's welcome sequences, which replace the welcome email. On every click, so
	// one that failed halfway is picked up by the next.
	const { inSequence } = await activateAwaitingEnrollments({ accountId: newsletter.accountId, contact });

	if (confirmed && isSendingEnabled() && !inSequence) {
		// Skipped while the newsletter confirms signups: the confirmation was their one email.
		after(() =>
			queueWelcomeEmail({ newsletter, contact }).catch((error) =>
				console.error(`[confirm] Welcome email for ${contact._id} failed:`, error.message)
			)
		);
	}
	return { ok: true };
}
