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
