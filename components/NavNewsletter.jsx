import FormAddNewsletter from "@/components/FormAddNewsletter";
import MenuNewsletter from "@/components/MenuNewsletter";
import { getSharedDomain } from "@/lib/config";
import { findNewsletterFamilies } from "@/lib/maiteam/newsletter-families";
import { getMaxNewslettersPerAccount, getNewsletterLimitMessage } from "@/lib/maiteam/newsletter-limit";
import { toNewsletterOption } from "@/lib/newsletters";
import { findAccountDomains } from "@/lib/sender";
import { getSelectedNewsletter } from "@/lib/selected-newsletter";

// The newsletter menu, under the logo in the sidebar and in the phone's top bar: the user's newsletters, then those shared
// with them. Add a newsletter adds one of their own.
export default async function NavNewsletter({ isCompact }) {
	const { ownAccount, newsletters, ownCount, selected, savedId } = await getSelectedNewsletter();
	const sharedDomain = getSharedDomain();
	// maiteam (PATCHES.md P13): the server's number, read here because the menu and the dialog run in the browser.
	const maxNewsletters = getMaxNewslettersPerAccount();
	const limitMessage = getNewsletterLimitMessage(maxNewsletters);
	const isAtLimit = ownCount >= maxNewsletters;
	const domains = isAtLimit || sharedDomain ? [] : await findAccountDomains(ownAccount._id);
	// maiteam (PATCHES.md P16): one list per language shows as one row, with a language selector.
	const families = findNewsletterFamilies(newsletters);
	const startsFrom = selected && !selected.team && (selected.fromName || selected.postalAddress) ? selected.name : null;

	return (
		<MenuNewsletter
			newsletters={newsletters.map((newsletter) => ({ ...toNewsletterOption(newsletter), family: families.get(String(newsletter._id)) ?? null }))}
			selectedId={selected ? String(selected._id) : null}
			savedId={savedId}
			isCompact={isCompact}
			maxNewsletters={maxNewsletters}
			limitMessage={limitMessage}
			addForm={
				<FormAddNewsletter
					sharedDomain={sharedDomain}
					domains={domains.map(({ domain }) => domain)}
					startsFrom={startsFrom}
					isAtLimit={isAtLimit}
					limitMessage={limitMessage}
				/>
			}
		/>
	);
}
