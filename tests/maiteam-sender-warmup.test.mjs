import assert from "node:assert/strict";
import { test } from "node:test";
import { updateDocument } from "../lib/maiteam/document-store.js";
import { DAY_MS, capDocumentId, normalizeCapState, planCapIssue, planCapReservation } from "../lib/maiteam/newsletter-cap.js";
import { normalizeQuotaState } from "../lib/maiteam/send-quota.js";
import {
	WARMUP_LEVELS,
	advanceWarmup,
	decidePromotion,
	describeWarmup,
	effectiveDailyLimit,
	normalizeWarmupState,
	reserveWarmedCap,
	senderDomainOf,
	summarizeStepEvidence,
	warmupDay,
	warmupDocumentId,
} from "../lib/maiteam/sender-warmup.js";

// Synthetic only: in-memory stores, no Mongo, no SES, no QStash, no mail.
const START = Date.parse("2026-11-02T09:30:00.000Z");
const HOUR = 3_600_000;
const FROM = "David <david@mail.davidfragnoli.ch>".replace(/^.*</, "").replace(">", "");

function memoryStore(normalize, initial, { delay = 1 } = {}) {
	let state = normalize(initial);
	let writes = 0;
	return {
		async read() {
			const seen = state;
			if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
			return seen;
		},
		async compareAndSwap(current, next) {
			if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
			if (current.revision !== state.revision) return false;
			state = normalize({ ...next, revision: current.revision + 1 });
			writes += 1;
			return true;
		},
		snapshot: () => state,
		writes: () => writes,
	};
}

// Message rows as `readWarmupEvidence` would stream them for one step.
function rows({ count, from, spacingMs = 60_000, bounced = 0, complained = 0, delivered = true, deliveredLagMs = 5_000 }) {
	return Array.from({ length: count }, (_, index) => {
		const handoffAt = from + index * spacingMs;
		return {
			sesMessageId: `ses-${from}-${index}`,
			handoffAt: new Date(handoffAt),
			status: "delivered",
			deliveredAt: delivered && index >= bounced ? new Date(handoffAt + deliveredLagMs) : null,
			bouncedAt: index < bounced ? new Date(handoffAt + deliveredLagMs) : null,
			complainedAt: index >= bounced && index < bounced + complained ? new Date(handoffAt + HOUR) : null,
		};
	});
}

// A fresh, clean step: `count` mature emails plus one delivered an hour ago.
function cleanEvidence(stepStartedAt, now, count = 120, extra = {}) {
	const mature = rows({ count, from: stepStartedAt, spacingMs: 60_000, ...extra });
	const recent = rows({ count: 1, from: now - HOUR });
	return summarizeStepEvidence([...mature, ...recent], { stepStartedAt, now });
}

function warmupDeps({ fromEmail = FROM, store, evidence = cleanEvidence, alerts = [] } = {}) {
	return {
		fromEmail,
		store,
		readEvidence: ({ stepStartedAt, now }) => evidence(stepStartedAt, now),
		alert: async (payload) => alerts.push(payload),
	};
}

function reserve({ capStore, warmup, cap = 5000, key, amount = 1, now }) {
	return reserveWarmedCap({ capStore, warmup, newsletterCap: cap, key, amount, now });
}

test("levels are 50, 100, 250, 500, 1000 and the limit is the lower of cap and level", () => {
	assert.deepEqual(WARMUP_LEVELS, [50, 100, 250, 500, 1000]);
	const fresh = normalizeWarmupState();
	assert.equal(effectiveDailyLimit({ ok: true, cap: 400 }, fresh), 50);
	assert.equal(effectiveDailyLimit({ ok: true, cap: 20 }, fresh), 20);
	assert.equal(effectiveDailyLimit({ ok: true, cap: 0 }, fresh), 0);
	assert.equal(effectiveDailyLimit({ ok: false }, fresh), null, "warm-up never invents a missing cap");
	assert.equal(effectiveDailyLimit({ ok: true, cap: 400 }, { startedAt: START, level: 3 }), 400);
});

test("day 1 starts at the first successful reservation, and a refused one does not start it", async () => {
	const warmStore = memoryStore(normalizeWarmupState);
	const closedCap = memoryStore(normalizeCapState);
	const refused = await reserve({ capStore: closedCap, warmup: warmupDeps({ store: warmStore }), cap: 0, key: "a", now: START });
	assert.equal(refused.ok, false);
	assert.equal(warmStore.snapshot().startedAt, null);

	const capStore = memoryStore(normalizeCapState);
	const first = await reserve({ capStore, warmup: warmupDeps({ store: warmStore }), key: "a", now: START });
	assert.equal(first.ok, true);
	assert.equal(first.warmup.limit, 50);
	assert.equal(warmStore.snapshot().startedAt, START);
	assert.equal(warmupDay(warmStore.snapshot(), START), 1);
	assert.equal(warmupDay(warmStore.snapshot(), START + DAY_MS - 1), 1);
	assert.equal(warmupDay(warmStore.snapshot(), START + DAY_MS), 2);

	await reserve({ capStore, warmup: warmupDeps({ store: warmStore }), key: "b", now: START + 5 * HOUR });
	assert.equal(warmStore.snapshot().startedAt, START, "a later send does not move day 1");
});

test("timed ramp: each step lasts 7 full days, so 1000/day is reached after 28 days at the earliest", async () => {
	const store = memoryStore(normalizeWarmupState, { startedAt: START, level: 0, levelStartedAt: START });
	const deps = { store, readEvidence: ({ stepStartedAt, now }) => cleanEvidence(stepStartedAt, now) };
	const promotions = [];
	for (let hour = 0; hour <= 40 * 24; hour += 1) {
		const now = START + hour * HOUR;
		const before = store.snapshot().level;
		await advanceWarmup({ ...deps, now: now });
		if (store.snapshot().level !== before) promotions.push({ level: store.snapshot().level, days: (now - START) / DAY_MS });
	}
	assert.deepEqual(
		promotions.map(({ level }) => WARMUP_LEVELS[level]),
		[100, 250, 500, 1000]
	);
	assert.deepEqual(
		promotions.map(({ days }) => days),
		[7, 14, 21, 28],
		"earliest advances after 7, 14, 21 and 28 full days (day 8, 15, 22, 29)"
	);
	assert.equal(store.snapshot().history.length, 4);
	assert.equal(decidePromotion(store.snapshot(), null, START + 60 * DAY_MS).reason, "complete");
});

test("one second short of 7 days holds, even with clean evidence", async () => {
	const store = memoryStore(normalizeWarmupState, { startedAt: START, level: 0, levelStartedAt: START });
	const early = await advanceWarmup({
		store,
		readEvidence: ({ stepStartedAt, now }) => cleanEvidence(stepStartedAt, now),
		now: START + 7 * DAY_MS - 1000,
	});
	assert.equal(early.decision.reason, "too-soon");
	assert.equal(early.decision.eligibleAt, START + 7 * DAY_MS);
	assert.equal(store.snapshot().level, 0);
});

test("a hold never skips a level: after 20 held days the next promotion is one step", async () => {
	const store = memoryStore(normalizeWarmupState, { startedAt: START, level: 0, levelStartedAt: START });
	let clean = false;
	const readEvidence = ({ stepStartedAt, now }) =>
		clean ? cleanEvidence(stepStartedAt, now) : cleanEvidence(stepStartedAt, now, 40);
	for (let day = 7; day <= 27; day += 1) await advanceWarmup({ store, readEvidence, now: START + day * DAY_MS });
	assert.equal(store.snapshot().level, 0);
	assert.equal(store.snapshot().hold.reason, "insufficient");
	clean = true;
	const now = START + 28 * DAY_MS;
	await advanceWarmup({ store, readEvidence, now });
	assert.equal(store.snapshot().level, 1, "100/day, not 1000/day");
	assert.equal(store.snapshot().levelStartedAt, now, "the new step's clock starts at its promotion");
	await advanceWarmup({ store, readEvidence, now: now + 6 * DAY_MS });
	assert.equal(store.snapshot().level, 1);
});

test("boundary ratios: equality holds, strictly below promotes", async () => {
	const at = START + 8 * DAY_MS;
	const state = { startedAt: START, level: 0, levelStartedAt: START };
	const bounceEqual = await cleanEvidence(START, at, 100, { bounced: 1 });
	assert.equal(bounceEqual.mature, 100);
	assert.equal(decidePromotion(state, bounceEqual, at).reason, "bounce", "1/100 is exactly 1%");
	const bounceBelow = await cleanEvidence(START, at, 101, { bounced: 1 });
	assert.equal(decidePromotion(state, bounceBelow, at).promote, true, "1/101 is below 1%");

	const complaintEqual = await cleanEvidence(START, at, 2000, { complained: 1, spacingMs: 1000 });
	assert.equal(complaintEqual.mature, 2000);
	assert.equal(decidePromotion(state, complaintEqual, at).reason, "complaint", "1/2000 is exactly 0.05%");
	const complaintBelow = await cleanEvidence(START, at, 2001, { complained: 1, spacingMs: 1000 });
	assert.equal(decidePromotion(state, complaintBelow, at).promote, true, "1/2001 is below 0.05%");
});

test("zero, missing, malformed, stale, insufficient, incomplete and unresolved evidence all hold", async () => {
	const at = START + 8 * DAY_MS;
	const state = { startedAt: START, level: 0, levelStartedAt: START };
	const reason = (evidence) => decidePromotion(state, evidence, at).reason;

	assert.equal(reason(await summarizeStepEvidence([], { stepStartedAt: START, now: at })), "insufficient");
	assert.equal(reason(null), "missing");
	assert.equal(reason({ mature: "120", bounced: 0, complained: 0 }), "missing");
	assert.equal(reason({ mature: 120.5, bounced: 0 }), "missing");
	assert.equal(reason(await cleanEvidence(START, at, 99)), "insufficient", "99 mature is under 100");

	const old = rows({ count: 150, from: START });
	const stale = await summarizeStepEvidence(old, { stepStartedAt: START, now: at });
	assert.equal(stale.mature, 150);
	assert.equal(reason(stale), "stale", "no delivery result in the last 24 hours");

	const missingDelivery = rows({ count: 150, from: START, delivered: false });
	const recent = rows({ count: 1, from: at - HOUR });
	assert.equal(reason(await summarizeStepEvidence([...missingDelivery, ...recent], { stepStartedAt: START, now: at })), "incomplete");

	const ambiguous = { sesMessageId: null, handoffAt: new Date(START + HOUR), status: "sent" };
	const clean = [...rows({ count: 150, from: START }), ...recent];
	assert.equal(reason(await summarizeStepEvidence([...clean, ambiguous], { stepStartedAt: START, now: at })), "unresolved");
	const provedFailed = { ...ambiguous, status: "failed" };
	assert.equal(decidePromotion(state, await summarizeStepEvidence([...clean, provedFailed], { stepStartedAt: START, now: at }), at).promote, true);

	const future = { mature: 150, bounced: 0, complained: 0, missingOutcome: 0, unresolved: 0, latestResultAt: at + HOUR };
	assert.equal(reason(future), "stale", "a result from the future is not proof of freshness");
});

test("a store that holds history or a hold cannot stand in for evidence", async () => {
	const claimed = {
		startedAt: START,
		level: 0,
		levelStartedAt: START,
		history: [{ level: 0, startedAt: START, endedAt: START, accepted: 5000, bounced: 0, complained: 0 }],
		hold: null,
	};
	const store = memoryStore(normalizeWarmupState, claimed);
	const result = await advanceWarmup({ store, readEvidence: async () => ({ accepted: 5000 }), now: START + 8 * DAY_MS });
	assert.equal(result.decision.reason, "missing");
	assert.equal(store.snapshot().level, 0);
	const thrown = memoryStore(normalizeWarmupState, claimed);
	await advanceWarmup({
		store: thrown,
		readEvidence: async () => {
			throw new Error("Mongo down");
		},
		now: START + 8 * DAY_MS,
	});
	assert.equal(thrown.snapshot().level, 0);
	assert.equal(thrown.snapshot().hold.reason, "missing");
});

test("late and duplicated events: retries count once, outcomes need 72 hours, early bounces still count", async () => {
	const now = START + 8 * DAY_MS;
	const base = rows({ count: 150, from: START });
	const retried = [...base, { ...base[0] }, { ...base[0], bouncedAt: base[0].deliveredAt }, ...rows({ count: 1, from: now - HOUR })];
	const summary = await summarizeStepEvidence(retried, { stepStartedAt: START, now });
	assert.equal(summary.accepted, 151, "duplicate SES ids merge into one message");
	assert.equal(summary.mature, 150);
	assert.equal(summary.bounced, 1, "one bounce, however many deliveries of the event");

	// 120 mature and clean, plus 40 sent in the last 72 hours with two early bounces.
	const young = rows({ count: 40, from: now - 48 * HOUR, bounced: 2 });
	const mixed = await summarizeStepEvidence([...rows({ count: 120, from: START }), ...young], { stepStartedAt: START, now });
	assert.equal(mixed.mature, 120, "young messages are not in the denominator");
	assert.equal(mixed.bounced, 2, "but their bounces count");
	assert.equal(decidePromotion({ startedAt: START, level: 0, levelStartedAt: START }, mixed, now).reason, "bounce");

	// A complaint that lands after the 72-hour line still counts while the step is open.
	const lateComplaint = rows({ count: 2500, from: START, spacingMs: 1000 });
	lateComplaint[10].complainedAt = new Date(now - HOUR);
	lateComplaint[11].complainedAt = new Date(now - 2 * HOUR);
	const late = await summarizeStepEvidence(lateComplaint, { stepStartedAt: START, now });
	assert.equal(late.complained, 2);
	assert.equal(decidePromotion({ startedAt: START, level: 0, levelStartedAt: START }, late, now).reason, "complaint");

	const beforeStep = rows({ count: 5, from: START - DAY_MS, bounced: 5 });
	const scoped = await summarizeStepEvidence(beforeStep, { stepStartedAt: START, now });
	assert.equal(scoped.accepted, 0, "rows from before the step are not this step's evidence");
});

test("retry-safe transitions: 25 parallel checks promote once and a retry adds nothing", async () => {
	const store = memoryStore(normalizeWarmupState, { startedAt: START, level: 1, levelStartedAt: START });
	const now = START + 7 * DAY_MS;
	const readEvidence = ({ stepStartedAt, now: at }) => cleanEvidence(stepStartedAt, at);
	await Promise.all(Array.from({ length: 25 }, () => advanceWarmup({ store, readEvidence, now })));
	assert.equal(store.snapshot().level, 2);
	assert.equal(store.snapshot().history.length, 1);
	await advanceWarmup({ store, readEvidence, now: now + 1000 });
	assert.equal(store.snapshot().level, 2, "the retry is inside the new step's 7 days");

	const starts = memoryStore(normalizeWarmupState);
	const capStore = memoryStore(normalizeCapState);
	await Promise.all(
		Array.from({ length: 10 }, (_, index) =>
			reserve({ capStore, warmup: warmupDeps({ store: starts }), key: `k${index}`, now: START + index })
		)
	);
	assert.equal(starts.snapshot().history.length, 0);
	assert.ok(starts.snapshot().startedAt >= START && starts.snapshot().startedAt <= START + 9);
});

test("a hold caches for 15 minutes, then reads the evidence again", async () => {
	const store = memoryStore(normalizeWarmupState, { startedAt: START, level: 0, levelStartedAt: START });
	let reads = 0;
	const readEvidence = async () => {
		reads += 1;
		return null;
	};
	const now = START + 8 * DAY_MS;
	await advanceWarmup({ store, readEvidence, now });
	await advanceWarmup({ store, readEvidence, now: now + 14 * 60_000 });
	assert.equal(reads, 1);
	await advanceWarmup({ store, readEvidence, now: now + 15 * 60_000 });
	assert.equal(reads, 2);
});

test("a metrics hold alerts only at the existing pause thresholds", async () => {
	const at = START + 8 * DAY_MS;
	const alerts = [];
	const mild = memoryStore(normalizeWarmupState, { startedAt: START, level: 0, levelStartedAt: START });
	await advanceWarmup({ store: mild, readEvidence: () => cleanEvidence(START, at, 150, { bounced: 2 }), alert: async (p) => alerts.push(p), now: at });
	assert.equal(mild.snapshot().hold.reason, "bounce");
	assert.equal(alerts.length, 0, "1.3% holds the step but is under the 2% pause threshold");

	const bad = memoryStore(normalizeWarmupState, { startedAt: START, level: 0, levelStartedAt: START });
	await advanceWarmup({ store: bad, readEvidence: () => cleanEvidence(START, at, 150, { bounced: 4 }), alert: async (p) => alerts.push(p), now: at });
	assert.equal(alerts.length, 1);
	assert.equal(alerts[0].reason, "bounce");
	assert.equal(alerts[0].evidence.bounced, 4);

	const complaints = memoryStore(normalizeWarmupState, { startedAt: START, level: 0, levelStartedAt: START });
	await advanceWarmup({
		store: complaints,
		readEvidence: () => cleanEvidence(START, at, 1200, { complained: 1, spacingMs: 1000 }),
		alert: async (p) => alerts.push(p),
		now: at,
	});
	assert.equal(complaints.snapshot().hold.reason, "complaint");
	assert.equal(alerts.length, 2, "1/1200 is above 0.08%");
});

test("sender identity: case, local part, trailing dot and IDN keep one warm-up; a new domain starts at 50", () => {
	assert.equal(senderDomainOf("David@Mail.DavidFragnoli.CH"), "mail.davidfragnoli.ch");
	assert.equal(senderDomainOf("news@mail.davidfragnoli.ch."), "mail.davidfragnoli.ch");
	assert.equal(senderDomainOf(" hello@mail.davidfragnoli.ch "), "mail.davidfragnoli.ch");
	assert.equal(senderDomainOf("a@bücher.example"), "xn--bcher-kva.example");
	assert.equal(senderDomainOf("a@BÜCHER.example"), "xn--bcher-kva.example");
	for (const bad of ["", null, "no-at", "@mail.example.org", "a@localhost", "a@exa mple.org", "a@-bad.org"]) {
		assert.equal(senderDomainOf(bad), null, String(bad));
	}
	assert.equal(warmupDocumentId("n1", senderDomainOf("X@MAIL.davidfragnoli.ch")), "n1:mail.davidfragnoli.ch");
});

test("sender-change bypass: switching domains shares today's ledger and never resets or raises a level", async () => {
	const now = START + 30 * DAY_MS;
	const warmed = memoryStore(normalizeWarmupState, { startedAt: START, level: 2, levelStartedAt: START + 14 * DAY_MS });
	const stores = new Map([["mail.maiteam.ch", warmed]]);
	const deps = (fromEmail) => {
		const domain = senderDomainOf(fromEmail);
		if (!stores.has(domain)) stores.set(domain, memoryStore(normalizeWarmupState));
		return { fromEmail, store: stores.get(domain), readEvidence: async () => null };
	};
	const capStore = memoryStore(normalizeCapState);
	const held = await reserve({ capStore, warmup: deps("david@mail.maiteam.ch"), key: "batch-1", amount: 200, now });
	assert.equal(held.ok, true);
	assert.equal(held.warmup.limit, 250);

	const moved = await reserve({ capStore, warmup: deps("david@mail.davidfragnoli.ch"), key: "batch-2", now });
	assert.equal(moved.ok, false, "200 already used today; the new domain allows 50");
	assert.equal(moved.warmup.limit, 50);
	assert.equal(stores.get("mail.davidfragnoli.ch").snapshot().startedAt, null);

	const back = await reserve({ capStore, warmup: deps("DAVID@Mail.Maiteam.CH"), key: "batch-3", amount: 50, now });
	assert.equal(back.ok, true, "back on the warmed domain: same document, same level, same ledger");
	assert.equal(back.warmup.level, 2);
	assert.equal(stores.size, 2, "the case change did not create a third warm-up");
	assert.equal(capStore.snapshot().reserved, 250);
	const over = await reserve({ capStore, warmup: deps("other@mail.maiteam.ch"), key: "batch-4", now });
	assert.equal(over.ok, false, "a new local part is the same domain and the same 250");

	const invalid = await reserve({ capStore, warmup: deps("nobody"), key: "batch-5", now });
	assert.equal(invalid.ok, false);
	assert.equal(invalid.reason, "unconfigured");
	const unreadable = await reserveWarmedCap({
		capStore,
		warmup: {
			fromEmail: FROM,
			store: { read: async () => { throw new Error("down"); }, compareAndSwap: async () => false },
			readEvidence: async () => null,
		},
		newsletterCap: 1000,
		key: "batch-6",
		now,
	});
	assert.equal(unreadable.reason, "unavailable");
	assert.equal(capStore.snapshot().reserved, 250, "refusals wrote nothing");
});

test("lower-cap queued grants: a hold from a larger limit is not reused after the limit drops", async () => {
	const now = START + 30 * DAY_MS;
	const capStore = memoryStore(normalizeCapState);
	const warmed = { fromEmail: "a@mail.maiteam.ch", store: memoryStore(normalizeWarmupState, { startedAt: START, level: 3, levelStartedAt: START + 21 * DAY_MS }), readEvidence: async () => null };
	const first = await reserve({ capStore, warmup: warmed, key: "message:1", amount: 1, now });
	await reserve({ capStore, warmup: warmed, key: "campaign-step", amount: 120, now });
	assert.equal(first.ok, true);
	assert.equal(capStore.snapshot().reserved, 121);

	// The worker for message:1 died after reserving. The sender now points at a new domain (50/day).
	const fresh = { fromEmail: "a@mail.davidfragnoli.ch", store: memoryStore(normalizeWarmupState), readEvidence: async () => null };
	const retry = await reserve({ capStore, warmup: fresh, key: "message:1", amount: 1, now });
	assert.equal(retry.ok, false);
	assert.equal(retry.lowered, true);
	assert.equal(retry.reason, "exceeds", "callers defer to the next UTC midnight");
	assert.equal(capStore.snapshot().reserved, 121, "the refusal does not take the owner's hold");

	// The same applies when the configured cap is lowered on the same domain.
	const lowered = await reserve({ capStore, warmup: warmed, key: "message:1", cap: 100, now });
	assert.equal(lowered.ok, false);
	assert.equal(lowered.lowered, true);
	const unchanged = await reserve({ capStore, warmup: warmed, key: "message:1", now });
	assert.equal(unchanged.ok, true);
	assert.equal(unchanged.idempotent, true, "reuse is still idempotent when the limit has room");
	assert.equal(planCapReservation(capStore.snapshot(), { key: "message:1", amount: 1, cap: 120 }).lowered, true);
});

test("midnight: each UTC day has its own ledger under the same warm-up limit", async () => {
	const warmStore = memoryStore(normalizeWarmupState);
	const before = Date.parse("2026-11-02T23:59:59.999Z");
	const after = before + 1;
	assert.notEqual(capDocumentId("n1", before), capDocumentId("n1", after));
	const ledgers = new Map();
	const capFor = (now) => {
		const id = capDocumentId("n1", now);
		if (!ledgers.has(id)) ledgers.set(id, memoryStore(normalizeCapState, undefined, { delay: 0 }));
		return ledgers.get(id);
	};
	let late = 0;
	for (let index = 0; index < 60; index += 1) {
		const result = await reserve({ capStore: capFor(before), warmup: warmupDeps({ store: warmStore }), key: `late-${index}`, now: before });
		if (result.ok) late += 1;
	}
	assert.equal(late, 50);
	const early = await reserve({ capStore: capFor(after), warmup: warmupDeps({ store: warmStore }), key: "early-0", amount: 50, now: after });
	assert.equal(early.ok, true, "the new UTC day has 50 again");
	assert.equal(early.warmup.level, 0, "midnight is not a promotion");
	assert.equal(warmupDay(warmStore.snapshot(), after), 1, "1 ms after the first send is still day 1");
	const lateIssue = await updateDocument(capFor(before), normalizeCapState, (state) => planCapIssue(state, "late-0", 1));
	assert.equal(lateIssue.ok, true, "a hold taken before midnight is issued in its own day document");
});

// The shared-ledger tests across campaign and sequence sends return with the sequences (PATCHES.md P6).

test("dashboard text: warm-up day N, cap X, and a readable hold", async () => {
	const now = START + 9 * DAY_MS + HOUR;
	const state = { startedAt: START, level: 0, levelStartedAt: START };
	const thin = await cleanEvidence(START, now, 42);
	const view = describeWarmup(state, { now, configuredCap: 400, decision: decidePromotion(state, thin, now) });
	assert.equal(view.label, "Warm-up day 10, cap 50");
	assert.equal(view.limit, 50);
	assert.equal(view.holding, true);
	assert.equal(view.status, "Holding: 42 of the 100 emails needed have 3 days of results.");

	const bounce = describeWarmup(state, { now, configuredCap: 400, decision: decidePromotion(state, await cleanEvidence(START, now, 150, { bounced: 2 }), now) });
	assert.equal(bounce.status, "Holding: bounces 1.33%, must be under 1%.");

	const early = describeWarmup(state, { now: START + DAY_MS, configuredCap: 30, decision: decidePromotion(state, null, START + DAY_MS) });
	assert.equal(early.label, "Warm-up day 2, cap 50");
	assert.equal(early.limit, 30);
	assert.equal(early.holding, false);
	assert.match(early.status, /Next step \(100\/day\) no earlier than 2026-11-09 09:30 UTC/);

	const idle = describeWarmup({}, { now, configuredCap: 400, decision: decidePromotion({}, null, now) });
	assert.equal(idle.label, "Warm-up not started, cap 50");
	assert.equal(idle.status, "Starts with the first send from this domain.");
});
