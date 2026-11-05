import LayoutNarrow from "@/components/LayoutNarrow";
import LayoutSettingsSection from "@/components/LayoutSettingsSection";
import CardSendCap from "@/components/maiteam/CardSendCap";
import { readSendCapStatus } from "@/lib/maiteam/send-cap-actions";
import { serialize } from "@/lib/serialize";
import { findNewsletterAuthors, getAuthorSuggestion, toAuthorView } from "@/lib/authors";
import { gravatarHash } from "@/lib/gravatar";
import { getSettingsPage } from "@/lib/settings-page";

export const metadata = { title: "Sender" };

// ?domain=<id>, from a helper or the Domains page, picks that domain of the account in the from field, ready to save.
export default async function SenderPage({ searchParams }) {
	const [page, { domain }] = await Promise.all([getSettingsPage({ section: "sender" }), searchParams]);
	const preselectDomain = page.domains.find(({ _id }) => String(_id) === String(domain ?? ""))?.domain ?? null;
	const { authors, defaultAuthor } = await findNewsletterAuthors(page.account, page.newsletter._id);
	// maiteam (PATCHES.md P4b): the daily cap and warm-up, under the sender settings.
	const sendCap = await readSendCapStatus(page.newsletter).catch(() => null);
	return (
		<>
			<LayoutSettingsSection
				section="sender"
				page={page}
				preselectDomain={preselectDomain}
				authors={{
					list: authors.map((author) => ({ ...toAuthorView(author), gravatarHash: gravatarHash(author.email) })),
					defaultId: defaultAuthor ? String(defaultAuthor._id) : null,
					suggestion: getAuthorSuggestion(page),
				}}
			/>
			{sendCap && (
				<LayoutNarrow>
					<CardSendCap key={String(page.newsletter._id)} newsletterId={String(page.newsletter._id)} status={serialize(sendCap)} />
				</LayoutNarrow>
			)}
		</>
	);
}
