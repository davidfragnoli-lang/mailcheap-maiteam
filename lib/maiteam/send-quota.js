// Rolling 24-hour SES quota for every delivery path.
// SentLast24Hours includes mail this app did not send, and that shrinks what is left.
// A reservation is released only after this ledger handed the send to SES and a later
// account read has absorbed it. Until that read catches up, the reservation stays and
// the app can send less than the account would allow. It must not send more.

export const SES_QUOTA_MAX_AGE_MS = 60_000;

export function normalizeQuotaState(state = {}) {
	const holds = Array.isArray(state.holds)
		? state.holds
				.filter((hold) => hold && hold.key && Number.isInteger(hold.amount) && hold.amount > 0)
				.map((hold) => ({ key: String(hold.key), amount: hold.amount }))
		: [];
	const issued = Number.isInteger(state.issued) && state.issued > 0 ? state.issued : 0;
	const accountedSent = Number.isInteger(state.accountedSent) && state.accountedSent >= 0 ? state.accountedSent : null;
	const revision = Number.isInteger(state.revision) && state.revision >= 0 ? state.revision : 0;
	return {
		revision,
		issued,
		accountedSent,
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

// A falling SentLast24Hours is the rolling window moving on. Only sends already
// handed to SES age out with it. Unsent holds stay until they are sent or released.
export function reconcileQuota(state, { sentLast24Hours } = {}) {
	const current = normalizeQuotaState(state);
	const sent = Math.floor(sentLast24Hours);
	if (!Number.isInteger(sent) || sent < 0) return current;
	if (current.accountedSent === null) return withReserved({ ...current, accountedSent: sent });
	if (sent < current.accountedSent) {
		const dropped = current.accountedSent - sent;
		return withReserved({ ...current, issued: Math.max(0, current.issued - dropped), accountedSent: sent });
	}
	const matched = Math.min(current.issued, sent - current.accountedSent);
	return withReserved({ ...current, issued: current.issued - matched, accountedSent: sent });
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
	const reconciled = reconcileQuota(current, { sentLast24Hours });
	const existing = reconciled.holds.find((hold) => hold.key === key);
	const held = existing?.amount ?? 0;
	if (held >= amountInt) {
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

export function planIssueFromKey(state, key, amount = 1) {
	const released = planReleaseKey(state, key, amount);
	if (!released.ok) return released;
	return {
		ok: true,
		write: true,
		state: withReserved({ ...released.state, issued: released.state.issued + Math.floor(amount) }),
	};
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
	return { ok: true, write: true, state: withReserved({ ...current, issued: current.issued - amountInt, holds }) };
}

export function planDropIssued(state, amount = 1) {
	const current = normalizeQuotaState(state);
	const amountInt = Math.floor(amount);
	if (!Number.isInteger(amountInt) || amountInt < 1 || current.issued < amountInt) {
		return { ok: false, write: false, state: current };
	}
	return { ok: true, write: true, state: withReserved({ ...current, issued: current.issued - amountInt }) };
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
	const reconciled = reconcileQuota(current, { sentLast24Hours });
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
