import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, beforeEach, describe, test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { activate, as, callApi, catchNotFound, catchRedirect, form, jsonRequest, signIn, startTestApp } from "./helpers/app.mjs";
import { flushAfter } from "./stubs/next-server.mjs";
import { published } from "./stubs/qstash.mjs";
import { sent as sesEmails, state as sesState } from "./stubs/ses.mjs";

// maiteam's welcome sequences (PATCHES.md P6) through upstream's real paths: add_contact, the confirmation click, the
// QStash step job, upstream's batch and its email events. maiteam's send gates are off here, as for upstream's tests;
// tests/maiteam-sequence-gates.test.mjs runs a step with them on. Nothing leaves the process.

const DAY = 86_400_000;
const COPY = JSON.parse(readFileSync(new URL("../fixtures/maifortune-welcome/copy.maiteam.en.json", import.meta.url), "utf8"));
const SENDER = JSON.parse(readFileSync(new URL("../fixtures/maifortune-welcome/sender.json", import.meta.url), "utf8"));
let app;
let m;
let processed = 0;

before(async () => {
	app = await startTestApp({ QSTASH_CURRENT_SIGNING_KEY: "sig-current", QSTASH_NEXT_SIGNING_KEY: "sig-next" });
	m = {
		apiKeys: await import("../app/(app)/api-keys/actions.js"),
		newsletters: await import("../app/(app)/newsletters/actions.js"),
		sequencesActions: await import("../app/(app)/sequences/actions.js"),
		sequencesPage: await import("../app/(app)/sequences/page.js"),
		sequencePage: await import("../app/(app)/sequences/[id]/page.js"),
		newSequencePage: await import("../app/(app)/sequences/new/page.js"),
		confirm: await import("../app/confirm/actions.js"),
		unsubscribeRoute: await import("../app/api/unsubscribe/route.js"),
		stepRoute: await import("../app/api/jobs/sequence-step/route.js"),
		store: await import("../lib/maiteam/sequence-store.js"),
		events: await import("../lib/email-events.js"),
		confirmation: await import("../lib/confirmation.js"),
		unsubscribe: await import("../lib/unsubscribe.js"),
		gate: await import("../lib/maiteam/send-gate.js"),
		outcomes: await import("../lib/email-provider/outcomes.js"),
		Contact: (await import("../models/Contact.js")).default,
		Enrollment: (await import("../models/Enrollment.js")).default,
		Message: (await import("../models/Message.js")).default,
		Newsletter: (await import("../models/Newsletter.js")).default,
		Sequence: (await import("../models/Sequence.js")).default,
	};
});

after(() => app?.stop());

beforeEach(() => {
	processed = published.length;
	m.gate.setSendGateSeamsForTests({ waitForSlot: async () => {} });
});

async function customer(slug, newsletterFields = {}) {
	const user = await signIn(`${slug}@example.com`);
	await activate(user);
	const url = await as(user, () =>
		catchRedirect(m.newsletters.saveNewsletter(null, form({ name: `${slug} news`, slug, fromEmail: `hello@${slug}.mailcheapmail.com`, postalAddress: "1 Main St, Paris" })))
	);
	user.newsletterId = url.split("/").at(-1);
	user.slug = slug;
	if (Object.keys(newsletterFields).length > 0) await m.Newsletter.updateOne({ accountId: user.accountId, _id: user.newsletterId }, { $set: newsletterFields });
	user.key = (await as(user, () => m.apiKeys.createApiKey(null, form({ name: "Site", level: "full" })))).key;
	return user;
}

async function createSequence(user, body) {
	const response = await callApi("POST", "/api/v1/sequences", { key: user.key, body: { status: "active", ...body } });
	assert.equal(response.status, 201, JSON.stringify(response.body));
	return response.body;
}

async function signUp(user, email, extra = {}) {
	const response = await callApi("POST", "/api/v1/contacts", { key: user.key, body: { email, ...extra } });
	await flushAfter();
	return response;
}

// The step jobs published so far, once each, delivered at their notBefore as QStash would. A job a step publishes
// waits for the next call.
async function runStepJobs() {
	const results = [];
	const end = published.length;
	while (processed < end) {
		const job = published[processed++];
		if (!job.url.endsWith("/api/jobs/sequence-step")) continue;
		const now = Math.max(Date.now(), (job.notBefore ?? 0) * 1000 + 1000);
		results.push({ job, result: await m.store.runSequenceStep({ ...job.body, now }) });
	}
	return results;
}

function stepJobs(from = 0) {
	return published.slice(from).filter(({ url }) => url.endsWith("/api/jobs/sequence-step"));
}

const enrollmentOf = (user, contactId) => m.Enrollment.findOne({ accountId: user.accountId, contactId }).lean();
const contactOf = (user, email) => m.Contact.findOne({ accountId: user.accountId, email }).lean();
const emailsTo = (to) => sesEmails.filter((email) => email.to === to);
const kindOf = (email) => email.tags.find(({ name }) => name === "kind")?.value;

function confirmLink(contact) {
	return m.confirmation.createConfirmToken({ contactId: contact._id, newsletterId: contact.newsletterId });
}

function threeSteps(prefix, days) {
	return days.map((delayDays, index) => ({ delayDays, subject: `${prefix} ${index + 1}`, previewText: `${prefix} preview ${index + 1}`, markdown: `${prefix} body ${index + 1}` }));
}

describe("maiteam welcome sequences", () => {
	test("fortuna's copy: the confirmation at signup in the fortuna look, then steps on day 1 and day 3 after the click", async () => {
		const user = await customer("seq-fortuna", {
			requireConfirmation: true,
			confirmation: COPY.confirmation,
			theme: { preset: SENDER.productionIntent.theme.preset },
		});
		// QA r1 item 8: the intended configuration's look, saved through the API and read back as stored.
		const intended = SENDER.productionIntent.theme;
		assert.deepEqual(intended.look, SENDER.dryRunFixture.theme.look, "the dry-run fixture and the production intent pick the same look");
		const saved = await callApi("PATCH", `/api/v1/newsletters/${user.newsletterId}/email-look`, { key: user.key, body: { look: intended.look } });
		assert.equal(saved.status, 200, JSON.stringify(saved.body));
		const stored = (await m.Newsletter.findOne({ accountId: user.accountId, _id: user.newsletterId }).lean()).theme;
		assert.deepEqual([stored.preset, stored.look.preset, stored.look.product, stored.look.wordmark, stored.look.dark.enabled], ["fortuna", "maiteam", "fortuna", "fortuna", true]);
		await createSequence(user, { name: "fortuna welcome", slug: "welcome", steps: COPY.steps.map(({ delayDays, subject, previewText, markdown }) => ({ delayDays, subject, previewText, markdown })) });
		const reader = "reader@seq-fortuna.example.org";
		const jobsBefore = stepJobs().length;

		const signup = await signUp(user, reader, { sequence: "welcome" });
		assert.equal(signup.status, 201, JSON.stringify(signup.body));
		assert.equal(signup.body.status, "pending");
		const [confirmationEmail, ...others] = emailsTo(reader);
		assert.equal(others.length, 0, "one email at signup");
		assert.equal(kindOf(confirmationEmail), "confirmation");
		assert.equal(confirmationEmail.subject, COPY.confirmation.subject);
		assert.match(confirmationEmail.html, /href="http[^"]+\/confirm\?token=[^"]+" style="display:inline-block;background:#6e5c96;color:#ffffff;/, "the button in fortuna's malva");
		assert.doesNotMatch(confirmationEmail.html, /#18181b/);
		const darkFortuna = /@media \(prefers-color-scheme: dark\)[\s\S]*#ae9cd2/;
		assert.match(confirmationEmail.html, darkFortuna, "the confirmation carries fortuna's dark palette");

		const contact = await contactOf(user, reader);
		let enrollment = await enrollmentOf(user, contact._id);
		assert.equal(enrollment.status, "awaiting_confirmation");
		assert.deepEqual(enrollment.steps.map(({ status }) => status), ["held", "held"]);
		assert.equal(stepJobs().length, jobsBefore, "nothing scheduled before the click");
		const forged = await m.store.runSequenceStep({ accountId: String(user.accountId), enrollmentId: String(enrollment._id), position: 1 });
		assert.equal(forged.outcome, "not-confirmed");

		const clickedAt = Date.now();
		assert.deepEqual(await m.confirm.confirmSubscription(confirmLink(contact)), { ok: true });
		await flushAfter();
		enrollment = await enrollmentOf(user, contact._id);
		assert.equal(enrollment.status, "active");
		assert.ok(enrollment.enrolledAt.getTime() >= clickedAt - 1000);
		const [first] = stepJobs(processed);
		assert.equal(first.body.position, 1);
		assert.equal(first.body.accountId, String(user.accountId), "the job carries its account");
		assert.equal(first.notBefore, Math.floor((enrollment.enrolledAt.getTime() + DAY) / 1000), "day 1 after the click");
		assert.equal(emailsTo(reader).length, 1, "no welcome email after the click");

		let [{ result }] = await runStepJobs();
		assert.equal(result.outcome, "sent", JSON.stringify(result));
		assert.equal(result.key, `sequence:${enrollment._id}:1`);
		const [second] = stepJobs(processed);
		assert.equal(second.body.position, 2);
		assert.equal(second.notBefore, Math.floor((enrollment.enrolledAt.getTime() + 3 * DAY) / 1000), "day 3 after the click");
		[{ result }] = await runStepJobs();
		assert.equal(result.outcome, "sent");

		const sequenceEmails = emailsTo(reader).filter((email) => kindOf(email) === "sequence");
		assert.deepEqual(sequenceEmails.map(({ subject }) => subject), COPY.steps.map(({ subject }) => subject));
		assert.ok(sequenceEmails.every(({ headers }) => headers["List-Unsubscribe-Post"] === "List-Unsubscribe=One-Click"));
		assert.ok(sequenceEmails.every(({ html }) => darkFortuna.test(html) && html.includes("#6e5c96")), "both steps in the fortuna look, light and dark");
		enrollment = await enrollmentOf(user, contact._id);
		assert.equal(enrollment.status, "completed");
		assert.deepEqual(enrollment.steps.map(({ status }) => status), ["sent", "sent"]);
		const messages = await m.Message.find({ accountId: user.accountId, kind: "sequence" }).lean();
		assert.equal(messages.length, 2);
		assert.ok(messages.every((message) => message.sentAt && String(message.enrollmentId) === String(enrollment._id)));

		const redelivered = await m.store.runSequenceStep({ ...first.body, now: Date.now() + 4 * DAY });
		assert.equal(redelivered.outcome, "duplicate");
		assert.equal(emailsTo(reader).length, 3, "a redelivered job sends nothing");
	});

	test("the old fork's EN/FR welcome series on days 0, 3 and 7 replaces the welcome email at signup", async () => {
		const user = await customer("seq-bilingual", { welcome: { enabled: true, subject: "Welcome", markdown: "Thanks for joining." } });
		await createSequence(user, { name: "Welcome, English", slug: "welcome-en", steps: threeSteps("EN", [0, 3, 7]) });
		await createSequence(user, { name: "Bienvenue, français", slug: "welcome-fr", steps: threeSteps("FR", [0, 3, 7]) });
		const readers = { en: "anna@seq-bilingual.example.org", fr: "louis@seq-bilingual.example.org" };
		for (const [language, email] of Object.entries(readers)) {
			assert.equal((await signUp(user, email, { sequence: `welcome-${language}` })).status, 201);
		}
		assert.equal(await m.Message.countDocuments({ accountId: user.accountId, kind: "welcome" }), 0, "no welcome email next to a sequence");

		const offsets = { en: [], fr: [] };
		for (let round = 0; round < 3; round++) {
			for (const { job, result } of await runStepJobs()) {
				assert.equal(result.outcome, "sent", JSON.stringify(result));
				const enrollment = await m.Enrollment.findOne({ accountId: user.accountId, _id: job.body.enrollmentId }).lean();
				const language = enrollment.email === readers.en ? "en" : "fr";
				offsets[language].push(job.notBefore - Math.floor(enrollment.enrolledAt.getTime() / 1000));
			}
		}
		for (const language of ["en", "fr"]) {
			assert.deepEqual(offsets[language].map((seconds) => Math.round(seconds / 86_400)), [0, 3, 7], language);
			assert.deepEqual(emailsTo(readers[language]).map(({ subject }) => subject), [1, 2, 3].map((n) => `${language.toUpperCase()} ${n}`));
		}
		const another = await signUp(user, "noseq@seq-bilingual.example.org");
		assert.equal(another.status, 201);
		assert.equal(await m.Message.countDocuments({ accountId: user.accountId, kind: "welcome" }), 1, "without a sequence the welcome email goes");
	});

	test("a step is sent once: concurrent and early deliveries of its job send nothing more", async () => {
		const user = await customer("seq-once");
		await createSequence(user, { name: "Once", slug: "once", steps: threeSteps("Once", [0, 2]) });
		const reader = "reader@seq-once.example.org";
		await signUp(user, reader, { sequence: "once" });
		const [job] = stepJobs(processed);
		processed = published.length;
		const results = await Promise.all([1, 2, 3].map(() => m.store.runSequenceStep({ ...job.body })));
		assert.deepEqual(results.map(({ outcome }) => outcome).sort(), ["duplicate", "duplicate", "sent"]);
		assert.equal(emailsTo(reader).length, 1);
		assert.equal(await m.Message.countDocuments({ accountId: user.accountId, kind: "sequence" }), 1);

		const enrollment = await m.Enrollment.findOne({ accountId: user.accountId, email: reader }).lean();
		const [next] = stepJobs(processed);
		const early = await m.store.runSequenceStep({ ...next.body, now: Date.now() });
		assert.equal(early.outcome, "early");
		assert.equal(early.retryAt, enrollment.enrolledAt.getTime() + 2 * DAY);
		assert.equal(emailsTo(reader).length, 1, "nothing before its day");
		const [rescheduled] = stepJobs(processed + 1);
		assert.equal(rescheduled.notBefore, Math.floor(early.retryAt / 1000), "published again for its day");
		const results2 = await runStepJobs();
		assert.deepEqual(results2.map(({ result }) => result.outcome), ["sent", "duplicate"], "the step's two jobs send it once");
		assert.equal(emailsTo(reader).length, 2);
	});

	test("a cancellation wins over a send put off before handoff, and a handoff in flight is reported, not pulled back", async () => {
		const user = await customer("seq-cancel");
		await createSequence(user, { name: "Cancel", slug: "cancel", steps: threeSteps("Cancel", [0, 1, 2]) });
		const putOff = "later@seq-cancel.example.org";
		await signUp(user, putOff, { sequence: "cancel" });
		sesState.failNext = { name: "sendSesEmail", error: m.outcomes.providerError(m.outcomes.SEND_OUTCOMES.throttled, "Rate exceeded", { retryAfter: 30 }) };
		let [{ result }] = await runStepJobs();
		assert.equal(result.outcome, "retry", JSON.stringify(result));
		const [retryJob] = stepJobs(processed);
		assert.ok(retryJob.notBefore >= Math.floor(Date.now() / 1000) + 25, "back when the provider has room");
		let enrollment = await m.Enrollment.findOne({ accountId: user.accountId, email: putOff }).lean();
		assert.equal(enrollment.steps[0].status, "sending", "cancellable again until the next try");
		const cancelled = await m.store.cancelEnrollmentById({ accountId: user.accountId, enrollmentId: enrollment._id });
		assert.deepEqual(cancelled, { ok: true, inFlight: false });
		[{ result }] = await runStepJobs();
		assert.equal(result.outcome, "cancelled");
		assert.equal(emailsTo(putOff).length, 0, "the provider never got it");
		const message = await m.Message.findOne({ accountId: user.accountId, enrollmentId: enrollment._id }).lean();
		assert.equal(message.status, "skipped");

		const inFlight = "flight@seq-cancel.example.org";
		await signUp(user, inFlight, { sequence: "cancel" });
		enrollment = await m.Enrollment.findOne({ accountId: user.accountId, email: inFlight }).lean();
		let report;
		// The send slot is taken after the handoff claim, right before the provider call.
		m.gate.setSendGateSeamsForTests({
			waitForSlot: async () => {
				report = await m.store.cancelEnrollmentById({ accountId: user.accountId, enrollmentId: enrollment._id });
			},
		});
		[{ result }] = await runStepJobs();
		assert.deepEqual(report, { ok: false, inFlight: true, error: "A send is already in flight" });
		assert.equal(result.outcome, "sent");
		assert.equal(emailsTo(inFlight).length, 1);
		enrollment = await m.Enrollment.findOne({ accountId: user.accountId, _id: enrollment._id }).lean();
		assert.equal(enrollment.status, "cancelled");
		assert.deepEqual(enrollment.steps.map(({ status }) => status), ["sent", "cancelled", "cancelled"]);
		assert.equal(stepJobs(processed).length, 0, "nothing more scheduled");
	});

	test("an unsubscribe, a hard bounce or a complaint ends the series; an unsubscribe nobody cancelled is caught at the step", async () => {
		const user = await customer("seq-stop");
		await createSequence(user, { name: "Stop", slug: "stop", steps: threeSteps("Stop", [0, 1]) });
		const readers = ["unsub", "bounce", "complaint", "quiet"].map((name) => `${name}@seq-stop.example.org`);
		for (const email of readers) await signUp(user, email, { sequence: "stop" });
		await runStepJobs();
		assert.ok(readers.every((email) => emailsTo(email).length === 1));
		const [unsub, bounce, complaint, quiet] = await Promise.all(readers.map((email) => contactOf(user, email)));
		const messageOf = (contact) => m.Message.findOne({ accountId: user.accountId, kind: "sequence", contactId: contact._id }).lean();

		const token = m.unsubscribe.createUnsubscribeToken({ contactId: unsub._id, newsletterId: unsub.newsletterId });
		const response = await m.unsubscribeRoute.POST(new Request(`http://localhost:3000/api/unsubscribe?token=${token}`, { method: "POST" }));
		assert.equal(response.status, 200);
		const bounced = await messageOf(bounce);
		await m.events.handleEmailEvent({ type: "bounce", bounce: "hard", reason: "smtp; 550 5.1.1 unknown", accountId: String(user.accountId), messageId: String(bounced._id), email: bounce.email });
		const complained = await messageOf(complaint);
		await m.events.handleEmailEvent({ type: "complaint", accountId: String(user.accountId), messageId: String(complained._id), email: complaint.email });
		await m.Contact.updateOne({ accountId: user.accountId, _id: quiet._id }, { $set: { status: "unsubscribed" } });

		for (const contact of [unsub, bounce, complaint]) {
			const enrollment = await enrollmentOf(user, contact._id);
			assert.equal(enrollment.status, "cancelled", contact.email);
			assert.equal(enrollment.steps[1].status, "cancelled", contact.email);
		}
		const outcomes = Object.fromEntries((await runStepJobs()).map(({ job, result }) => [job.body.enrollmentId, result.outcome]));
		const quietEnrollment = await enrollmentOf(user, quiet._id);
		assert.equal(outcomes[String(quietEnrollment._id)], "suppressed");
		assert.equal(quietEnrollment.steps[1].status, "skipped");
		assert.equal(quietEnrollment.status, "cancelled");
		assert.ok(readers.every((email) => emailsTo(email).length === 1), "no second step for any of them");
		const sequence = await m.Sequence.findOne({ accountId: user.accountId, slug: "stop" }).lean();
		assert.equal(sequence.stats.bounced, 1);
		assert.equal(sequence.stats.complained, 1);
	});

	test("a sequence replaces the welcome email after the confirmation click too", async () => {
		const user = await customer("seq-confirm", { requireConfirmation: true });
		await createSequence(user, { name: "Welcome", slug: "welcome", steps: threeSteps("Hello", [0]) });
		const inSeries = "series@seq-confirm.example.org";
		const plain = "plain@seq-confirm.example.org";
		await signUp(user, inSeries, { sequence: "welcome" });
		await signUp(user, plain);
		// Upstream sends a welcome after a click only where new signups don't confirm (a returning contact confirms by email).
		await m.Newsletter.updateOne(
			{ accountId: user.accountId, _id: user.newsletterId },
			{ $set: { requireConfirmation: false, welcome: { enabled: true, subject: "Welcome", markdown: "Thanks for joining." } } }
		);
		for (const email of [inSeries, plain]) {
			assert.deepEqual(await m.confirm.confirmSubscription(confirmLink(await contactOf(user, email))), { ok: true });
		}
		await flushAfter();
		const welcomes = await m.Message.find({ accountId: user.accountId, kind: "welcome" }).lean();
		assert.deepEqual(welcomes.map(({ email }) => email), [plain]);
		const [{ result }] = await runStepJobs();
		assert.equal(result.outcome, "sent");
		assert.deepEqual(emailsTo(inSeries).map(kindOf), ["confirmation", "sequence"]);
	});

	test("while sending is off, signups and clicks are recorded and nothing is scheduled or sent", async () => {
		const user = await customer("seq-off", { requireConfirmation: true });
		await createSequence(user, { name: "Off", slug: "off", steps: threeSteps("Off", [0, 3]) });
		const reader = "reader@seq-off.example.org";
		const jobs = stepJobs().length;
		const previous = process.env.SENDING_ENABLED;
		process.env.SENDING_ENABLED = "false";
		try {
			assert.equal((await signUp(user, reader, { sequence: "off" })).status, 201);
			const contact = await contactOf(user, reader);
			assert.deepEqual(await m.confirm.confirmSubscription(confirmLink(contact)), { ok: true });
			const enrollment = await enrollmentOf(user, contact._id);
			assert.equal(enrollment.status, "active");
			assert.deepEqual(enrollment.steps.map(({ status }) => status), ["held", "held"]);
			assert.equal(stepJobs().length, jobs);
			const started = await callApi("POST", `/api/v1/sequences/${(await m.Sequence.findOne({ accountId: user.accountId }).lean())._id}/start`, { key: user.key });
			assert.equal(started.body.error.code, "sending_disabled", JSON.stringify(started.body));
		} finally {
			process.env.SENDING_ENABLED = previous;
		}
		assert.equal(emailsTo(reader).length, 0);
		const sequence = await m.Sequence.findOne({ accountId: user.accountId }).lean();
		const started = await callApi("POST", `/api/v1/sequences/${sequence._id}/start`, { key: user.key });
		assert.equal(started.status, 200);
		assert.equal(started.body.scheduled, 1, "starting publishes the held first step");
		const [{ result }] = await runStepJobs();
		assert.equal(result.outcome, "sent");
	});

	test("the dashboard creates, edits, starts and pauses a sequence and cancels an enrollment; other accounts see none of it", async () => {
		const user = await customer("seq-dash");
		const steps = [
			{ delayDays: 1, subject: "Day one", previewText: "", markdown: "Hello" },
			{ delayDays: 3, subject: "Day three", previewText: "", markdown: "Again" },
		];
		const url = await as(user, () =>
			catchRedirect(m.sequencesActions.saveSequenceAction(null, form({ name: "Welcome", slug: "welcome", status: "active", newsletter: user.newsletterId, steps: JSON.stringify(steps) })))
		);
		const id = url.split("/").at(-1);
		const edited = await as(user, () => m.sequencesActions.saveSequenceAction(null, form({ id, name: "Welcome series", slug: "welcome", status: "active", steps: JSON.stringify(steps) })));
		assert.equal(edited.ok, true, JSON.stringify(edited));
		const saved = await m.Sequence.findOne({ accountId: user.accountId, _id: id }).lean();
		assert.equal(saved.name, "Welcome series");
		assert.deepEqual(saved.steps.map(({ delayDays, delayFromEnrollmentMs }) => [delayDays, delayFromEnrollmentMs]), [[1, DAY], [3, 3 * DAY]], "step 1 keeps its day");
		const refused = await as(user, () => m.sequencesActions.saveSequenceAction(null, form({ id, name: "W", slug: "welcome", steps: JSON.stringify([{ delayDays: 1, useWelcome: true }]) })));
		assert.match(refused.error, /day 0/);

		await signUp(user, "reader@seq-dash.example.org", { sequence: "welcome" });
		const enrollment = await m.Enrollment.findOne({ accountId: user.accountId }).lean();
		assert.deepEqual(await as(user, () => m.sequencesActions.pauseSequenceAction(id)), { ok: true, inFlight: 0 });
		assert.equal((await runStepJobs())[0].result.outcome, "paused");
		assert.deepEqual(await as(user, () => m.sequencesActions.startSequenceAction(id)), { ok: true, scheduled: 1, waiting: 0 });
		assert.deepEqual(await as(user, () => m.sequencesActions.cancelEnrollmentAction(String(enrollment._id), id)), { ok: true, inFlight: false });
		assert.equal((await runStepJobs()).at(-1).result.outcome, "cancelled");
		assert.equal(emailsTo("reader@seq-dash.example.org").length, 0);

		const other = await customer("seq-other");
		assert.equal((await callApi("GET", `/api/v1/sequences/${id}`, { key: other.key })).status, 404);
		assert.equal((await callApi("POST", `/api/v1/enrollments/${enrollment._id}/cancel`, { key: other.key })).status, 404);
		assert.deepEqual((await callApi("GET", "/api/v1/sequences", { key: other.key })).body.sequences, []);
		const got = await callApi("GET", `/api/v1/sequences/${id}`, { key: user.key });
		assert.equal(got.body.enrollments.length, 1);
		assert.equal(got.body.enrollments[0].status, "cancelled");

		assert.match(renderToStaticMarkup(await as(user, () => m.sequencesPage.default())), /Welcome series.*seq-dash news · welcome/s);
		assert.match(renderToStaticMarkup(await as(user, () => m.newSequencePage.default())), /Step 3/);
		const detail = renderToStaticMarkup(await as(user, () => m.sequencePage.default({ params: Promise.resolve({ id }) })));
		assert.match(detail, /reader@seq-dash\.example\.org/);
		assert.match(detail, /1: cancelled · 2: cancelled/);
		assert.equal(await as(other, () => catchNotFound(m.sequencePage.default({ params: Promise.resolve({ id }) }))), true, "another account's sequence is not found");
	});

	// QA r1 item 2 (FRA-25999): the batch read the sequence as active, then a pause landed before the provider call.
	for (const [label, pause] of [
		["the owner's pause", (user, id) => m.store.pauseSequence({ accountId: user.accountId, sequenceId: id })],
		["the automatic pause on bad rates", (user, id) => m.Sequence.updateOne({ accountId: user.accountId, _id: id }, { $set: { status: "paused", pauseReason: "high rates" } })],
	]) {
		test(`${label}, landing after the batch read the sequence, stops the handoff; resuming sends the step once`, async () => {
			const slug = label.startsWith("the owner") ? "seq-race-owner" : "seq-race-auto";
			const user = await customer(slug);
			const sequence = await createSequence(user, { name: "Race", slug: "race", steps: threeSteps("Race", [0, 1]) });
			const email = `race@${slug}.example.org`;
			await signUp(user, email, { sequence: "race" });
			const find = m.Sequence.find;
			let paused = false;
			m.Sequence.find = function (...args) {
				const query = find.apply(this, args);
				const exec = query.exec.bind(query);
				query.exec = async (...rest) => {
					const found = await exec(...rest);
					m.Sequence.find = find;
					await pause(user, sequence.id);
					paused = true;
					return found;
				};
				return query;
			};
			let result;
			try {
				[{ result }] = await runStepJobs();
			} finally {
				m.Sequence.find = find;
			}
			assert.equal(paused, true, "the pause landed between the content read and the handoff");
			assert.equal(result.outcome, "paused", JSON.stringify(result));
			assert.equal(emailsTo(email).length, 0, "nothing reached the provider");
			let enrollment = await m.Enrollment.findOne({ accountId: user.accountId, email }).lean();
			assert.deepEqual(enrollment.steps.map(({ status }) => status), ["held", "pending"]);
			const message = await m.Message.findOne({ accountId: user.accountId, enrollmentId: enrollment._id }).lean();
			assert.equal(message.status, "queued");

			const started = await m.store.startSequence({ accountId: user.accountId, sequenceId: sequence.id });
			assert.deepEqual(started, { ok: true, scheduled: 1, waiting: 0 });
			const results = await runStepJobs();
			assert.deepEqual(results.map(({ job }) => job.body.position), [1]);
			assert.equal(results[0].result.outcome, "sent");
			assert.equal(emailsTo(email).length, 1);
			assert.equal(await m.Message.countDocuments({ accountId: user.accountId, enrollmentId: enrollment._id, stepPosition: 1 }), 1, "the same email, not a second one");
			enrollment = await m.Enrollment.findOne({ accountId: user.accountId, email }).lean();
			assert.deepEqual(enrollment.steps.map(({ status }) => status), ["sent", "scheduled"]);
		});
	}

	test("a handoff claimed before the pause is reported by the pause, not pulled back", async () => {
		const user = await customer("seq-pause-flight");
		const sequence = await createSequence(user, { name: "Flight", slug: "flight", steps: threeSteps("Flight", [0, 1]) });
		const email = "flight@seq-pause-flight.example.org";
		await signUp(user, email, { sequence: "flight" });
		let report;
		m.gate.setSendGateSeamsForTests({
			waitForSlot: async () => {
				report = await m.store.pauseSequence({ accountId: user.accountId, sequenceId: sequence.id });
			},
		});
		const [{ result }] = await runStepJobs();
		assert.deepEqual(report, { ok: true, inFlight: 1 });
		assert.equal(result.outcome, "sent");
		const enrollment = await m.Enrollment.findOne({ accountId: user.accountId, email }).lean();
		assert.deepEqual(enrollment.steps.map(({ status }) => status), ["sent", "pending"], "nothing after it is scheduled while paused");
	});

	// QA r1 item 3: a retry acknowledged while paused left step 1 `sending` with no job; step 2 must not overtake it.
	test("resuming publishes the earliest unresolved step: a deferred step 1 goes before step 2, an ambiguous or failed one holds it", async () => {
		const user = await customer("seq-resume");
		const sequence = await createSequence(user, { name: "Resume", slug: "resume", steps: threeSteps("Resume", [0, 1]) });
		const email = "deferred@seq-resume.example.org";
		await signUp(user, email, { sequence: "resume" });
		sesState.failNext = { name: "sendSesEmail", error: m.outcomes.providerError(m.outcomes.SEND_OUTCOMES.throttled, "Rate exceeded", { retryAfter: 30 }) };
		let [{ result }] = await runStepJobs();
		assert.equal(result.outcome, "retry");
		await m.store.pauseSequence({ accountId: user.accountId, sequenceId: sequence.id });
		[{ result }] = await runStepJobs();
		assert.equal(result.outcome, "paused", "the retry job is acknowledged while paused");
		let enrollment = await m.Enrollment.findOne({ accountId: user.accountId, email }).lean();
		assert.deepEqual(enrollment.steps.map(({ status }) => status), ["sending", "pending"]);
		assert.equal(stepJobs(processed).length, 0, "step 1 has no job left");

		// Two more enrollments of the same sequence, seeded at an ambiguous and a failed step 1.
		const seeded = [];
		for (const [local, status] of [["inflight", "in-flight"], ["failed", "failed"]]) {
			const contact = await m.Contact.create({ accountId: user.accountId, newsletterId: user.newsletterId, email: `${local}@seq-resume.example.org`, status: "active" });
			seeded.push(
				await m.Enrollment.create({
					accountId: user.accountId,
					sequenceId: sequence.id,
					newsletterId: user.newsletterId,
					contactId: contact._id,
					email: contact.email,
					status: "active",
					enrolledAt: new Date(),
					steps: [
						{ position: 1, status },
						{ position: 2, status: "pending" },
					],
				})
			);
		}

		const started = await m.store.startSequence({ accountId: user.accountId, sequenceId: sequence.id });
		assert.deepEqual(started, { ok: true, scheduled: 1, waiting: 2 });
		const jobs = stepJobs(processed);
		assert.deepEqual(jobs.map(({ body }) => [body.enrollmentId, body.position]), [[String(enrollment._id), 1]]);
		[{ result }] = await runStepJobs();
		assert.equal(result.outcome, "sent");
		assert.equal(emailsTo(email).length, 1);
		enrollment = await m.Enrollment.findOne({ accountId: user.accountId, email }).lean();
		assert.deepEqual(enrollment.steps.map(({ status }) => status), ["sent", "scheduled"]);
		for (const { _id } of seeded) {
			const held = await m.Enrollment.findOne({ accountId: user.accountId, _id }).lean();
			assert.equal(held.steps[1].status, "pending", "step 2 never overtakes an unresolved step 1");
		}
	});

	test("an unknown sequence is refused before the contact is written, and the step job only runs signed, with its account", async () => {
		const user = await customer("seq-refuse");
		const unknown = await signUp(user, "nobody@seq-refuse.example.org", { sequence: "missing" });
		assert.equal(unknown.status, 404);
		assert.equal(await contactOf(user, "nobody@seq-refuse.example.org"), null);

		await createSequence(user, { name: "Welcome", slug: "welcome", steps: threeSteps("Hi", [0]) });
		await signUp(user, "signed@seq-refuse.example.org", { sequence: "welcome" });
		const [job] = stepJobs(processed);
		processed = published.length;
		const post = (body) => m.stepRoute.POST(jsonRequest("/api/jobs/sequence-step", { method: "POST", body }));
		const other = await customer("seq-refuse-other");
		const crossAccount = await (await post({ ...job.body, accountId: String(other.accountId) })).json();
		assert.equal(crossAccount.outcome, "missing", "another account's id finds nothing");
		const response = await post(job.body);
		assert.equal(response.status, 200);
		assert.equal((await response.json()).outcome, "sent");
		const saved = [process.env.QSTASH_CURRENT_SIGNING_KEY];
		delete process.env.QSTASH_CURRENT_SIGNING_KEY;
		try {
			const unsigned = await m.stepRoute.POST(jsonRequest("/api/jobs/sequence-step", { method: "POST", body: job.body }));
			assert.equal(unsigned.status, 503);
		} finally {
			process.env.QSTASH_CURRENT_SIGNING_KEY = saved[0];
		}
	});
});
