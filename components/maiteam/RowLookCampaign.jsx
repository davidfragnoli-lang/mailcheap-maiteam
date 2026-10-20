"use client";

import { useMemo, useState } from "react";
import { ChevronDown } from "lucide-react";
import PickerLook, { describeLook } from "@/components/maiteam/PickerLook";
import RowCampaign from "@/components/RowCampaign";
import { cn } from "@/lib/utils";

// maiteam (PATCHES.md P3c): the issue's own email look in the campaign editor, as on the old fork. Collapsed, it names
// the look; null is the newsletter's (theme.look, or the theme's emails without one).
export default function RowLookCampaign({ value, onChange, newsletter }) {
	const [isOpen, setIsOpen] = useState(false);
	const inherit = useMemo(() => ({ label: "Newsletter default", theme: newsletter.theme?.look ?? null }), [newsletter.theme?.look]);

	return (
		<>
			<RowCampaign label="Email look">
				<button
					type="button"
					aria-expanded={isOpen}
					aria-controls="campaign-look"
					onClick={() => setIsOpen((open) => !open)}
					className="flex h-11 w-full min-w-0 items-center justify-between gap-2 text-left text-sm outline-none"
				>
					<span className="truncate">{describeLook(value, inherit)}</span>
					<ChevronDown className={cn("size-4 shrink-0 text-muted-foreground transition-transform duration-150", isOpen && "rotate-180")} />
				</button>
			</RowCampaign>
			{isOpen && (
				<div id="campaign-look">
					<PickerLook compact value={value} onChange={onChange} inherit={inherit} newsletterName={newsletter.name} />
				</div>
			)}
		</>
	);
}
