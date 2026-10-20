// Rolling 24-hour SES quota for every delivery path.
// SentLast24Hours includes mail this app did not send, and that shrinks what is left.
// A reservation is released only after this ledger handed the send to SES and a later
// account read has absorbed it. Until that read catches up, the reservation stays and
// the app can send less than the account would allow. It must not send more.

export const SES_QUOTA_MAX_AGE_MS = 60_000;

export const SES_ROLLING_WINDOW_MS = 24 * 60 * 60 * 1000;

// issuedLog keeps each issued send with the time it was handed to SES (`at`), oldest first. A ledger written before
// the log existed has only the `issued` total; it becomes one entry with no time, which only a rising count absorbs.
function normalizeIssuedLog(state) {
	if (Array.isArray(state.issuedLog)) {
		return state.issuedLog
			.filter((entry) => entry && Number.isInteger(entry.amount) && entry.amount > 0)
			.map((entry) => ({ at: Number.isFinite(entry.at) ? entry.at : null, amount: entry.amount }));
	}
	return Number.isInteger(state.issued) && state.issued > 0 ? [{ at: null, amount: state.issued }] : [];
}

export function normalizeQuotaState(state = {}) {
	const holds = Array.isArray(state.holds)
		? state.holds
				.filter((hold) => hold && hold.key && Number.isInteger(hold.amount) && hold.amount > 0)
				.map((hold) => ({ key: String(hold.key), amount: hold.amount }))
		: [];
	const issuedLog = normalizeIssuedLog(state);
	const issued = issuedLog.reduce((sum, entry) => sum + entry.amount, 0);
	const accountedSent = Number.isInteger(state.accountedSent) && state.accountedSent >= 0 ? state.accountedSent : null;
	const accountedAt = accountedSent !== null && Number.isFinite(state.accountedAt) ? state.accountedAt : null;
	const revision = Number.isInteger(state.revision) && state.revision >= 0 ? state.revision : 0;
	return {
		revision,
		issued,
		issuedLog,
		accountedSent,
		accountedAt,
		holds,
		reserved: issued + holds.reduce((sum, hold) => sum + hold.amount, 0),
	};
}

function withReserved(state) {
	return normalizeQuotaState(state);
}

export function quotaRefusalMessage(reason, { remaining = 0, eligible = null } = {}) {
	if (reason === "stale") return "SES quota is stale, so this send was refused. Nothing was truncated.";
	if (reason === "unavailable") return "SES quota could not be read, so this send was refused. Nothing was truncated.";
	if (reason === "conflict") return "SES quota reservation was busy. Nothing was sent.";
	if (reason === "deferred") {
		const left = Math.max(0, Math.floor(remaining));
		return `SES quota was rechecked and this batch was deferred. ${left} emails remain in the rolling 24-hour quota. Nothing in the batch was sent.`;
	}
	const left = Math.max(0, Math.floor(Number.isFinite(remaining) ? remaining : 0));
	if (Number.isInteger(eligible)) {
		return `This send needs ${eligible} emails and ${left} remain in the rolling 24-hour quota. It was refused, not shortened.`;
	}
	return `This send has more than ${left} eligible emails and ${left} remain in the rolling 24-hour quota. It was refused, not shortened.`;
}

export function assessSesQuota({
	max24HourSend,
	sentLast24Hours,
	reserved = 0,
	fetchedAt,
	now = Date.now(),
	maxAgeMs = SES_QUOTA_MAX_AGE_MS,
} = {}) {
	const numbersOk =
		Number.isFinite(max24HourSend) &&
		Number.isFinite(sentLast24Hours) &&
		max24HourSend >= 0 &&
		sentLast24Hours >= 0 &&
		Number.isFinite(reserved) &&
		reserved >= 0;
	if (!numbersOk || !Number.isFinite(fetchedAt)) {
		return { ok: false, reason: "unavailable", remaining: 0 };
	}
	if (now - fetchedAt > maxAgeMs || fetchedAt - now > 5_000) {
		return { ok: false, reason: "stale", remaining: 0 };
	}
	const remaining = Math.max(0, Math.floor(max24HourSend) - Math.floor(sentLast24Hours) - Math.floor(reserved));
	return { ok: true, reason: null, remaining };
}

// Several server instances read the account and write one ledger, so a reading can arrive after a newer one was
// accounted. The ledger keeps the time of the reading it accounted (`accountedAt`); an older reading is superseded:
// it changes nothing, and room is judged on the newer count it lost to. This is what stops a cached reading from
// rewinding the count and admitting sends the account no longer has room for.
export function isSupersededReading(state, { sentLast24Hours, fetchedAt } = {}) {
	const current = normalizeQuotaState(state);
	if (current.accountedAt === null || !Number.isFinite(fetchedAt)) return false;
	return fetchedAt < current.accountedAt || (fetchedAt === current.accountedAt && Math.floor(sentLast24Hours) < current.accountedSent);
}

// The count to judge room on: the reading itself, or the ledger's newer one when the reading is superseded.
export function effectiveReading(state, reading = {}) {
	const current = normalizeQuotaState(state);
	if (!isSupersededReading(current, reading)) return { sentLast24Hours: reading.sentLast24Hours, fetchedAt: reading.fetchedAt, superseded: false };
	return { sentLast24Hours: current.accountedSent, fetchedAt: current.accountedAt, superseded: true };
}

function takeOldest(log, amount, { before = Infinity } = {}) {
	let left = amount;
	const kept = [];
	for (const entry of log) {
		const absorbable = left > 0 && (entry.at === null || entry.at <= before);
		if (!absorbable) {
			kept.push(entry);
			continue;
		}
		const take = Math.min(entry.amount, left);
		left -= take;
		if (entry.amount > take) kept.push({ at: entry.at, amount: entry.amount - take });
	}
	return kept;
}

// A newer, higher SentLast24Hours absorbs issued sends, oldest first, but only those handed to SES before the
// reading was taken. A falling count is the rolling window moving on, and it can't say which sends aged out, so it
// releases nothing. An issued send is certainly out of the window 24 hours after it was handed off. Unsent holds stay
// until they are sent or released. Every rule here can under-send; none can send more than the account allows.
export function reconcileQuota(state, { sentLast24Hours, fetchedAt } = {}) {
	const current = normalizeQuotaState(state);
	const sent = Math.floor(sentLast24Hours);
	if (!Number.isInteger(sent) || sent < 0) return current;
	if (isSupersededReading(current, { sentLast24Hours: sent, fetchedAt })) return current;
	const at = Number.isFinite(fetchedAt) ? fetchedAt : null;
	let issuedLog = current.issuedLog;
	if (current.accountedSent !== null && sent > current.accountedSent) {
		issuedLog = takeOldest(issuedLog, sent - current.accountedSent, { before: at ?? Infinity });
	}
	if (at !== null) issuedLog = issuedLog.filter((entry) => entry.at === null || entry.at > at - SES_ROLLING_WINDOW_MS);
	return withReserved({ ...current, issuedLog, accountedSent: sent, accountedAt: at });
}

function refuse(reason, state, extra = {}) {
	return {
		ok: false,
		write: false,
		idempotent: false,
		added: 0,
		reason,
		state: normalizeQuotaState(state),
		remaining: extra.remaining ?? 0,
		message: quotaRefusalMessage(reason, extra),
	};
}

export function planReservation(state, { key, amount, max24HourSend, sentLast24Hours, fetchedAt, now, maxAgeMs } = {}) {
	const current = normalizeQuotaState(state);
	const amountInt = Math.floor(amount);
	if (!key || !Number.isInteger(amountInt) || amountInt < 1) return refuse("unavailable", current);
	const assessment = assessSesQuota({ max24HourSend, sentLast24Hours, reserved: 0, fetchedAt, now, maxAgeMs });
	if (!assessment.ok) return refuse(assessment.reason, current);
	const reconciled = reconcileQuota(current, { sentLast24Hours, fetchedAt });
	({ sentLast24Hours, fetchedAt } = effectiveReading(reconciled, { sentLast24Hours, fetchedAt }));
	const existing = reconciled.holds.find((hold) => hold.key === key);
	const held = existing?.amount ?? 0;
	if (held >= amountInt) {
		// A hold that outlived its send (a retry, a release that failed) is reused only if every reservation, its own
		// included, still fits the account's current room. A hold is idempotency, not permission.
		const budget = Math.floor(max24HourSend) - Math.floor(sentLast24Hours);
		if (reconciled.reserved > budget) {
			return refuse(budget - (reconciled.reserved - held) <= 0 ? "none-left" : "exceeds", current, {
				remaining: Math.max(0, budget - reconciled.reserved),
				eligible: amountInt,
			});
		}
		return {
			ok: true,
			write: true,
			idempotent: true,
			added: 0,
			reason: null,
			state: reconciled,
			remaining: Math.max(0, Math.floor(max24HourSend) - Math.floor(sentLast24Hours) - reconciled.reserved),
			message: null,
		};
	}
	const extra = amountInt - held;
	const room = assessSesQuota({
		max24HourSend,
		sentLast24Hours,
		reserved: reconciled.reserved,
		fetchedAt,
		now,
		maxAgeMs,
	});
	if (extra > room.remaining) {
		return refuse(room.remaining === 0 ? "none-left" : "exceeds", current, {
			remaining: room.remaining,
			eligible: amountInt,
		});
	}
	const holds = existing
		? reconciled.holds.map((hold) => (hold.key === key ? { key, amount: amountInt } : hold))
		: [...reconciled.holds, { key: String(key), amount: amountInt }];
	const next = withReserved({ ...reconciled, holds });
	return {
		ok: true,
		write: true,
		idempotent: false,
		added: extra,
		reason: null,
		state: next,
		remaining: room.remaining - extra,
		message: null,
	};
}

export function planReleaseKey(state, key, amount = 1) {
	const current = normalizeQuotaState(state);
	const amountInt = Math.floor(amount);
	if (!key || !Number.isInteger(amountInt) || amountInt < 1) return { ok: false, write: false, state: current };
	let left = amountInt;
	const holds = [];
	for (const hold of current.holds) {
		if (hold.key !== key || left <= 0) {
			holds.push(hold);
			continue;
		}
		const take = Math.min(hold.amount, left);
		left -= take;
		if (hold.amount > take) holds.push({ key: hold.key, amount: hold.amount - take });
	}
	if (left > 0) return { ok: false, write: false, state: current };
	return { ok: true, write: true, state: withReserved({ ...current, holds }) };
}

// `at` is when the provider took the send. Without it, only a rising count can absorb the entry.
export function planIssueFromKey(state, key, amount = 1, at = null) {
	const released = planReleaseKey(state, key, amount);
	if (!released.ok) return released;
	const entry = { at: Number.isFinite(at) ? at : null, amount: Math.floor(amount) };
	return {
		ok: true,
		write: true,
		state: withReserved({ ...released.state, issuedLog: [...released.state.issuedLog, entry] }),
	};
}

// Takes back the most recent issued sends: the ones a return or drop refers to.
function takeNewest(log, amount) {
	return takeOldest([...log].reverse(), amount).reverse();
}

export function planReturnIssued(state, key, amount = 1) {
	const current = normalizeQuotaState(state);
	const amountInt = Math.floor(amount);
	if (!key || !Number.isInteger(amountInt) || amountInt < 1 || current.issued < amountInt) {
		return { ok: false, write: false, state: current };
	}
	const holds = current.holds.map((hold) => ({ ...hold }));
	const existing = holds.find((hold) => hold.key === key);
	if (existing) existing.amount += amountInt;
	else holds.push({ key: String(key), amount: amountInt });
	return { ok: true, write: true, state: withReserved({ ...current, issuedLog: takeNewest(current.issuedLog, amountInt), holds }) };
}

export function planDropIssued(state, amount = 1) {
	const current = normalizeQuotaState(state);
	const amountInt = Math.floor(amount);
	if (!Number.isInteger(amountInt) || amountInt < 1 || current.issued < amountInt) {
		return { ok: false, write: false, state: current };
	}
	return { ok: true, write: true, state: withReserved({ ...current, issuedLog: takeNewest(current.issuedLog, amountInt) }) };
}

// alreadyReserved means this batch was included in `reserved` before the call.
// The fresh read can still defer it when the account no longer has room for that reservation.
export function planBatch(state, { max24HourSend, sentLast24Hours, fetchedAt, now, maxAgeMs, batchSize = 1, alreadyReserved = true } = {}) {
	const current = normalizeQuotaState(state);
	const assessment = assessSesQuota({ max24HourSend, sentLast24Hours, reserved: 0, fetchedAt, now, maxAgeMs });
	if (!assessment.ok) {
		return {
			action: "defer",
			ok: false,
			write: false,
			reason: assessment.reason,
			state: current,
			remaining: 0,
			message: quotaRefusalMessage(assessment.reason),
		};
	}
	const reconciled = reconcileQuota(current, { sentLast24Hours, fetchedAt });
	({ sentLast24Hours } = effectiveReading(reconciled, { sentLast24Hours, fetchedAt }));
	const budget = Math.floor(max24HourSend) - Math.floor(sentLast24Hours);
	const remaining = Math.max(0, budget - reconciled.reserved);
	const fits = reconciled.reserved <= budget && (alreadyReserved || batchSize <= remaining);
	const changed = JSON.stringify({ ...current, revision: 0 }) !== JSON.stringify({ ...reconciled, revision: 0 });
	if (!fits) {
		return {
			action: "defer",
			ok: false,
			write: changed,
			reason: "quota-dropped",
			state: reconciled,
			remaining,
			message: quotaRefusalMessage("deferred", { remaining }),
		};
	}
	return { action: "send", ok: true, write: changed, reason: null, state: reconciled, remaining, message: null };
}

export async function updateQuota(store, plan) {
	let last;
	for (let attempt = 0; attempt < 40; attempt += 1) {
		const current = normalizeQuotaState(await store.read());
		last = plan(current);
		if (!last?.write) return last;
		const next = normalizeQuotaState(last.state);
		if (await store.compareAndSwap(current, next)) {
			return { ...last, state: normalizeQuotaState({ ...next, revision: current.revision + 1 }) };
		}
	}
	const state = normalizeQuotaState(await store.read());
	return { ...last, ok: false, write: false, reason: "conflict", state, message: quotaRefusalMessage("conflict") };
}
