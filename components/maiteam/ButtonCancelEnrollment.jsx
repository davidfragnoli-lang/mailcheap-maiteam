"use client";

import { useTransition } from "react";
import { cancelEnrollmentAction } from "@/app/(app)/sequences/actions";
import { Button } from "@/components/ui/button";
import { toast } from "@/lib/toast";

// maiteam (PATCHES.md P6): takes one contact out of a sequence. A step already handed off still arrives.
export default function ButtonCancelEnrollment({ enrollmentId, sequenceId }) {
	const [isPending, startTransition] = useTransition();

	return (
		<Button
			type="button"
			variant="outline"
			size="sm"
			disabled={isPending}
			onClick={() =>
				startTransition(async () => {
					const result = await cancelEnrollmentAction(enrollmentId, sequenceId);
					if (result?.error) toast.error(result.error);
					else toast.success(result.inFlight ? "Cancelled. One step was already on its way." : "Cancelled");
				})
			}
		>
			Cancel
		</Button>
	);
}
