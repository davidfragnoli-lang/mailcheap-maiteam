// Compare-and-swap loop for ledgers that are not the SES quota document.
// A store that throws, or forty lost races, comes back as a refusal. Callers must not send.

export async function updateDocument(store, normalize, plan) {
	let last;
	for (let attempt = 0; attempt < 40; attempt += 1) {
		const current = normalize(await store.read());
		last = plan(current);
		if (!last?.write) return last;
		const next = normalize(last.state);
		if (await store.compareAndSwap(current, next)) {
			return { ...last, state: normalize({ ...next, revision: current.revision + 1 }) };
		}
	}
	const state = normalize(await store.read());
	return { ...last, ok: false, write: false, reason: "conflict", state };
}
