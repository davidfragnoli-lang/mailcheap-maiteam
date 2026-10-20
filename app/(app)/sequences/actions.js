"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { runDashboardAction, toFormError } from "@/lib/actions/dashboard";

// maiteam (PATCHES.md P6). The form sends its steps as one JSON field, built by components/maiteam/FormSequence.jsx.
function readSequenceFields(formData) {
	let steps = [];
	try {
		const parsed = JSON.parse(String(formData.get("steps") ?? "[]"));
		if (Array.isArray(parsed)) steps = parsed;
	} catch {
		// An unreadable field sends no steps, which update keeps and create refuses.
	}
	return {
		name: String(formData.get("name") ?? ""),
		slug: String(formData.get("slug") ?? ""),
		status: String(formData.get("status") ?? "draft"),
		steps,
	};
}

export async function saveSequenceAction(_state, formData) {
	const id = String(formData.get("id") ?? "");
	const fields = readSequenceFields(formData);
	if (id) {
		const { failure } = await runDashboardAction("update_sequence", { id, ...fields, steps: fields.steps.length > 0 ? fields.steps : undefined });
		if (failure) return toFormError(failure);
		revalidatePath("/sequences");
		revalidatePath(`/sequences/${id}`);
		return { ok: true, savedAt: Date.now() };
	}
	const { output, failure } = await runDashboardAction("create_sequence", { newsletter: String(formData.get("newsletter") ?? ""), ...fields });
	if (failure) return toFormError(failure);
	revalidatePath("/sequences");
	redirect(`/sequences/${output.id}`);
}

export async function pauseSequenceAction(sequenceId) {
	const { failure } = await runDashboardAction("pause_sequence", { id: String(sequenceId) });
	revalidatePath(`/sequences/${sequenceId}`);
	return failure ? toFormError(failure) : { ok: true };
}

export async function startSequenceAction(sequenceId) {
	const { output, failure } = await runDashboardAction("start_sequence", { id: String(sequenceId) });
	revalidatePath(`/sequences/${sequenceId}`);
	return failure ? toFormError(failure) : { ok: true, scheduled: output.scheduled };
}

export async function cancelEnrollmentAction(enrollmentId, sequenceId) {
	const { output, failure } = await runDashboardAction("cancel_enrollment", { id: String(enrollmentId) });
	revalidatePath(`/sequences/${sequenceId}`);
	return failure ? toFormError(failure) : { ok: true, inFlight: output.inFlight };
}
