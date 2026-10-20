// Per-newsletter sender-domain warm-up. It lowers the daily cap; it does not keep its own count.
//
// Levels: 50, 100, 250, 500, 1000 emails per UTC day. The effective limit is
// min(configured daily cap, warm-up level), and the existing rolling SES quota reservation can
// still refuse a send that fits that limit. Counting stays in the one daily cap ledger
// (`lib/newsletter-cap.js`, document `${newsletterId}:${YYYY-MM-DD}`). This file stores only
// which level a newsletter and sender domain are on.
//
// Identity: one warm-up document per newsletter and normalized sender domain
// (`${newsletterId}:${domain}`). The domain is the part of `fromEmail` after the last `@`,
// lowercased, trailing dots removed, IDN converted to ASCII. Changing the local part or the case
// keeps the same document. A new domain starts at 50. Switching back to an earlier domain resumes
// that domain's level; it does not restart or skip anything.
//
// Day 1: the first successful daily cap reservation under that domain sets `startedAt`.
// "Warm-up day N" is floor((now - startedAt) / 24h) + 1. Until then the limit is 50.
//
// Steps: a level lasts at least 7 x 24 hours from the moment it began. The earliest advances
// are therefore after 7, 14, 21 and 28 full days (day 8, 15, 22 and 29), never inside day 7.
// The brief's "days 7, 14, 21, 28" and its "at least 7 days per step" cannot both hold if day 1
// is the first send; the 7-day minimum wins. A promotion moves one level and restarts the clock
// at the moment of promotion, so a step that held longer cannot later skip a level.
//
// Evidence, read only from Message rows (never from a stored or submitted number):
// - Rows: this newsletter, this sender domain, handed to the provider (`handoffAt`) since the
//   current level began.
// - Accepted: rows with an SES message id, de-duplicated by that id.
// - Mature: accepted at least 72 hours ago. Only mature rows form the denominator.
// - Bounces and complaints: hard bounces (`bouncedAt`) and complaints (`complainedAt`) on any
//   accepted row of the step, mature or not. SES event retries set those fields once per
//   message, and duplicate ids are merged, so a retried event is counted once. Counting a
//   young row's early bounce against a mature-only denominator can only make a hold likelier.
// - Coverage: every mature row needs a delivery, bounce, complaint, final soft bounce or reject.
//   A row handed off without an SES id that is old enough to have one is unresolved.
// - Freshness: the newest delivery or bounce result in the step is no more than 24 hours old.
//
// Promotion needs all of: 7 days at the level, no unresolved handoff, at least 100 mature
// accepted rows, bounces/mature strictly below 1%, complaints/mature strictly below 0.05%,
// complete coverage and fresh results (checked in that order; the first failure is the hold).
// Equality holds. Zero, missing, stale, unresolved or insufficient evidence holds. These are
// implementation defaults, not a statistical guarantee.
//
// Alerts: a metrics hold alerts when the step's numbers also cross the existing campaign pause
// thresholds (`getCampaignPauseReason`: over 100 sent, bounce above 2%, complaint above 0.08%).
// The existing campaign and sequence pauses are unchanged.
//
// Concurrency: every write is a compare-and-swap on the warm-up document. A promotion commits
// only if the level and its start are still the ones the evidence was read for, so concurrent
// workers and retries add at most one level. A same-key hold in the daily cap ledger is reused
// only while the ledger still fits the current limit (see `planCapReservation`).

import { domainToASCII } from "node:url";
import { updateDocument } from "./document-store.js";
import { DAY_MS, normalizeCapState, planCapReservation, readDailyCap } from "./newsletter-cap.js";

// The old fork's campaign pause thresholds, kept here for the warm-up hold's alert only: over 100 sent, bounces above
// 2%, complaints above 0.08%. Upstream's own pauses (lib/sending-rules.js) run unchanged.
function getCampaignPauseReason({ sent = 0, bounced = 0, complained = 0 } = {}) {
	if (sent < 100) return null;
	if (bounced / sent > 0.02) return "bounce rate";
	if (complained / sent > 0.0008) return "complaint rate";
	return null;
}

export const WARMUP_LEVELS = [50, 100, 250, 500, 1000];
export const WARMUP_STEP_MS = 7 * DAY_MS;
export const WARMUP_MIN_ACCEPTED = 100;
export const WARMUP_MATURITY_MS = 72 * 3_600_000;
export const WARMUP_FRESH_MS = 24 * 3_600_000;
export const WARMUP_RECHECK_MS = 15 * 60_000;
export const WARMUP_BOUNCE_LIMIT = 0.01;
export const WARMUP_COMPLAINT_LIMIT = 0.0005;
const MAX_LEVEL = WARMUP_LEVELS.length - 1;
const DOMAIN_PATTERN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/;

export function senderDomainOf(fromEmail) {
	const text = String(fromEmail ?? "").trim();
	const at = text.lastIndexOf("@");
	if (at < 1) return null;
	const raw = text.slice(at + 1).trim().toLowerCase().replace(/\.+$/, "");
	if (!raw) return null;
	const domain = domainToASCII(raw);
	return DOMAIN_PATTERN.test(domain) ? domain : null;
}

export function warmupDocumentId(newsletterId, domain) {
	return `${String(newsletterId)}:${domain}`;
}

function toMs(value) {
	if (value === null || value === undefined || value === "") return null;
	const ms = value instanceof Date ? value.getTime() : typeof value === "number" ? value : Date.parse(value);
	return Number.isFinite(ms) ? ms : null;
}

export function normalizeWarmupState(state = {}) {
	const revision = Number.isInteger(state.revision) && state.revision >= 0 ? state.revision : 0;
	const startedAt = toMs(state.startedAt);
	if (startedAt === null) {
		return { revision, startedAt: null, level: 0, levelStartedAt: null, checkedAt: null, hold: null, history: [] };
	}
	const level = Number.isInteger(state.level) && state.level >= 0 && state.level <= MAX_LEVEL ? state.level : 0;
	const levelStartedAt = toMs(state.levelStartedAt) ?? startedAt;
	const hold =
		state.hold && typeof state.hold.reason === "string"
			? { reason: state.hold.reason, level: Number.isInteger(state.hold.level) ? state.hold.level : level }
			: null;
	const history = Array.isArray(state.history)
		? state.history
				.filter((entry) => entry && Number.isInteger(entry.level))
				.map((entry) => ({
					level: entry.level,
					startedAt: toMs(entry.startedAt),
					endedAt: toMs(entry.endedAt),
					accepted: Number.isInteger(entry.accepted) ? entry.accepted : 0,
					bounced: Number.isInteger(entry.bounced) ? entry.bounced : 0,
					complained: Number.isInteger(entry.complained) ? entry.complained : 0,
				}))
		: [];
	return { revision, startedAt, level, levelStartedAt, checkedAt: toMs(state.checkedAt), hold, history };
}

export function warmupCap(state) {
	return WARMUP_LEVELS[normalizeWarmupState(state).level];
}

export function warmupDay(state, now) {
	const current = normalizeWarmupState(state);
	if (current.startedAt === null) return null;
	return Math.max(0, Math.floor((now - current.startedAt) / DAY_MS)) + 1;
}

// min(configured, warm-up). An unconfigured cap stays unconfigured: warm-up never invents a cap.
export function effectiveDailyLimit(configured, state) {
	if (!configured?.ok) return null;
	return Math.min(configured.cap, warmupCap(state));
}

// Rows are Message documents (or plain objects with the same fields), in any order.
export async function summarizeStepEvidence(rows, { stepStartedAt, now, maturityMs = WARMUP_MATURITY_MS }) {
	const matureBefore = now - maturityMs;
	const accepted = new Map();
	let unresolved = 0;
	let latestResultAt = null;
	for await (const row of rows) {
		const handoffAt = toMs(row?.handoffAt);
		if (handoffAt === null || handoffAt < stepStartedAt || handoffAt > now) continue;
		const deliveredAt = toMs(row.deliveredAt);
		const bouncedAt = toMs(row.bouncedAt);
		for (const at of [deliveredAt, bouncedAt]) {
			if (at !== null && at <= now && (latestResultAt === null || at > latestResultAt)) latestResultAt = at;
		}
		const softBounced = /^Soft bounce/.test(String(row.error ?? ""));
		const rejected = row.status === "failed";
		if (!row.sesMessageId) {
			if (handoffAt <= matureBefore && !rejected && row.status !== "suppressed") unresolved += 1;
			continue;
		}
		const id = String(row.sesMessageId);
		const seen = accepted.get(id);
		const merged = {
			handoffAt: seen ? Math.min(seen.handoffAt, handoffAt) : handoffAt,
			bounced: Boolean(seen?.bounced || bouncedAt !== null),
			complained: Boolean(seen?.complained || toMs(row.complainedAt) !== null),
			resolved: Boolean(seen?.resolved || deliveredAt !== null || bouncedAt !== null || softBounced || rejected),
		};
		merged.resolved = merged.resolved || merged.complained;
		accepted.set(id, merged);
	}
	let mature = 0;
	let missingOutcome = 0;
	let bounced = 0;
	let complained = 0;
	for (const message of accepted.values()) {
		if (message.bounced) bounced += 1;
		if (message.complained) complained += 1;
		if (message.handoffAt > matureBefore) continue;
		mature += 1;
		if (!message.resolved) missingOutcome += 1;
	}
	return { accepted: accepted.size, mature, bounced, complained, missingOutcome, unresolved, latestResultAt };
}

function hold(reason, extra = {}) {
	return { promote: false, reason, ...extra };
}

export function decidePromotion(state, evidence, now) {
	const current = normalizeWarmupState(state);
	if (current.startedAt === null) return hold("not-started");
	if (current.level >= MAX_LEVEL) return hold("complete");
	const eligibleAt = current.levelStartedAt + WARMUP_STEP_MS;
	if (now < eligibleAt) return hold("too-soon", { eligibleAt });
	if (!evidence || typeof evidence !== "object" || !Number.isInteger(evidence.mature)) return hold("missing");
	if (evidence.unresolved > 0) return hold("unresolved", { evidence });
	if (evidence.mature < WARMUP_MIN_ACCEPTED) return hold("insufficient", { evidence });
	// Bad rates are reported before coverage and freshness: every one of these holds, and the
	// rates are the reason an operator can act on.
	const bounceRate = evidence.bounced / evidence.mature;
	const complaintRate = evidence.complained / evidence.mature;
	const alert = getCampaignPauseReason({ sent: evidence.mature, bounced: evidence.bounced, complained: evidence.complained });
	if (!(bounceRate < WARMUP_BOUNCE_LIMIT)) return hold("bounce", { evidence, bounceRate, alert });
	if (!(complaintRate < WARMUP_COMPLAINT_LIMIT)) return hold("complaint", { evidence, complaintRate, alert });
	if (evidence.missingOutcome > 0) return hold("incomplete", { evidence });
	const latest = evidence.latestResultAt;
	if (!Number.isFinite(latest) || latest > now || now - latest > WARMUP_FRESH_MS) return hold("stale", { evidence });
	return { promote: true, reason: null, evidence };
}

export function planWarmupStart(state, now) {
	const current = normalizeWarmupState(state);
	if (current.startedAt !== null) return { ok: true, write: false, state: current };
	return {
		ok: true,
		write: true,
		state: { ...current, startedAt: now, level: 0, levelStartedAt: now, checkedAt: null, hold: null },
	};
}

// The level and start the evidence was read for must still be current, or nothing is written.
export function planWarmupCheck(state, { now, seenLevel, seenLevelStartedAt, decision }) {
	const current = normalizeWarmupState(state);
	if (current.startedAt === null || current.level !== seenLevel || current.levelStartedAt !== seenLevelStartedAt) {
		return { ok: true, write: false, raced: true, promoted: false, state: current };
	}
	if (decision?.promote === true && current.level < MAX_LEVEL) {
		const evidence = decision.evidence ?? {};
		return {
			ok: true,
			write: true,
			promoted: true,
			state: {
				...current,
				level: current.level + 1,
				levelStartedAt: now,
				checkedAt: now,
				hold: null,
				history: [
					...current.history,
					{
						level: current.level,
						startedAt: current.levelStartedAt,
						endedAt: now,
						accepted: evidence.mature ?? 0,
						bounced: evidence.bounced ?? 0,
						complained: evidence.complained ?? 0,
					},
				],
			},
		};
	}
	return {
		ok: true,
		write: true,
		promoted: false,
		state: { ...current, checkedAt: now, hold: { reason: decision?.reason ?? "missing", level: current.level } },
	};
}

// Reads the state and, when a step is due, the evidence. Writes at most one transition.
export async function advanceWarmup({ store, readEvidence, alert, now }) {
	const state = normalizeWarmupState(await store.read());
	if (state.startedAt === null || state.level >= MAX_LEVEL) return { state, decision: decidePromotion(state, null, now) };
	if (now < state.levelStartedAt + WARMUP_STEP_MS) return { state, decision: decidePromotion(state, null, now) };
	if (state.hold?.level === state.level && state.checkedAt !== null && now - state.checkedAt < WARMUP_RECHECK_MS) {
		return { state, decision: hold(state.hold.reason), cached: true };
	}
	let evidence = null;
	try {
		evidence = await readEvidence({ stepStartedAt: state.levelStartedAt, now });
	} catch {
		evidence = null;
	}
	const decision = decidePromotion(state, evidence, now);
	const committed = await updateDocument(store, normalizeWarmupState, (current) =>
		planWarmupCheck(current, { now, seenLevel: state.level, seenLevelStartedAt: state.levelStartedAt, decision })
	);
	if (committed?.reason === "conflict") return { state: normalizeWarmupState(committed.state), decision: hold("conflict") };
	if (decision.alert && alert && !committed.raced) {
		try {
			await alert({ level: state.level, reason: decision.reason, evidence: decision.evidence });
		} catch {
			// An alert must not decide whether mail is sent.
		}
	}
	return { state: normalizeWarmupState(committed.state), decision, promoted: Boolean(committed.promoted) };
}

function refuse(reason, message) {
	return { ok: false, write: false, idempotent: false, added: 0, reason, remaining: 0, message };
}

// The one daily cap reservation every send path uses: campaign batches, signup mail, tests and
// sequence steps. A missing sender domain, a warm-up store failure or a lost race refuses.
export async function reserveWarmedCap({ capStore, warmup, newsletterCap, envCap, key, amount = 1, now }) {
	const domain = senderDomainOf(warmup?.fromEmail);
	if (!domain || !warmup?.store || typeof warmup.readEvidence !== "function") {
		return refuse("unconfigured", "This newsletter has no valid sender domain for warm-up, so this send was refused. Nothing was truncated.");
	}
	let advanced;
	try {
		advanced = await advanceWarmup({ store: warmup.store, readEvidence: warmup.readEvidence, alert: warmup.alert, now });
	} catch {
		return refuse("unavailable", "The sender warm-up could not be read, so this send was refused. Nothing was truncated.");
	}
	if (advanced.decision?.reason === "conflict") {
		return refuse("conflict", "The sender warm-up was busy. Nothing was sent.");
	}
	const configured = readDailyCap({ newsletterCap, envCap });
	const limit = effectiveDailyLimit(configured, advanced.state);
	const reserved = await updateDocument(capStore, normalizeCapState, (state) =>
		planCapReservation(state, { key, amount, cap: limit })
	);
	if (reserved.ok && advanced.state.startedAt === null) {
		try {
			await updateDocument(warmup.store, normalizeWarmupState, (state) => planWarmupStart(state, now));
		} catch {
			// The hold stands at level 1's limit. The next reservation records the start.
		}
	}
	return {
		...reserved,
		warmup: { domain, level: advanced.state.level, cap: WARMUP_LEVELS[advanced.state.level], limit },
	};
}

// Dashboard wording. `decision` is a read-only decidePromotion result.
export function describeWarmup(state, { now, configuredCap, decision } = {}) {
	const current = normalizeWarmupState(state);
	const cap = WARMUP_LEVELS[current.level];
	const configured = Number.isInteger(configuredCap) && configuredCap >= 0 ? configuredCap : null;
	const limit = configured === null ? null : Math.min(configured, cap);
	const day = warmupDay(current, now);
	const next = WARMUP_LEVELS[current.level + 1];
	const evidence = decision?.evidence;
	const percent = (value) => `${(value * 100).toFixed(2)}%`;
	const reasons = {
		"not-started": "Starts with the first send from this domain.",
		complete: "Warm-up complete.",
		"too-soon": decision?.eligibleAt
			? `Next step (${next}/day) no earlier than ${new Date(decision.eligibleAt).toISOString().slice(0, 16).replace("T", " ")} UTC, if results stay clean.`
			: "Each step lasts at least 7 days.",
		missing: "Holding: delivery results could not be read.",
		conflict: "Holding: busy, checked again on the next send.",
		unresolved: `Holding: ${evidence?.unresolved ?? "some"} sends have no SES confirmation.`,
		insufficient: `Holding: ${evidence?.mature ?? 0} of the ${WARMUP_MIN_ACCEPTED} emails needed have 3 days of results.`,
		incomplete: `Holding: delivery results missing for ${evidence?.missingOutcome ?? "some"} emails.`,
		stale: "Holding: no delivery result in the last 24 hours.",
		bounce: `Holding: bounces ${percent(decision?.bounceRate ?? 0)}, must be under 1%.`,
		complaint: `Holding: complaints ${percent(decision?.complaintRate ?? 0)}, must be under 0.05%.`,
	};
	return {
		day,
		level: current.level,
		cap,
		limit,
		label: day === null ? `Warm-up not started, cap ${cap}` : `Warm-up day ${day}, cap ${cap}`,
		status: reasons[decision?.reason] ?? (decision?.promote ? `Ready for ${next}/day on the next send.` : ""),
		holding: Boolean(decision && !decision.promote && !["not-started", "complete", "too-soon"].includes(decision.reason)),
	};
}
