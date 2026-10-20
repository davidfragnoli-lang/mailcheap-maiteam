// Per-newsletter daily cap, shared by campaigns, signup mail, tests, and sequences.
//
// Window: one UTC calendar day, [00:00:00.000Z, next 00:00:00.000Z). The store
// document id is `${newsletterId}:${YYYY-MM-DD}` from `capDocumentId`. Yesterday's
// holds are not read today, so they do not spend today's cap. A send that was
// held and not handed off before midnight must reserve again against the new day.
//
// Retry: the same key is idempotent while its hold exists (a second worker or a
// QStash retry does not add a second hold), and only while the ledger still fits the
// limit passed in now. A lowered limit refuses the reuse and leaves the hold to its
// owner. A refusal writes nothing. An amount larger than the room left is refused
// whole — the audience is not shortened. The limit callers pass is min(this cap,
// sender warm-up level) from `lib/sender-warmup.js`.
// A missing cap, a store throw, or a lost compare-and-swap is a refusal. Callers
// must not send.

export const DAY_MS = 86_400_000;

export function utcDayKey(now) {
	return new Date(now).toISOString().slice(0, 10);
}

export function nextUtcDayStart(now) {
	return Date.parse(`${utcDayKey(now)}T00:00:00.000Z`) + DAY_MS;
}

export function capDocumentId(newsletterId, now) {
	return `${String(newsletterId)}:${utcDayKey(now)}`;
}

export function normalizeCapState(state = {}) {
	const holds = Array.isArray(state.holds)
		? state.holds
				.filter((hold) => hold && hold.key && Number.isInteger(hold.amount) && hold.amount > 0)
				.map((hold) => ({ key: String(hold.key), amount: hold.amount }))
		: [];
	const issued = Number.isInteger(state.issued) && state.issued > 0 ? state.issued : 0;
	const revision = Number.isInteger(state.revision) && state.revision >= 0 ? state.revision : 0;
	return {
		revision,
		issued,
		holds,
		reserved: issued + holds.reduce((sum, hold) => sum + hold.amount, 0),
	};
}

// Newsletter field wins. A valid env value is the fallback. Anything else is unconfigured
// and the send is refused — there is no implicit unlimited cap.
export function readDailyCap({ newsletterCap, envCap } = {}) {
	if (Number.isInteger(newsletterCap) && newsletterCap >= 0) return { ok: true, cap: newsletterCap, source: "newsletter" };
	if (Number.isInteger(envCap) && envCap >= 0) return { ok: true, cap: envCap, source: "env" };
	return { ok: false, cap: null, source: null };
}

export function readNewsletterDailyCap(env = process.env) {
	const raw = env.NEWSLETTER_DAILY_CAP;
	if (raw === undefined || raw === "") return null;
	const cap = Number.parseInt(raw, 10);
	if (!Number.isInteger(cap) || String(cap) !== String(raw).trim() || cap < 0) return null;
	return cap;
}

export function capRefusalMessage(reason, { remaining = 0, amount = 1 } = {}) {
	if (reason === "unconfigured") return "This newsletter has no daily send cap, so this send was refused. Nothing was truncated.";
	if (reason === "unavailable") return "The daily send cap could not be reserved, so this send was refused. Nothing was truncated.";
	if (reason === "conflict") return "The daily send cap reservation was busy. Nothing was sent.";
	const left = Math.max(0, Math.floor(Number.isFinite(remaining) ? remaining : 0));
	return `This send needs ${amount} emails and ${left} remain in today's UTC daily cap. It was refused, not shortened.`;
}

function refuse(reason, state, extra = {}) {
	return {
		ok: false,
		write: false,
		idempotent: false,
		added: 0,
		reason,
		state: normalizeCapState(state),
		remaining: extra.remaining ?? 0,
		message: capRefusalMessage(reason, extra),
	};
}

export function planCapReservation(state, { key, amount, cap } = {}) {
	const current = normalizeCapState(state);
	const amountInt = Math.floor(amount);
	if (!key || !Number.isInteger(amountInt) || amountInt < 1) return refuse("unavailable", current);
	if (!Number.isInteger(cap) || cap < 0) return refuse("unconfigured", current);
	const existing = current.holds.find((hold) => hold.key === key);
	const held = existing?.amount ?? 0;
	if (held >= amountInt) {
		// A hold taken under a larger limit (a higher cap, an earlier sender, a warm-up level that
		// no longer applies) is reused only if the whole ledger still fits today's limit.
		if (current.reserved > cap) {
			return { ...refuse("exceeds", current, { remaining: 0, amount: amountInt }), lowered: true };
		}
		return {
			ok: true,
			write: false,
			idempotent: true,
			added: 0,
			reason: null,
			state: current,
			remaining: Math.max(0, cap - current.reserved),
			message: null,
		};
	}
	const extra = amountInt - held;
	const remaining = cap - current.reserved;
	if (extra > remaining) {
		return refuse(remaining <= 0 ? "none-left" : "exceeds", current, { remaining: Math.max(0, remaining), amount: amountInt });
	}
	const holds = existing
		? current.holds.map((hold) => (hold.key === key ? { key, amount: amountInt } : hold))
		: [...current.holds, { key: String(key), amount: amountInt }];
	const next = normalizeCapState({ ...current, holds });
	return {
		ok: true,
		write: true,
		idempotent: false,
		added: extra,
		reason: null,
		state: next,
		remaining: remaining - extra,
		message: null,
	};
}

export function planCapRelease(state, key, amount = 1) {
	const current = normalizeCapState(state);
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
	return { ok: true, write: true, state: normalizeCapState({ ...current, holds }) };
}

export function planCapIssue(state, key, amount = 1) {
	const released = planCapRelease(state, key, amount);
	if (!released.ok) return released;
	return {
		ok: true,
		write: true,
		state: normalizeCapState({ ...released.state, issued: released.state.issued + Math.floor(amount) }),
	};
}
