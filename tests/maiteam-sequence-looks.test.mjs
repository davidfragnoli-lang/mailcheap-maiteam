import assert from "node:assert/strict";
import { test } from "node:test";
import { presetTheme } from "../lib/maiteam/email-look.js";
import { getSequenceStepContent, normalizeSequenceDraft, stepsFromDashboardFields } from "../lib/maiteam/sequence-plan.js";
import { buildRecipientEmail } from "../lib/sending-rules.js";

// P3c on sequence steps: a step's own look, as on the old fork; none is the newsletter's.
const LANDING = { ...presetTheme("landing"), wordmark: "David Fragnoli" };
const newsletter = { _id: "64b000000000000000000001", name: "David Fragnoli", slug: "david", fromEmail: "hello@mail.maiteam.ch", postalAddress: "1 Main St", theme: { preset: "mailcheap" } };
const contact = { _id: "64b000000000000000000003", email: "reader@example.org" };

test("a step keeps a valid look, refuses a broken one, and none is the newsletter's", () => {
	const draft = normalizeSequenceDraft({ name: "w", slug: "w", steps: [{ delayDays: 0, subject: "Hi", markdown: "Hi", look: LANDING }, { delayDays: 3, subject: "Later", markdown: "Later" }] });
	assert.equal(draft.ok, true, draft.error);
	assert.equal(draft.sequence.steps[0].look.preset, "landing");
	assert.equal("look" in draft.sequence.steps[1], false);
	const broken = normalizeSequenceDraft({ name: "w", slug: "w", steps: [{ delayDays: 0, subject: "Hi", markdown: "Hi", look: { ...LANDING, light: { ...LANDING.light, page: "paper" } } }] });
	assert.match(broken.error, /^Step 1: .*hex/);
	const fields = stepsFromDashboardFields({ step1Subject: "Hi", step1Markdown: "Hi", step1Look: LANDING, step2Delay: "3", step2Subject: "Later", step2Markdown: "Later" });
	assert.equal(fields.steps[0].look.preset, "landing");
	assert.equal(fields.steps[1].look, null);
});

test("the step's look reaches the email; without one the newsletter's applies", () => {
	process.env.BETTER_AUTH_SECRET ??= "test-only-signing-value-for-links-0123456789";
	process.env.APP_URL ??= "https://mail.example.com";
	const sequence = { steps: [{ position: 1, subject: "Hi", markdown: "Hello [link](https://davidfragnoli.ch)", look: LANDING }, { position: 2, subject: "Later", markdown: "Later" }] };
	const own = getSequenceStepContent(sequence, 1, newsletter);
	assert.equal(own.look.preset, "landing");
	const { html } = buildRecipientEmail({ campaign: own, newsletter, contact, messageId: null });
	assert.ok(html.includes('bgcolor="#f4f1ea"'), "the landing paper");
	assert.ok(html.includes('>David Fragnoli<span class="dot"'), "the wordmark and its orange full stop");
	const inherited = buildRecipientEmail({ campaign: getSequenceStepContent(sequence, 2, newsletter), newsletter, contact, messageId: null });
	assert.ok(!inherited.html.includes("#f4f1ea"));
	assert.equal(getSequenceStepContent(sequence, 2, newsletter).look, null);
});
