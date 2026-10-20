import { NextResponse } from "next/server";
import { runSequenceStep } from "@/lib/maiteam/sequence-store";
import { httpStatusForOutcome } from "@/lib/maiteam/sequence-plan";
import { withQStashSignature } from "@/lib/qstash-route";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// maiteam (PATCHES.md P6): one welcome-sequence step. Handled outcomes answer 200 so QStash doesn't retry them (a step
// that has to wait publishes its own later job); "unavailable" answers 503 and is retried. Each outcome is logged.
async function handleStep(request) {
	const body = await request.json().catch(() => null);
	const position = Number(body?.position);
	const job = {
		accountId: body?.accountId,
		enrollmentId: body?.enrollmentId,
		position: Number.isInteger(position) ? position : null,
		scheduledFor: typeof body?.scheduledFor === "string" ? body.scheduledFor : null,
	};
	const result = await runSequenceStep(job);
	console.info(`[sequence] ${JSON.stringify({ ...job, outcome: result.outcome, key: result.key ?? null })}`);
	return NextResponse.json(result, { status: httpStatusForOutcome(result.outcome) });
}

export const POST = withQStashSignature(handleStep);
