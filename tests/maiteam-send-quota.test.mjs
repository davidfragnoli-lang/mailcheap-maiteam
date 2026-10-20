import assert from "node:assert/strict";
import { test } from "node:test";
import {
	assessSesQuota,
	normalizeQuotaState,
	planBatch,
	planDropIssued,
	planIssueFromKey,
	planReleaseKey,
	planReservation,
	planReturnIssued,
	reconcileQuota,
	updateQuota,
} from "../lib/maiteam/send-quota.js";

const NOW = 1_700_000_000_000;

function fresh(over = {}) {
	return { max24HourSend: 200, sentLast24Hours: 0, fetchedAt: NOW, now: NOW, ...over };
}

function memoryStore() {
	let state = normalizeQuotaState();
	return {
		async read() {
			const seen = state;
			await new Promise((resolve) => setTimeout(resolve, 2));
			return seen;
		},
		async compareAndSwap(current, next) {
			await new Promise((resolve) => setTimeout(resolve, 2));
			if (current.revision !== state.revision) return false;
			state = normalizeQuotaState({ ...next, revision: current.revision + 1 });
			return true;
		},
	};
}

function reserve(store, key, amount, quota = fresh()) {
	return updateQuota(store, (state) => planReservation(state, { ...quota, key, amount }));
}

test("quota below, equal to, and above the eligible audience", async () => {
	const store = memoryStore();
	const below = await reserve(store, "below", 10, fresh({ max24HourSend: 200, sentLast24Hours: 50 }));
	assert.equal(below.ok, true);
	assert.equal(below.remaining, 140);
	assert.equal((await store.read()).reserved, 10);

	const equalStore = memoryStore();
	const equal = await reserve(equalStore, "equal", 25, fresh({ max24HourSend: 200, sentLast24Hours: 175 }));
	assert.equal(equal.ok, true);
	assert.equal(equal.remaining, 0);

	const above = await reserve(equalStore, "above", 1, fresh({ max24HourSend: 200, sentLast24Hours: 175 }));
	assert.equal(above.ok, false);
	assert.equal(above.reason, "none-left");
	assert.match(above.message, /needs 1 emails and 0 remain/);
	assert.equal((await equalStore.read()).reserved, 25);
});

test("zero remaining quota refuses and does not reserve", async () => {
	const store = memoryStore();
	const result = await reserve(store, "zero", 1, fresh({ max24HourSend: 200, sentLast24Hours: 200 }));
	assert.equal(result.ok, false);
	assert.equal(result.reason, "none-left");
	assert.equal((await store.read()).reserved, 0);
});

test("a missing or stale quota refuses before any hold is written", async () => {
	const store = memoryStore();
	const missing = await reserve(store, "missing", 1, fresh({ max24HourSend: Number.NaN }));
	assert.equal(missing.reason, "unavailable");
	assert.match(missing.message, /could not be read/);
	const stale = await reserve(store, "stale", 1, fresh({ fetchedAt: NOW - 120_000 }));
	assert.equal(stale.reason, "stale");
	assert.match(stale.message, /stale/);
	assert.equal((await store.read()).reserved, 0);
	assert.equal(assessSesQuota(fresh({ fetchedAt: NOW - 120_000 })).reason, "stale");
});

test("an oversized audience is refused with the remaining capacity, not shortened", async () => {
	const store = memoryStore();
	const result = await reserve(store, "big", 80, fresh({ max24HourSend: 200, sentLast24Hours: 150 }));
	assert.equal(result.ok, false);
	assert.equal(result.reason, "exceeds");
	assert.match(result.message, /needs 80 emails and 50 remain/);
	assert.match(result.message, /not shortened/);
	assert.equal((await store.read()).reserved, 0);
});

test("concurrent campaigns cannot reserve more than the remaining quota", async () => {
	const store = memoryStore();
	const results = await Promise.all(
		Array.from({ length: 20 }, (_, index) => reserve(store, `spike-${index}`, 20, fresh({ max24HourSend: 200 })))
	);
	assert.equal(results.filter((result) => result.ok).length, 10);
	assert.equal(results.filter((result) => !result.ok).length, 10);
	assert.equal((await store.read()).reserved, 200);
});

test("retrying the same reservation does not take a second hold", async () => {
	const store = memoryStore();
	const first = await reserve(store, "campaign:1:initial", 40);
	const second = await reserve(store, "campaign:1:initial", 40);
	assert.equal(first.ok, true);
	assert.equal(second.idempotent, true);
	assert.equal(second.added, 0);
	assert.equal((await store.read()).reserved, 40);
});

test("a queued reservation is rechecked and deferred when the account no longer covers it", async () => {
	const store = memoryStore();
	assert.equal((await reserve(store, "campaign:9", 80, fresh({ max24HourSend: 100 }))).ok, true);
	const state = await store.read();
	const deferred = planBatch(state, fresh({ max24HourSend: 100, sentLast24Hours: 30, batchSize: 80, alreadyReserved: true }));
	assert.equal(deferred.action, "defer");
	assert.match(deferred.message, /deferred/);
	const issued = planIssueFromKey(state, "campaign:9", 80);
	const absorbed = reconcileQuota(issued.state, { sentLast24Hours: 80 });
	const again = planBatch(absorbed, fresh({ max24HourSend: 100, sentLast24Hours: 80, batchSize: 10, alreadyReserved: false }));
	assert.equal(again.action, "send");
	assert.equal(again.remaining, 20);
});

test("issuing, returning, and dropping a send keeps the reservation from being spent twice", () => {
	let state = planReservation(normalizeQuotaState(), fresh({ key: "signup:1", amount: 1 })).state;
	state = planIssueFromKey(state, "signup:1", 1).state;
	assert.equal(state.reserved, 1);
	assert.equal(state.issued, 1);
	assert.equal(state.holds.length, 0);
	state = planReturnIssued(state, "signup:1", 1).state;
	assert.equal(state.issued, 0);
	assert.equal(state.holds[0].amount, 1);
	state = planIssueFromKey(state, "signup:1", 1).state;
	state = planDropIssued(state, 1).state;
	assert.equal(state.reserved, 0);
	assert.equal(planReleaseKey(state, "signup:1", 1).ok, false);
});

test("the rolling window releases issued sends and keeps unsent holds", () => {
	let state = planReservation(normalizeQuotaState(), fresh({ key: "campaign:hold", amount: 5, sentLast24Hours: 10 })).state;
	state = planIssueFromKey(state, "campaign:hold", 2).state;
	const caughtUp = reconcileQuota(state, { sentLast24Hours: 12 });
	assert.equal(caughtUp.issued, 0);
	assert.equal(caughtUp.reserved, 3);
	const rolled = reconcileQuota(caughtUp, { sentLast24Hours: 0 });
	assert.equal(rolled.reserved, 3);
	assert.equal(rolled.accountedSent, 0);
});

// QA r1 item 1 (FRA-25999): two instances, each with its own cached reading, share one ledger.
function sendOne(state, key, reading) {
	const plan = planReservation(state, { max24HourSend: 102, ...reading, now: reading.fetchedAt + 500, key, amount: 1 });
	if (!plan.ok) return { plan, state };
	return { plan, state: planIssueFromKey(plan.state, key, 1, reading.fetchedAt + 100).state };
}

test("an older reading from another instance cannot rewind the ledger and admit a send past the quota", () => {
	const instanceX = { sentLast24Hours: 100, fetchedAt: NOW };
	const instanceY = { sentLast24Hours: 101, fetchedAt: NOW + 8_000 };
	let state = normalizeQuotaState();
	let step = sendOne(state, "A", instanceX);
	assert.equal(step.plan.ok, true);
	state = step.state;
	step = sendOne(state, "B", instanceY);
	assert.equal(step.plan.ok, true);
	state = step.state;
	// Actual usage is now 102. X's reading is still inside its reuse window and says 100.
	step = sendOne(state, "C", instanceX);
	assert.equal(step.plan.ok, false);
	assert.equal(step.plan.reason, "none-left");
	assert.equal(step.state.accountedSent, 101, "the superseded reading changed nothing");
	assert.equal(step.state.accountedAt, NOW + 8_000);
	// The same holds for the campaign preflight and for the remaining count.
	assert.equal(planBatch(state, { max24HourSend: 102, ...instanceX, now: NOW + 9_000, batchSize: 1, alreadyReserved: false }).action, "defer");
});

test("readings applied in either order leave the same ledger", () => {
	const early = { sentLast24Hours: 100, fetchedAt: NOW };
	const late = { sentLast24Hours: 103, fetchedAt: NOW + 5_000 };
	const base = planIssueFromKey(planReservation(normalizeQuotaState(), { ...fresh(), key: "k", amount: 3 }).state, "k", 3, NOW - 1_000).state;
	const forward = reconcileQuota(reconcileQuota(base, early), late);
	const backward = reconcileQuota(reconcileQuota(base, late), early);
	assert.deepEqual({ ...forward, revision: 0 }, { ...backward, revision: 0 });
	assert.equal(forward.accountedSent, 103);
});

test("genuine rolling expiry gives room back without forgetting sends SES may not have counted yet", () => {
	let state = reconcileQuota(normalizeQuotaState(), { sentLast24Hours: 100, fetchedAt: NOW });
	state = planIssueFromKey(planReservation(state, { max24HourSend: 102, sentLast24Hours: 100, fetchedAt: NOW, now: NOW, key: "A", amount: 1 }).state, "A", 1, NOW + 100).state;
	// A newer, lower reading: old mail left the window. It can't say whether A is in it, so A stays reserved.
	const later = { max24HourSend: 102, sentLast24Hours: 90, fetchedAt: NOW + 60_000, now: NOW + 60_000 };
	const plan = planReservation(state, { ...later, key: "B", amount: 1 });
	assert.equal(plan.ok, true);
	assert.equal(plan.state.issued, 1);
	assert.equal(plan.remaining, 102 - 90 - 1 - 1);
	assert.equal(plan.state.accountedSent, 90);
});

test("a rising count absorbs only sends handed to SES before the reading was taken", () => {
	let state = reconcileQuota(normalizeQuotaState(), { sentLast24Hours: 50, fetchedAt: NOW });
	state = planIssueFromKey(planReservation(state, { ...fresh({ sentLast24Hours: 50 }), key: "late", amount: 1 }).state, "late", 1, NOW + 2_000).state;
	// Someone else's send raised the count, read before "late" was handed off: "late" must stay outstanding.
	const absorbed = reconcileQuota(state, { sentLast24Hours: 51, fetchedAt: NOW + 1_000 });
	assert.equal(absorbed.issued, 1);
	const after = reconcileQuota(absorbed, { sentLast24Hours: 52, fetchedAt: NOW + 3_000 });
	assert.equal(after.issued, 0);
});

test("an issued send leaves the ledger once it is certainly out of the 24-hour window", () => {
	let state = reconcileQuota(normalizeQuotaState(), { sentLast24Hours: 10, fetchedAt: NOW });
	state = planIssueFromKey(planReservation(state, { ...fresh({ sentLast24Hours: 10 }), key: "x", amount: 2 }).state, "x", 2, NOW + 100).state;
	const dayLater = reconcileQuota(state, { sentLast24Hours: 5, fetchedAt: NOW + 24 * 60 * 60 * 1000 });
	assert.equal(dayLater.issued, 2, "exactly 24 hours is not yet certain");
	const past = reconcileQuota(state, { sentLast24Hours: 5, fetchedAt: NOW + 24 * 60 * 60 * 1000 + 101 });
	assert.equal(past.issued, 0);
});

test("a ledger written before issuedLog keeps its issued total", () => {
	const legacy = normalizeQuotaState({ revision: 4, issued: 3, accountedSent: 20, holds: [] });
	assert.equal(legacy.issued, 3);
	assert.deepEqual(legacy.issuedLog, [{ at: null, amount: 3 }]);
	assert.equal(reconcileQuota(legacy, { sentLast24Hours: 19, fetchedAt: NOW }).issued, 3);
	assert.equal(reconcileQuota(legacy, { sentLast24Hours: 23, fetchedAt: NOW }).issued, 0);
});
