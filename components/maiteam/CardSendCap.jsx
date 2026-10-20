"use client";

import { useState, useTransition } from "react";
import { Loader2 } from "lucide-react";
import { saveSendCap } from "@/app/(app)/newsletters/actions";
import CardSettings, { RowSettings } from "@/components/CardSettings";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "@/lib/toast";

const fieldValue = (cap) => (cap === null || cap === undefined ? "" : String(cap));

// maiteam (PATCHES.md P4b): the daily send cap and the sender domain's warm-up, as the old fork showed them.
export default function CardSendCap({ newsletterId, status: initial }) {
	const [status, setStatus] = useState(initial);
	const [value, setValue] = useState(fieldValue(initial.dailySendCap));
	const [isSaving, startSaving] = useTransition();
	const isDirty = value.trim() !== fieldValue(status.dailySendCap);
	const { warmup } = status;

	function save() {
		const text = value.trim();
		if (text !== "" && !/^\d+$/.test(text)) return void toast.error("The daily cap is a whole number, or empty");
		startSaving(async () => {
			const result = await saveSendCap(newsletterId, text === "" ? null : Number(text));
			if (result?.error) return void toast.error(result.error);
			setStatus(result.status);
			setValue(fieldValue(result.status.dailySendCap));
			toast.success("Daily cap saved");
		});
	}

	const today =
		status.limit === null
			? "No daily cap here or in NEWSLETTER_DAILY_CAP: every send is refused."
			: `Today's limit ${status.limit}, ${status.usedToday} used.${status.source === "env" ? ` From NEWSLETTER_DAILY_CAP (${status.envCap}).` : ""}`;

	return (
		<CardSettings
			title="Daily sending"
			className="mt-8"
			action={
				<Button type="button" size="sm" onClick={save} disabled={!isDirty || isSaving}>
					{isSaving && <Loader2 className="animate-spin" />}
					Save
				</Button>
			}
		>
			<RowSettings
				label="Daily cap"
				hint="Emails this newsletter may send in one UTC day, shared by campaigns, signup mail, tests and sequences. Empty uses NEWSLETTER_DAILY_CAP. Zero sends nothing."
				isLabel
			>
				<Input name="dailySendCap" inputMode="numeric" value={value} placeholder={status.envCap === null ? "No cap: sends refused" : `NEWSLETTER_DAILY_CAP (${status.envCap})`} onChange={(event) => setValue(event.target.value)} />
				<span className="text-xs text-muted-foreground">{today}</span>
			</RowSettings>
			{warmup && (
				<RowSettings label="Warm-up" hint={[warmup.domain, warmup.status].filter(Boolean).join(" · ")}>
					<span className={warmup.holding ? "text-sm text-destructive" : "text-sm"}>{warmup.label}</span>
				</RowSettings>
			)}
		</CardSettings>
	);
}
