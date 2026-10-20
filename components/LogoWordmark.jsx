import Link from "next/link";
import LogoFlight from "@/components/LogoFlight";
import LogoMailcheap from "@/components/LogoMailcheap";
import { cn } from "@/lib/utils";

// canFly: hovering the wordmark flies its plane around a loop (LogoFlight), for the public site's header.
export default function LogoWordmark({ href, canFly, className, children }) {
	const Wordmark = href ? Link : "span";

	return (
		<Wordmark href={href} className={cn("flex items-center gap-2", canFly && "wordmark-flight", className)}>
			{canFly ? <LogoFlight /> : <LogoMailcheap />}
			<span className="text-[17px] font-semibold tracking-tight">mailcheap</span>
			{children}
		</Wordmark>
	);
}
