"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";
import PickerLook, { describeLook } from "@/components/maiteam/PickerLook";
import { cn } from "@/lib/utils";

const INHERIT = { label: "Newsletter default", theme: null };

// maiteam (PATCHES.md P3c): a sequence step's own email look, as on the old fork; null is the newsletter's.
export default function FieldStepLook({ value, onChange, newsletterName }) {
	const [isOpen, setIsOpen] = useState(false);
	return (
		<span className="flex flex-col gap-2">
			<button
				type="button"
				aria-expanded={isOpen}
				onClick={() => setIsOpen((open) => !open)}
				className="flex h-9 w-full min-w-0 items-center justify-between gap-2 rounded-lg border border-input px-2.5 text-left text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
			>
				<span className="truncate">{describeLook(value, INHERIT)}</span>
				<ChevronDown className={cn("size-4 shrink-0 text-muted-foreground transition-transform duration-150", isOpen && "rotate-180")} />
			</button>
			{isOpen && <PickerLook compact value={value} onChange={onChange} inherit={INHERIT} newsletterName={newsletterName} />}
		</span>
	);
}
