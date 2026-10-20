"use server";

import { headers } from "next/headers";
import { keepContact } from "@/lib/contacts";
import { recordPendingAction } from "@/lib/maiteam/cutover";
import { connectDb } from "@/lib/db";
import { verifyKeepToken } from "@/lib/last-chance";
import { findNewsletterAnywhere } from "@/lib/public-newsletters";
import { getClientIp, isRateLimited } from "@/lib/rate-limit";

// People click from home and office networks; a shared one still fits several readers.
const PER_IP = { name: "keep-ip", limit: 20, window: "10 m" };

export async function keepSending(token) {
	if (await isRateLimited({ ...PER_IP, key: getClientIp(await headers()) })) return { error: "busy" };
	const reference = verifyKeepToken(token);
	if (!reference) return { error: "invalid" };

	await connectDb();
	const newsletter = await findNewsletterAnywhere({ _id: reference.newsletterId });
	const contact = newsletter && (await keepContact({ accountId: newsletter.accountId, ...reference }));
	if (contact) return { ok: true };
	// maiteam (P8d): during the cutover hold, a contact the catch-up hasn't brought yet.
	return (await recordPendingAction("keep", reference)) ? { ok: true } : { error: "invalid" };
}
