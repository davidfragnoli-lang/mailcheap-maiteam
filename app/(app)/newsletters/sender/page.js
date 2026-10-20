import LayoutNarrow from "@/components/LayoutNarrow";
import LayoutSettingsSection from "@/components/LayoutSettingsSection";
import CardSendCap from "@/components/maiteam/CardSendCap";
import { readSendCapStatus } from "@/lib/maiteam/send-cap-actions";
import { serialize } from "@/lib/serialize";
import { getSettingsPage } from "@/lib/settings-page";

export const metadata = { title: "Sender" };

export default async function SenderPage() {
	const page = await getSettingsPage({ section: "sender" });
	// maiteam (PATCHES.md P4b): the daily cap and warm-up, under the sender settings.
	const sendCap = await readSendCapStatus(page.newsletter).catch(() => null);
	return (
		<>
			<LayoutSettingsSection section="sender" page={page} />
			{sendCap && (
				<LayoutNarrow>
					<CardSendCap key={String(page.newsletter._id)} newsletterId={String(page.newsletter._id)} status={serialize(sendCap)} />
				</LayoutNarrow>
			)}
		</>
	);
}
