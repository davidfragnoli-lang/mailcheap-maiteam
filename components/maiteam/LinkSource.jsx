import { getSourceLink } from "@/lib/maiteam/source";
import { cn } from "@/lib/utils";

// The "Source" link of AGPL-3.0 §13 (lib/maiteam/source.js). Renders nothing until a public repository is set.
export default function LinkSource({ className }) {
	const href = getSourceLink();
	if (!href) return null;
	return (
		<a href={href} rel="noopener" className={cn("underline underline-offset-2 hover:text-foreground", className)}>
			Source
		</a>
	);
}
