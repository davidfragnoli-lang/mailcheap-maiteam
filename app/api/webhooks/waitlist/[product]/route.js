import { NextResponse } from "next/server";
import {
	CLAIM_LEASE_MS,
	IN_PROGRESS_RETRY_AFTER_S,
	MAX_BODY_BYTES,
	REPLAY_TTL_MS,
	bodyHash,
	isRetryableStatus,
	parseWaitlistPayload,
	resolveWaitlistProduct,
	verifyWaitlistSignature,
} from "@/lib/maiteam/waitlist-webhook";
import { acceptWaitlistSignup } from "@/lib/maiteam/waitlist-signup";
import { redisReplayStore } from "@/lib/maiteam/webhook-replay-store";

export const dynamic = "force-dynamic";
// Keep CLAIM_LEASE_MS at twice this, so an event's claim outlives the delivery holding it.
export const maxDuration = 30;

const NO_STORE = { "Cache-Control": "no-store" };

function fail(status, error) {
	return NextResponse.json({ error }, { status, headers: NO_STORE });
}

// maiteam (PATCHES.md P6): a landing page's waitlist form, signed with its product's secret (lib/maiteam/waitlist-webhook.js).
// Order: product switched on, size, signature and timestamp, strict payload, product match, replay claim, then the
// signup, always pending with the confirmation email.
export async function POST(request, { params }) {
	const { product } = await params;
	const config = resolveWaitlistProduct(product);
	if (!config) return fail(404, "Not found");

	const declared = Number(request.headers.get("content-length") ?? 0);
	if (declared > MAX_BODY_BYTES) return fail(413, "Payload too large");
	const rawBody = await request.text().catch(() => null);
	if (rawBody === null || Buffer.byteLength(rawBody) > MAX_BODY_BYTES) return fail(413, "Payload too large");

	const verified = verifyWaitlistSignature({
		secret: config.secret,
		product: config.product,
		timestamp: request.headers.get("x-waitlist-timestamp"),
		signature: request.headers.get("x-waitlist-signature"),
		rawBody,
		now: Date.now(),
	});
	if (!verified.ok) return fail(401, verified.reason === "timestamp" ? "Signature timestamp is outside the window" : "Invalid signature");

	const payload = parseWaitlistPayload(rawBody, config.product);
	if (payload.error) return fail(payload.status ?? 400, payload.error);

	const store = redisReplayStore();
	if (!store) return fail(503, "Signups are paused. Try again later");
	const event = { product: config.product, eventId: payload.eventId, hash: bodyHash(rawBody) };
	const claim = await store.claim({ ...event, leaseMs: CLAIM_LEASE_MS });
	if (claim.unavailable) return fail(503, "Signups are paused. Try again later");
	if (!claim.claimed) {
		if (!claim.sameBody) return fail(409, "This eventId was already used for a different signup");
		// Only a finished event is a duplicate. One still running may yet fail, so the sender must retry.
		if (claim.state === "processing") {
			return NextResponse.json(
				{ error: "This event is still being processed. Retry shortly", eventId: payload.eventId, retryable: true },
				{ status: 503, headers: { ...NO_STORE, "Retry-After": String(IN_PROGRESS_RETRY_AFTER_S) } }
			);
		}
		return NextResponse.json({ duplicate: true, eventId: payload.eventId }, { status: 200, headers: NO_STORE });
	}

	let result;
	try {
		result = await acceptWaitlistSignup({ config, payload });
	} catch (error) {
		await store.release({ ...event, claim: claim.claim });
		console.error(`[waitlist] ${config.product} signup failed:`, error?.message);
		return fail(500, "Signup failed. Try again later");
	}
	if (isRetryableStatus(result.status)) await store.release({ ...event, claim: claim.claim });
	else await store.complete({ ...event, claim: claim.claim, ttlMs: REPLAY_TTL_MS });
	return NextResponse.json({ ...result.body, eventId: payload.eventId }, { status: result.status, headers: NO_STORE });
}
