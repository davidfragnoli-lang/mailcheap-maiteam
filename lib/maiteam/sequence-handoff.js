// maiteam (PATCHES.md P6): provider handoff and cancellation share one enrollment transition.
// `sending` means the step is authorized and its Message is queued, but the provider has not been entered.
// `in-flight` means this send owns the provider call; cancellation can't take it back. upstream's batch
// (lib/sending.js sendMessageBatch) claims `in-flight` right before deliver(), only if the enrollment is still active
// and the step is still `sending`. Cancellation writes `cancelled` for every earlier step status in the same
// compare-and-swap. One of those two writes matches; the other sees the result and stops.

export const CANCELLABLE_STEP_STATUSES = ["pending", "scheduled", "held", "claimed", "sending"];
export const HANDOFF_STATUS = "in-flight";

function withStep(state, index, status) {
	return { ...state, steps: state.steps.map((step, stepIndex) => (stepIndex === index ? { ...step, status } : step)) };
}

export function planProviderHandoff(state, { position } = {}) {
	if (!state) return { ok: false, write: false, state, reason: "missing" };
	if (state.status !== "active") return { ok: false, write: false, state, reason: "cancelled" };
	const steps = Array.isArray(state.steps) ? state.steps : [];
	const index = steps.findIndex((step) => step.position === position && step.status === "sending");
	if (index < 0) return { ok: false, write: false, state, reason: "cancelled" };
	return { ok: true, write: true, state: withStep(state, index, HANDOFF_STATUS) };
}

// The batch put the email back in the queue without handing it off (the provider or a send gate said "later"): the
// step is `sending` again, so it can be cancelled until the next handoff, or `cancelled` when the enrollment ended
// meanwhile.
export function planHandoffRelease(state, { position } = {}) {
	if (!state) return { ok: false, write: false, state, reason: "missing" };
	const steps = Array.isArray(state.steps) ? state.steps : [];
	const index = steps.findIndex((step) => step.position === position && step.status === HANDOFF_STATUS);
	if (index < 0) return { ok: false, write: false, state, reason: "not-in-flight" };
	const isActive = state.status === "active";
	return { ok: isActive, write: true, state: withStep(state, index, isActive ? "sending" : "cancelled"), reason: isActive ? null : "cancelled" };
}

export function planEnrollmentCancel(state) {
	if (!state) return { ok: false, write: false, error: "Enrollment not found", state };
	if (state.status === "cancelled" || state.status === "completed") {
		return { ok: false, write: false, error: "This enrollment is already finished", state };
	}
	const steps = Array.isArray(state.steps) ? state.steps : [];
	const inFlight = steps.some((step) => step.status === HANDOFF_STATUS);
	const nextSteps = steps.map((step) => (CANCELLABLE_STEP_STATUSES.includes(step.status) ? { ...step, status: "cancelled" } : step));
	return {
		ok: !inFlight,
		write: true,
		inFlight,
		error: inFlight ? "A send is already in flight" : null,
		state: { ...state, status: "cancelled", steps: nextSteps },
	};
}

// One compare-and-swap. A lost race reads again instead of writing over the winner.
export async function commitPlannedState(store, plan) {
	for (let attempt = 0; attempt < 5; attempt += 1) {
		const current = await store.read();
		const planned = plan(current);
		if (!planned.write) return planned;
		if (await store.compareAndSwap(current, planned.state)) return planned;
	}
	return { ok: false, write: false, error: "Enrollment changed before it could be updated" };
}
