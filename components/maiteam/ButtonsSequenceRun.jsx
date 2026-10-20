"use client";

import { useTransition } from "react";
import { pauseSequenceAction, startSequenceAction } from "@/app/(app)/sequences/actions";
import { Button } from "@/components/ui/button";
import { toast } from "@/lib/toast";

// maiteam (PATCHES.md P6): Pause, or Start / Resume, which publishes each enrollment's next step.
export default function ButtonsSequenceRun({ sequenceId, status }) {
	const [isPending, startTransition] = useTransition();

	function run(action, success) {
		startTransition(async () => {
			const result = await action(sequenceId);
			if (result?.error) toast.error(result.error);
			else toast.success(success(result));
		});
	}

	if (status === "active") {
		return (
			<Button type="button" variant="outline" disabled={isPending} onClick={() => run(pauseSequenceAction, () => "Paused")}>
				Pause
			</Button>
		);
	}
	return (
		<Button type="button" disabled={isPending} onClick={() => run(startSequenceAction, ({ scheduled }) => `Started, ${scheduled} next steps scheduled`)}>
			{status === "paused" ? "Resume" : "Start"}
		</Button>
	);
}
