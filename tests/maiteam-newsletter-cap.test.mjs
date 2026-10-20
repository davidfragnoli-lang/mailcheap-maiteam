import assert from "node:assert/strict";
import { test } from "node:test";
import { updateDocument } from "../lib/maiteam/document-store.js";
import {
	capDocumentId,
	capRefusalMessage,
	nextUtcDayStart,
	normalizeCapState,
	planCapIssue,
	planCapRelease,
	planCapReservation,
	readDailyCap,
	readNewsletterDailyCap,
	utcDayKey,
} from "../lib/maiteam/newsletter-cap.js";

const NOW = Date.parse("2026-10-14T23:59:59.999Z");

function memoryStore() {
	let state = normalizeCapState();
	return {
		async read() {
			return state;
		},
		async compareAndSwap(current, next) {
			if (current.revision !== state.revision) return false;
			state = normalizeCapState({ ...next, revision: current.revision + 1 });
			return true;
		},
		snapshot() {
			return state;
		},
	};
}

function reserve(store, key, amount, cap) {
	return updateDocument(store, normalizeCapState, (state) => planCapReservation(state, { key, amount, cap }));
}

test("the daily cap window is the UTC calendar day", () => {
	assert.equal(utcDayKey(NOW), "2026-10-14");
	assert.equal(nextUtcDayStart(NOW), Date.parse("2026-10-15T00:00:00.000Z"));
	assert.equal(capDocumentId("news-1", NOW), "news-1:2026-10-14");
	assert.equal(capDocumentId("news-1", nextUtcDayStart(NOW)), "news-1:2026-10-15");
});

test("a cap is the newsletter value, then the env value, otherwise unconfigured", () => {
	assert.deepEqual(readDailyCap({ newsletterCap: 25, envCap: 100 }), { ok: true, cap: 25, source: "newsletter" });
	assert.deepEqual(readDailyCap({ newsletterCap: 0, envCap: 100 }), { ok: true, cap: 0, source: "newsletter" });
	assert.deepEqual(readDailyCap({ envCap: 40 }), { ok: true, cap: 40, source: "env" });
	assert.equal(readDailyCap({ newsletterCap: 1.5, envCap: null }).ok, false);
	assert.equal(readNewsletterDailyCap({ NEWSLETTER_DAILY_CAP: "40" }), 40);
	assert.equal(readNewsletterDailyCap({ NEWSLETTER_DAILY_CAP: "6.5" }), null);
	assert.equal(readNewsletterDailyCap({}), null);
});

test("the same key reserves once and an oversized amount is refused whole", async () => {
	const store = memoryStore();
	const first = await reserve(store, "step-1", 1, 2);
	assert.equal(first.ok, true);
	assert.equal(first.added, 1);
	const again = await reserve(store, "step-1", 1, 2);
	assert.equal(again.idempotent, true);
	assert.equal(again.added, 0);
	assert.equal(store.snapshot().reserved, 1);

	const tooBig = await reserve(store, "step-2", 2, 2);
	assert.equal(tooBig.ok, false);
	assert.equal(tooBig.reason, "exceeds");
	assert.match(tooBig.message, /needs 2 emails and 1 remain/);
	assert.match(capRefusalMessage("none-left", { remaining: 0, amount: 1 }), /0 remain/);
	assert.equal(store.snapshot().reserved, 1);
});

test("zero, missing, and a full cap refuse without a partial hold", async () => {
	const closed = memoryStore();
	const zero = await reserve(closed, "a", 1, 0);
	assert.equal(zero.reason, "none-left");
	assert.equal(closed.snapshot().reserved, 0);

	const missing = await reserve(memoryStore(), "a", 1, null);
	assert.equal(missing.reason, "unconfigured");
	assert.match(missing.message, /no daily send cap/);

	const full = memoryStore();
	assert.equal((await reserve(full, "a", 1, 1)).ok, true);
	const second = await reserve(full, "b", 1, 1);
	assert.equal(second.reason, "none-left");
	assert.equal(full.snapshot().holds.length, 1);
});

test("issuing keeps the slot counted and releasing gives it back", async () => {
	const store = memoryStore();
	await reserve(store, "a", 1, 2);
	const issued = await updateDocument(store, normalizeCapState, (state) => planCapIssue(state, "a", 1));
	assert.equal(issued.ok, true);
	assert.equal(store.snapshot().issued, 1);
	assert.equal(store.snapshot().reserved, 1);
	assert.equal(store.snapshot().holds.length, 0);

	await reserve(store, "b", 1, 2);
	const released = await updateDocument(store, normalizeCapState, (state) => planCapRelease(state, "b", 1));
	assert.equal(released.ok, true);
	assert.equal(store.snapshot().reserved, 1);
	const reused = await reserve(store, "c", 1, 2);
	assert.equal(reused.ok, true);
	assert.equal(store.snapshot().reserved, 2);
});

test("yesterday's full document is not today's document", async () => {
	const yesterday = memoryStore();
	await reserve(yesterday, "a", 1, 1);
	const today = memoryStore();
	const next = await reserve(today, "a", 1, 1);
	assert.equal(next.ok, true);
	assert.equal(yesterday.snapshot().reserved, 1);
	assert.equal(today.snapshot().reserved, 1);
});
