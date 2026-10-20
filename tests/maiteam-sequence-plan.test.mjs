import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseAcceptedSeries } from "../scripts/load-accepted-welcome-series.mjs";
import { commitPlannedState, planEnrollmentCancel, planHandoffRelease, planProviderHandoff } from "../lib/maiteam/sequence-handoff.js";
import {
	DAY_MS,
	getSequenceStepContent,
	httpStatusForOutcome,
	normalizeSequenceDraft,
	resolveStepDelay,
	signupDelivery,
	stepIdempotencyKey,
	stepsFromDashboardFields,
} from "../lib/maiteam/sequence-plan.js";

// The welcome-sequence rules of PATCHES.md P6 that don't touch the database, ported from the old fork's
// tests/sequence-plan.test.mjs and tests/sequence-handoff.test.mjs (its demo mode and per-step looks are not re-ported).

test("a sequence replaces the welcome email and still confirms a pending contact", () => {
	const enrolled = signupDelivery({ contact: { status: "active" }, sequence: { slug: "welcome" }, created: true });
	assert.deepEqual(enrolled, { confirmation: false, welcome: false, enroll: true });
	const pending = signupDelivery({ contact: { status: "pending" }, sequence: { slug: "welcome" }, created: true });
	assert.deepEqual(pending, { confirmation: true, welcome: false, enroll: true });
	assert.equal(signupDelivery({ contact: { status: "active" }, created: true }).welcome, true);
	assert.equal(signupDelivery({ contact: { status: "active" }, sequence: {}, created: false, alreadyEnrolled: true }).enroll, false);
	for (const status of ["unsubscribed", "bounced", "complained", "dormant"]) {
		const blocked = signupDelivery({ contact: { status }, sequence: { slug: "welcome" }, created: true });
		assert.equal(blocked.enroll, false, status);
		assert.equal(blocked.welcome, false, status);
	}
});

test("saved steps are whole days in order; only a welcome-email step 1 is pinned to day 0", () => {
	const saved = normalizeSequenceDraft({
		name: "Welcome",
		slug: "Welcome-Series",
		status: "active",
		steps: [{ delayDays: 0, useWelcome: true }, { delayDays: 1, subject: "Day 1", markdown: "Hello" }, { delayDays: 2, subject: "Day 2", markdown: "Again" }],
	});
	assert.equal(saved.ok, true);
	assert.equal(saved.sequence.slug, "welcome-series");
	assert.deepEqual(saved.sequence.steps.map(({ delayFromEnrollmentMs }) => delayFromEnrollmentMs), [0, DAY_MS, 2 * DAY_MS]);
	const fortuna = normalizeSequenceDraft({ name: "fortuna", slug: "welcome", steps: [{ delayDays: 1, subject: "A", markdown: "B" }, { delayDays: 3, subject: "C", markdown: "D" }] });
	assert.deepEqual(fortuna.sequence.steps.map(({ delayFromEnrollmentMs }) => delayFromEnrollmentMs), [DAY_MS, 3 * DAY_MS], "fortuna: day 1 and day 3 after the click");
	assert.equal(normalizeSequenceDraft({ name: "W", slug: "w", steps: [{ delayDays: 1, useWelcome: true }] }).error, "The welcome email step is sent on day 0");
	assert.match(normalizeSequenceDraft({ name: "W", slug: "w", steps: [{ delayDays: 0, subject: "A", markdown: "B" }, { delayDays: 0, subject: "C", markdown: "D" }] }).error, /one after another/);
	assert.match(normalizeSequenceDraft({ name: "W", slug: "w", steps: [{ delayDays: 0.5, subject: "A", markdown: "B" }] }).error, /whole number/);
	assert.match(normalizeSequenceDraft({ name: "W", slug: "Not a slug!", steps: [{ delayDays: 0, subject: "A", markdown: "B" }] }).error, /Slug/);
	assert.match(normalizeSequenceDraft({ name: "W", slug: "w", steps: Array.from({ length: 7 }, (_, day) => ({ delayDays: day, subject: "A", markdown: "B" })) }).error, /1 to 6 steps/);
	assert.equal(resolveStepDelay(DAY_MS + 1).ok, false);
	assert.equal(stepIdempotencyKey("enr-1", 2), "sequence:enr-1:2");
});

test("a step sends its own words, or the newsletter's saved welcome email", () => {
	const sequence = { steps: [{ position: 1, useWelcome: true }, { position: 2, subject: " Day 2 ", previewText: "", markdown: "Hi" }, { position: 3, subject: "", markdown: "" }] };
	const newsletter = { welcome: { enabled: false, subject: "Welcome", markdown: "Thanks" } };
	assert.deepEqual(getSequenceStepContent(sequence, 1, newsletter), { format: "markdown", subject: "Welcome", markdown: "Thanks", previewText: "" });
	assert.deepEqual(getSequenceStepContent(sequence, 2, newsletter), { format: "markdown", subject: "Day 2", markdown: "Hi", previewText: "" });
	assert.equal(getSequenceStepContent(sequence, 1, {}), null, "no welcome saved, nothing to send");
	assert.equal(getSequenceStepContent(sequence, 3, newsletter), null);
	assert.equal(getSequenceStepContent(sequence, 4, newsletter), null);
});

test("only an unavailable store asks QStash to retry the same job", () => {
	assert.equal(httpStatusForOutcome("unavailable"), 503);
	for (const outcome of ["sent", "duplicate", "cancelled", "retry", "early", "paused", "sending-off", "failed", "suppressed"]) assert.equal(httpStatusForOutcome(outcome), 200, outcome);
});

test("dashboard steps omit a blank step 3, reject a gap, and keep step 1's saved day", () => {
	const one = stepsFromDashboardFields({ step1Subject: "Hello", step1Markdown: "Hi" });
	assert.equal(one.steps.length, 1);
	assert.equal(one.steps[0].delayDays, 0, "a blank day is day 0");
	assert.equal(stepsFromDashboardFields({ step1Subject: "Hello", step1Markdown: "Hi", step3Delay: "2", step3Subject: "Later", step3Markdown: "Again" }).ok, false);
	const later = stepsFromDashboardFields({ step1Delay: "1", step1Subject: "Hello", step1Markdown: "Hi", step2Delay: "3", step2Subject: "Later", step2Markdown: "Again" });
	assert.deepEqual(normalizeSequenceDraft({ name: "W", slug: "w", steps: later.steps }).sequence.steps.map(({ delayDays }) => delayDays), [1, 3]);
});

// The same compare-and-swap as the enrollment store: one version wins, the other reads again.
function memoryEnrollment(initial) {
	let state = { ...initial, steps: initial.steps.map((step) => ({ ...step })), __v: 0 };
	let queue = Promise.resolve();
	return {
		read: async () => ({ ...state, steps: state.steps.map((step) => ({ ...step })) }),
		async compareAndSwap(current, next) {
			let wrote = false;
			queue = queue.then(() => {
				if ((current?.__v ?? 0) !== state.__v) return;
				state = { ...next, steps: next.steps.map((step) => ({ ...step })), __v: state.__v + 1 };
				wrote = true;
			});
			await queue;
			return wrote;
		},
		snapshot: () => state,
	};
}

test("a cancellation before the handoff claim wins: the provider is never entered", async () => {
	const store = memoryEnrollment({ status: "active", steps: [{ position: 1, status: "sending" }, { position: 2, status: "pending" }] });
	const cancel = await commitPlannedState(store, planEnrollmentCancel);
	assert.deepEqual([cancel.ok, cancel.inFlight], [true, false]);
	const handoff = await commitPlannedState(store, (state) => planProviderHandoff(state, { position: 1 }));
	assert.equal(handoff.ok, false);
	assert.deepEqual(store.snapshot().steps.map(({ status }) => status), ["cancelled", "cancelled"]);
});

test("a handoff claimed first stays in flight and the cancellation says so; two racing writes never both win", async () => {
	const store = memoryEnrollment({ status: "active", steps: [{ position: 1, status: "sending" }, { position: 2, status: "scheduled" }] });
	const [handoff, cancel] = await Promise.all([
		commitPlannedState(store, (state) => planProviderHandoff(state, { position: 1 })),
		commitPlannedState(store, planEnrollmentCancel),
	]);
	assert.equal(store.snapshot().status, "cancelled");
	if (handoff.ok) {
		assert.deepEqual([cancel.ok, cancel.inFlight, cancel.error], [false, true, "A send is already in flight"]);
		assert.deepEqual(store.snapshot().steps.map(({ status }) => status), ["in-flight", "cancelled"]);
	} else {
		assert.equal(cancel.ok, true);
		assert.deepEqual(store.snapshot().steps.map(({ status }) => status), ["cancelled", "cancelled"]);
	}
});

test("a send put off before handoff is cancellable again, or cancelled when its enrollment ended meanwhile", () => {
	const active = planHandoffRelease({ status: "active", steps: [{ position: 1, status: "in-flight" }] }, { position: 1 });
	assert.deepEqual([active.ok, active.state.steps[0].status], [true, "sending"]);
	const ended = planHandoffRelease({ status: "cancelled", steps: [{ position: 1, status: "in-flight" }] }, { position: 1 });
	assert.deepEqual([ended.ok, ended.state.steps[0].status], [false, "cancelled"]);
	assert.equal(planHandoffRelease({ status: "active", steps: [{ position: 1, status: "sending" }] }, { position: 1 }).write, false);
	assert.equal(planEnrollmentCancel({ status: "completed", steps: [] }).write, false);
});

test("the series loader parses the accepted 0/3/7 EN/FR layout, and refuses without its arguments or the accepted bytes", () => {
	const block = (language, n, day) =>
		language === "EN"
			? `## EN ${n} — Step ${n} · day ${day}\n\n**Subject:** EN subject ${n}\n**Preview text:** EN preview ${n}\n\nEN body ${n}\n\n---\n\n`
			: `## FR ${n} — Étape ${n} · jour ${day}\n\n**Objet :** FR objet ${n}\n**Texte d'aperçu :** FR aperçu ${n}\n\nFR texte ${n}\n\n---\n\n`;
	const text = ["EN", "FR"].flatMap((language) => [[1, 0], [2, 3], [3, 7]].map(([n, day]) => block(language, n, day))).join("");
	const parsed = parseAcceptedSeries(text);
	assert.deepEqual(parsed.EN.map(({ delayFromEnrollmentMs }) => delayFromEnrollmentMs / DAY_MS), [0, 3, 7]);
	assert.deepEqual(parsed.FR.map(({ subject, previewText, markdown }) => [subject, previewText, markdown])[2], ["FR objet 3", "FR aperçu 3", "FR texte 3"]);

	const script = fileURLToPath(new URL("../scripts/load-accepted-welcome-series.mjs", import.meta.url));
	const run = (args) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8", env: { PATH: process.env.PATH } });
	const bare = run([]);
	assert.equal(bare.status, 1);
	assert.match(bare.stderr, /Usage/);
	const source = join(mkdtempSync(join(tmpdir(), "series-")), "series.md");
	writeFileSync(source, text);
	const unaccepted = run(["--source", source, "--account", "0123456789abcdef01234567", "--newsletter", "letters", "--write"]);
	assert.equal(unaccepted.status, 1);
	assert.match(unaccepted.stderr, /SHA-256 .* Nothing written/);
	assert.equal(run(["--source", source, "--account", "nope", "--newsletter", "letters"]).status, 1);
});
