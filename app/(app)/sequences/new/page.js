import FormSequence from "@/components/maiteam/FormSequence";
import HeaderPage from "@/components/HeaderPage";
import { runDashboardAction } from "@/lib/actions/dashboard";

export const metadata = { title: "New sequence" };

// maiteam (PATCHES.md P6).
export default async function NewSequencePage() {
	const { output } = await runDashboardAction("list_newsletters", {});
	const newsletters = (output?.newsletters ?? []).map(({ id, name, welcome }) => ({ id, name, hasWelcome: Boolean(welcome?.subject?.trim() && welcome?.markdown?.trim()) }));

	return (
		<>
			<HeaderPage title="New sequence" backHref="/sequences" />
			{newsletters.length === 0 ? (
				<p className="text-sm text-muted-foreground">Create a newsletter before a sequence.</p>
			) : (
				<FormSequence newsletters={newsletters} />
			)}
		</>
	);
}
