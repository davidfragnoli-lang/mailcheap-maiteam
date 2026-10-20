import Link from "next/link";
import { ListOrdered } from "lucide-react";
import BadgeStatus from "@/components/BadgeStatus";
import HeaderPage from "@/components/HeaderPage";
import StateEmpty from "@/components/StateEmpty";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { runDashboardAction } from "@/lib/actions/dashboard";
import { formatNumber } from "@/lib/format";

export const metadata = { title: "Sequences" };

// maiteam (PATCHES.md P6): the account's welcome sequences.
export default async function SequencesPage() {
	const [sequences, newsletters] = await Promise.all([runDashboardAction("list_sequences", {}), runDashboardAction("list_newsletters", {})]);
	const names = new Map((newsletters.output?.newsletters ?? []).map((newsletter) => [newsletter.id, newsletter.name]));
	const list = sequences.output?.sequences ?? [];

	return (
		<>
			<HeaderPage title="Sequences">
				<Button asChild>
					<Link href="/sequences/new">New sequence</Link>
				</Button>
			</HeaderPage>
			{sequences.failure && <p className="mb-4 text-sm text-destructive">{sequences.failure.message}</p>}
			{list.length === 0 ? (
				<StateEmpty icon={ListOrdered} title="No sequences yet" />
			) : (
				<div className="overflow-hidden rounded-xl shadow-border animate-enter">
					<Table>
						<TableHeader>
							<TableRow className="hover:bg-transparent">
								<TableHead className="pl-4">Name</TableHead>
								<TableHead>Status</TableHead>
								<TableHead className="hidden text-right sm:table-cell">Steps</TableHead>
								<TableHead className="pr-4 text-right">Sent</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{list.map((sequence) => (
								<TableRow key={sequence.id} className="relative">
									<TableCell className="py-3 pl-4">
										<Link href={`/sequences/${sequence.id}`} className="font-medium after:absolute after:inset-0">
											{sequence.name}
										</Link>
										<span className="block text-xs text-muted-foreground">
											{names.get(sequence.newsletterId) ?? "Newsletter"} · {sequence.slug}
										</span>
									</TableCell>
									<TableCell>
										<BadgeStatus status={sequence.status} />
									</TableCell>
									<TableCell className="hidden text-right tabular-nums sm:table-cell">{sequence.steps.length}</TableCell>
									<TableCell className="pr-4 text-right tabular-nums">{formatNumber(sequence.stats.sent)}</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				</div>
			)}
		</>
	);
}
