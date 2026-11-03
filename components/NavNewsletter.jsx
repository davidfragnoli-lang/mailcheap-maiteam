import FormAddNewsletter from "@/components/FormAddNewsletter";
import MenuNewsletter from "@/components/MenuNewsletter";
import { getSharedDomain } from "@/lib/config";
import { getMaxNewslettersPerAccount, getNewsletterLimitMessage } from "@/lib/maiteam/newsletter-limit";
import { toNewsletterOption } from "@/lib/newsletters";
import { findAccountDomains } from "@/lib/sender";
import { getSelectedNewsletter } from "@/lib/selected-newsletter";

// The newsletter menu, under the logo in the sidebar and in the phone's top bar.
export default async function NavNewsletter({ isCompact }) {
	const { account, newsletters, selected, savedId } = await getSelectedNewsletter();
	const sharedDomain = getSharedDomain();
	// maiteam (PATCHES.md P12): the server's number, read here because the menu and the dialog run in the browser.
	const maxNewsletters = getMaxNewslettersPerAccount();
	const limitMessage = getNewsletterLimitMessage(maxNewsletters);
	const isAtLimit = newsletters.length >= maxNewsletters;
	const domains = isAtLimit || sharedDomain ? [] : await findAccountDomains(account._id);

	return (
		<MenuNewsletter
			newsletters={newsletters.map(toNewsletterOption)}
			selectedId={selected ? String(selected._id) : null}
			savedId={savedId}
			isCompact={isCompact}
			maxNewsletters={maxNewsletters}
			limitMessage={limitMessage}
			addForm={
				<FormAddNewsletter
					sharedDomain={sharedDomain}
					domains={domains.map(({ domain }) => domain)}
					startsFrom={selected && (selected.fromName || selected.postalAddress) ? selected.name : null}
					isAtLimit={isAtLimit}
					limitMessage={limitMessage}
				/>
			}
		/>
	);
}
