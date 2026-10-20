import "server-only";
import { getSignupProblem } from "@/lib/contacts";
import { connectDb } from "@/lib/db";
import { enrollSignup, findSignupSequence } from "@/lib/maiteam/sequence-store";
import { checkWaitlistSignup } from "@/lib/maiteam/signup-protection";
import { signupInputFor } from "@/lib/maiteam/waitlist-webhook";
import { findSignupNewsletter } from "@/lib/public-newsletters";
import { addSignup } from "@/lib/signups";
import Contact from "@/models/Contact";

// maiteam (PATCHES.md P6): one verified waitlist event, on upstream's own signup path (lib/signups.js addSignup), which
// queues the confirmation email. The product's newsletter is found by its slug, unique across accounts, so the slug
// names the account as well (lib/public-newsletters.js, crossAccount by design, as for every public signup form); a
// newsletter whose account can't take signups is not found. The payload never picks the newsletter or the sequence.
// Answers { status, body }.

// resubscribe is false: a contact who left, or went cold, stays as they are. A waitlist event isn't their consent to come
// back, and upstream's addSignup would make them pending again.
const KEPT_STATUSES = ["unsubscribed", "dormant"];

function reply(status, body) {
	return { status, body };
}

export async function acceptWaitlistSignup({ config, payload }) {
	const input = signupInputFor(config, payload);
	const refusal = await checkWaitlistSignup({ email: input.email, product: config.product, ip: input.ip });
	if (refusal) return reply(refusal.status, { error: refusal.message });
	const emailProblem = await getSignupProblem(input.email);
	if (emailProblem) return reply(400, { error: emailProblem });

	await connectDb();
	const newsletter = await findSignupNewsletter({ slug: input.slug });
	if (!newsletter) return reply(404, { error: "Newsletter not found" });
	// The caller can't vouch for consent, so only a newsletter that asks new subscribers to confirm takes its signups.
	if (newsletter.requireConfirmation !== true) {
		return reply(503, { error: "This newsletter does not ask new subscribers to confirm, so this signup was refused" });
	}
	const sequence = await findSignupSequence({ newsletter, slug: input.sequence });
	if (!sequence) return reply(400, { error: "Sequence not found" });

	const where = { accountId: newsletter.accountId, newsletterId: newsletter._id, email: input.email };
	const existing = await Contact.findOne(where).lean();
	if (existing && !input.resubscribe && KEPT_STATUSES.includes(existing.status)) {
		return reply(200, { id: String(existing._id), status: existing.status, created: false });
	}
	const { isPending, inbox } = await addSignup({ newsletter, email: input.email, source: input.source });
	const contact = await Contact.findOne(where).lean();
	if (!contact) return reply(500, { error: "Signup failed. Try again later" });
	await enrollSignup({ newsletter, contact, created: !existing, sequence, vouchedConsent: false });
	return reply(existing ? 200 : 201, {
		id: String(contact._id),
		status: contact.status,
		created: !existing,
		...(isPending && { inbox }),
	});
}
