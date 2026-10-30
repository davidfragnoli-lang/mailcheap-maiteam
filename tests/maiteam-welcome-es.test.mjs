import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, beforeEach, describe, test } from "node:test";
import { activate, as, callApi, catchRedirect, form, signIn, startTestApp } from "./helpers/app.mjs";
import { memoryReplayStore } from "./helpers/memory-replay-store.mjs";
import { flushAfter } from "./stubs/next-server.mjs";
import { disableSignupProtection } from "./stubs/maiteam-signup-protection.mjs";
import { published } from "./stubs/qstash.mjs";
import { sent as sesEmails } from "./stubs/ses.mjs";
import { resolveWaitlistProduct, signWaitlistBody } from "../lib/maiteam/waitlist-webhook.js";

// fortuna's Spanish waitlist (QI-27851): the es-ES copy built from the QI-27657 lock, and the `fortuna-es` webhook on
// upstream's signup path. Synthetic secret, in-memory replay store, nothing leaves the process.

const DAY = 86_400_000;
const SECRET = "synthetic-es-test-secret-at-least-32-chars";
const ENV = { WAITLIST_WEBHOOK_PRODUCTS: "maifortune,fortuna-es", WAITLIST_SECRET_FORTUNA_ES: SECRET };
const PRODUCT = "fortuna-es";
const COPY = JSON.parse(readFileSync(new URL("../fixtures/maifortune-welcome/copy.maiteam.es.json", import.meta.url), "utf8"));
// The six-hash manifest of QI-27854 (comment 3b52af10), design 846f6f5, which re-locked QI-27657's copy.
const MANIFEST = {
	"01-confirm.es.txt": "ce9dc0c88d98ece3377db9e48abbd31dd8937bf85ce642cb95f3386fc3755f59",
	"01-confirm.es.html": "613e82a43b079efab70d689e16c1be832f505c0a6be4d3d6785365a36ef7a307",
	"02-data.es.txt": "2a6079fdf2f75231b954376b313954e7152bf35fdf3c89b0a8b448fe62decae6",
	"02-data.es.html": "3f2b64adcdf85b5aedb40dd80563ed2d92725c867c19250f11d1c2c19e76d67b",
	"03-agent.es.txt": "6ccf55901afccb57a714784a0c95fbdf0c5fe53b3144e882d43282a3f1ea3418",
	"03-agent.es.html": "f72494643dfe726a8cac32c3dd20171aee96c6d8ebdb5ce73579505ee454271f",
};
const PRIVACY_URL = "https://fortuna.maiteam.ch/privacy?locale=es";

describe("fortuna's es-ES copy", () => {
	test("is built from the six pinned QI-27854 files, with the EN/FR cadence", () => {
		assert.equal(COPY.language, "es");
		assert.match(COPY.source.path, /846f6f57329670586ae1b0017f5cc42257ba6ba2/);
		assert.deepEqual(
			Object.fromEntries(Object.entries(COPY.source.files).map(([file, hash]) => [file.split("/").at(-1), hash])),
			MANIFEST
		);
		assert.deepEqual(COPY.cadence.stepDelaysMs, [DAY, 3 * DAY]);
		assert.deepEqual(COPY.steps.map(({ position, delayDays }) => [position, delayDays]), [[1, 1], [2, 3]]);
		assert.equal(COPY.confirmation.mail.sha256, MANIFEST["01-confirm.es.txt"]);
		assert.deepEqual(COPY.steps.map(({ mail }) => mail.sha256), [MANIFEST["02-data.es.txt"], MANIFEST["03-agent.es.txt"]]);
	});

	test("binds the confirmation button to {{confirm_url}}, has no placeholder left and leaves the footer to mailcheap", () => {
		assert.equal(COPY.confirmation.subject, "Confirma tu correo para fortuna");
		assert.match(COPY.confirmation.markdown, /<a href="\{\{confirm_url\}\}" style="display:inline-block;background:#18181b;[^"]*">Confirmar mi correo<\/a>/);
		assert.doesNotMatch(COPY.confirmation.markdown, /enlace de confirmación/);
		assert.match(COPY.confirmation.markdown, /Tres correos en total, el último con tu invitación\. Nada de boletines\./);
		const mails = [COPY.confirmation, ...COPY.steps];
		const all = mails.map(({ markdown }) => markdown).join("\n");
		// Markdown links are the only brackets left.
		assert.deepEqual(all.replace(/\[[^\]]+\]\(https:\/\/[^)\s]+\)/g, "").match(/\[[^\]]*\]/g), null);
		assert.doesNotMatch(all, /pending QI-|mailto:|Darte de baja|dirección postal/);
		for (const { markdown } of mails) {
			const footer = markdown.split("\n--  \n")[1].split("\n");
			assert.equal(footer.length, 2, "the sender line and the data-protection sentence");
			assert.ok(footer[1].endsWith(`Aviso de privacidad: ${PRIVACY_URL}`));
		}
		assert.match(COPY.steps[1].markdown, /\[Abrir la demo con datos de ejemplo\]\(https:\/\/fortuna\.maiteam\.ch\/demo\?locale=es\)/);
		assert.doesNotMatch(all, /mAIfortune|maifortune\.maiteam\.ch/);
		assert.ok([COPY.confirmation, ...COPY.steps].every(({ alternative }) => alternative.sent === false));
	});
});

describe("fortuna-es waitlist webhook", () => {
	let app;
	let m;
	let user;
	let nextEvent = 0;
	let processed = 0;

	before(async () => {
		app = await startTestApp(ENV);
		m = {
			apiKeys: await import("../app/(app)/api-keys/actions.js"),
			newsletters: await import("../app/(app)/newsletters/actions.js"),
			confirm: await import("../app/confirm/actions.js"),
			route: await import("../app/api/webhooks/waitlist/[product]/route.js"),
			unsubscribeRoute: await import("../app/api/unsubscribe/route.js"),
			replay: await import("../lib/maiteam/webhook-replay-store.js"),
			store: await import("../lib/maiteam/sequence-store.js"),
			confirmation: await import("../lib/confirmation.js"),
			unsubscribe: await import("../lib/unsubscribe.js"),
			gate: await import("../lib/maiteam/send-gate.js"),
			Contact: (await import("../models/Contact.js")).default,
			Enrollment: (await import("../models/Enrollment.js")).default,
			Newsletter: (await import("../models/Newsletter.js")).default,
		};
		user = await signIn("fortuna-es-owner@example.com");
		await activate(user);
		const url = await as(user, () =>
			catchRedirect(m.newsletters.saveNewsletter(null, form({ name: "fortuna", slug: "fortuna-waitlist-es", fromEmail: "hola@fortuna-es.mailcheapmail.com", postalAddress: "1 Main St, Paris" })))
		);
		user.newsletterId = url.split("/").at(-1);
		await m.Newsletter.updateOne({ accountId: user.accountId, _id: user.newsletterId }, { $set: { requireConfirmation: true, confirmation: COPY.confirmation, theme: { preset: "fortuna" } } });
		user.key = (await as(user, () => m.apiKeys.createApiKey(null, form({ name: "Admin", level: "full" })))).key;
		const language = await callApi("PATCH", `/api/v1/newsletters/${user.newsletterId}`, { key: user.key, body: { language: "es" } });
		assert.equal(language.status, 200, JSON.stringify(language.body));
		assert.equal(language.body.language, "es");
		const created = await callApi("POST", "/api/v1/sequences", {
			key: user.key,
			body: { name: "fortuna bienvenida", slug: "welcome", status: "active", steps: COPY.steps.map(({ delayDays, subject, previewText, markdown }) => ({ delayDays, subject, previewText, markdown })) },
		});
		assert.equal(created.status, 201, JSON.stringify(created.body));
	});

	after(() => app?.stop());

	beforeEach(() => {
		m.replay.setReplayStoreForTests(memoryReplayStore());
		m.gate.setSendGateSeamsForTests({ waitForSlot: async () => {} });
		disableSignupProtection();
		processed = published.length;
	});

	async function deliver(email) {
		const rawBody = JSON.stringify({ eventId: `evt-es-${String(++nextEvent).padStart(8, "0")}`, product: PRODUCT, email });
		const timestamp = String(Date.now());
		const request = new Request(`http://localhost:3000/api/webhooks/waitlist/${PRODUCT}`, {
			method: "POST",
			headers: { "content-type": "application/json", "x-waitlist-timestamp": timestamp, "x-waitlist-signature": signWaitlistBody({ secret: SECRET, timestamp, product: PRODUCT, rawBody }) },
			body: rawBody,
		});
		const response = await m.route.POST(request, { params: Promise.resolve({ product: PRODUCT }) });
		await flushAfter();
		return { status: response.status, body: await response.json() };
	}

	async function runStepJobs() {
		const results = [];
		const end = published.length;
		while (processed < end) {
			const job = published[processed++];
			if (!job.url.endsWith("/api/jobs/sequence-step")) continue;
			results.push(await m.store.runSequenceStep({ ...job.body, now: Math.max(Date.now(), job.notBefore * 1000 + 1000) }));
		}
		return results;
	}

	const contactOf = (email) => m.Contact.findOne({ accountId: user.accountId, email }).lean();
	const emailsTo = (email) => sesEmails.filter((sent) => sent.to === email);
	const kindOf = (sent) => sent.tags.find(({ name }) => name === "kind")?.value;
	// QI-27854 option A: mailcheap's own footer in Spanish, with the one working unsubscribe link and the address.
	function assertSpanishFooter(sent) {
		assert.match(sent.html, /<html lang="es">/);
		assert.match(sent.html, /Recibes este correo porque te suscribiste a fortuna\.<br>\n<a href="http[^"]+\/unsubscribe\?token=[^"]+"[^>]*>Darte de baja<\/a><br>1 Main St, Paris/);
		assert.match(sent.text, /Recibes este correo porque te suscribiste a fortuna\.\nDarte de baja: http\S+\/unsubscribe\?token=\S+\n1 Main St, Paris/);
		assert.doesNotMatch(`${sent.html}\n${sent.text}`, /receiving this|Unsubscribe<|Unsubscribe:/);
	}

	test("is off until listed and given its own secret, and maps to the Spanish newsletter only", () => {
		assert.equal(resolveWaitlistProduct(PRODUCT, { WAITLIST_SECRET_FORTUNA_ES: SECRET }), null);
		assert.equal(resolveWaitlistProduct(PRODUCT, { WAITLIST_WEBHOOK_PRODUCTS: PRODUCT, WAITLIST_SECRET_MAIFORTUNE: SECRET }), null, "maifortune's secret doesn't open it");
		assert.equal(resolveWaitlistProduct(PRODUCT, { ...ENV, WAITLIST_SECRET_FORTUNA_ES: "short" }), null);
		const config = resolveWaitlistProduct(PRODUCT, ENV);
		assert.deepEqual([config.newsletter, config.sequence, config.secretEnv], ["fortuna-waitlist-es", "welcome", "WAITLIST_SECRET_FORTUNA_ES"]);
	});

	test("a signup gets only the Spanish confirmation; the series starts at the click, day 1 and day 3", async () => {
		const email = "lectora@fortuna-es.example.org";
		const signup = await deliver(email);
		assert.equal(signup.status, 201, JSON.stringify(signup.body));
		assert.equal(signup.body.status, "pending");
		const [confirmation, ...others] = emailsTo(email);
		assert.equal(others.length, 0, "one email before the click");
		assert.equal(kindOf(confirmation), "confirmation");
		assert.equal(confirmation.subject, "Confirma tu correo para fortuna");
		assert.match(confirmation.html, /href="http[^"]+\/confirm\?token=[^"]+" style="display:inline-block;background:#6e5c96;[^"]*">Confirmar mi correo</);
		assertSpanishFooter(confirmation);
		const contact = await contactOf(email);
		assert.equal(contact.source, "waitlist:fortuna-es");
		let enrollment = await m.Enrollment.findOne({ accountId: user.accountId, contactId: contact._id }).lean();
		assert.equal(enrollment.status, "awaiting_confirmation");
		assert.deepEqual(await runStepJobs(), [], "nothing scheduled before the click");
		const forged = await m.store.runSequenceStep({ accountId: String(user.accountId), enrollmentId: String(enrollment._id), position: 1 });
		assert.equal(forged.outcome, "not-confirmed");

		const token = m.confirmation.createConfirmToken({ contactId: contact._id, newsletterId: contact.newsletterId });
		assert.deepEqual(await m.confirm.confirmSubscription(token), { ok: true });
		await flushAfter();
		enrollment = await m.Enrollment.findById(enrollment._id).setOptions({ crossAccount: true }).lean();
		assert.equal(enrollment.status, "active");
		const [first] = published.slice(processed);
		assert.equal(first.notBefore, Math.floor((enrollment.enrolledAt.getTime() + DAY) / 1000), "day 1 after the click");
		assert.equal((await runStepJobs())[0].outcome, "sent");
		const [second] = published.slice(processed);
		assert.equal(second.notBefore, Math.floor((enrollment.enrolledAt.getTime() + 3 * DAY) / 1000), "day 3 after the click");
		assert.equal((await runStepJobs())[0].outcome, "sent");
		const steps = emailsTo(email).filter((sent) => kindOf(sent) === "sequence");
		assert.deepEqual(steps.map(({ subject }) => subject), COPY.steps.map(({ subject }) => subject));
		assert.ok(steps.every(({ headers }) => headers["List-Unsubscribe-Post"] === "List-Unsubscribe=One-Click"));
		steps.forEach(assertSpanishFooter);
	});

	test("unsubscribed, bounced and complained readers get nothing, and an unsubscribe after step 1 ends the series", async () => {
		const kept = { unsubscribed: "baja@fortuna-es.example.org", bounced: "rebote@fortuna-es.example.org", complained: "queja@fortuna-es.example.org" };
		await m.Contact.create(Object.entries(kept).map(([status, email]) => ({ accountId: user.accountId, newsletterId: user.newsletterId, email, status, subscribedAt: new Date() })));
		for (const [status, email] of Object.entries(kept)) {
			const response = await deliver(email);
			assert.ok(response.status < 300, `${status}: ${JSON.stringify(response.body)}`);
			assert.equal((await contactOf(email)).status, status, "a waitlist signup never brings anyone back");
			assert.equal(emailsTo(email).length, 0, status);
			assert.equal(await m.Enrollment.countDocuments({ accountId: user.accountId, email }), 0, status);
		}

		const leaving = "se-va@fortuna-es.example.org";
		await deliver(leaving);
		const contact = await contactOf(leaving);
		await m.confirm.confirmSubscription(m.confirmation.createConfirmToken({ contactId: contact._id, newsletterId: contact.newsletterId }));
		await flushAfter();
		assert.equal((await runStepJobs())[0].outcome, "sent");
		const token = m.unsubscribe.createUnsubscribeToken({ contactId: contact._id, newsletterId: contact.newsletterId });
		assert.equal((await m.unsubscribeRoute.POST(new Request(`http://localhost:3000/api/unsubscribe?token=${token}`, { method: "POST" }))).status, 200);
		const enrollment = await m.Enrollment.findOne({ accountId: user.accountId, contactId: contact._id }).lean();
		assert.equal(enrollment.status, "cancelled");
		await runStepJobs();
		assert.deepEqual(emailsTo(leaving).map(kindOf), ["confirmation", "sequence"], "no step 2 after the unsubscribe");
	});
});
