import { notFound } from "next/navigation";
import BadgeStatus from "@/components/BadgeStatus";
import HeaderPage from "@/components/HeaderPage";
import ButtonCancelEnrollment from "@/components/maiteam/ButtonCancelEnrollment";
import ButtonsSequenceRun from "@/components/maiteam/ButtonsSequenceRun";
import FormSequence from "@/components/maiteam/FormSequence";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { runDashboardAction } from "@/lib/actions/dashboard";

export const metadata = { title: "Sequence" };

// maiteam (PATCHES.md P6): a sequence, its steps and its latest enrollments.
export default async function SequencePage({ params }) {
	const { id } = await params;
	const [{ output: sequence }, { output: listed }] = await Promise.all([
		runDashboardAction("get_sequence", { id }),
		runDashboardAction("list_newsletters", {}),
	]);
	if (!sequence) notFound();
	const newsletters = (listed?.newsletters ?? []).map(({ id: newsletterId, name, welcome }) => ({
		id: newsletterId,
		name,
		hasWelcome: Boolean(welcome?.subject?.trim() && welcome?.markdown?.trim()),
	}));

	return (
		<>
			<HeaderPage title={sequence.name} backHref="/sequences" meta={<BadgeStatus status={sequence.status} />}>
				<ButtonsSequenceRun sequenceId={sequence.id} status={sequence.status} />
			</HeaderPage>
			{sequence.pauseReason && <p className="mb-4 text-sm text-amber-700 dark:text-amber-400">Paused: {sequence.pauseReason}</p>}
			<FormSequence sequence={sequence} newsletters={newsletters} />
			<section className="mt-8">
				<h2 className="mb-3 text-sm font-medium">Enrollments</h2>
				{sequence.enrollments.length === 0 ? (
					<p className="text-sm text-muted-foreground">No one is enrolled yet.</p>
				) : (
					<div className="overflow-hidden rounded-xl shadow-border">
						<Table>
							<TableHeader>
								<TableRow className="hover:bg-transparent">
									<TableHead className="pl-4">Contact</TableHead>
									<TableHead>Status</TableHead>
									<TableHead>Steps</TableHead>
									<TableHead className="pr-4 text-right">
										<span className="sr-only">Actions</span>
									</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{sequence.enrollments.map((enrollment) => {
									const isOpen = enrollment.status === "active" || enrollment.status === "awaiting_confirmation";
									return (
										<TableRow key={enrollment.id}>
											<TableCell className="py-3 pl-4 font-mono text-xs">{enrollment.email}</TableCell>
											<TableCell>
												<BadgeStatus status={enrollment.status} />
											</TableCell>
											<TableCell className="text-xs text-muted-foreground">
												{enrollment.steps.map((step) => `${step.position}: ${step.status}`).join(" · ")}
											</TableCell>
											<TableCell className="pr-4 text-right">
												{isOpen && <ButtonCancelEnrollment enrollmentId={enrollment.id} sequenceId={sequence.id} />}
											</TableCell>
										</TableRow>
									);
								})}
							</TableBody>
						</Table>
					</div>
				)}
			</section>
		</>
	);
}
