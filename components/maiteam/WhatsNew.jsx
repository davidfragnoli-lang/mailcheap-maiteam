import CardWhatsNew from "@/components/maiteam/CardWhatsNew";
import {
  WHATS_NEW_LIMIT,
  getUnseenEntries,
  splitEntryText,
} from "@/lib/maiteam/changelog";

// maiteam (PATCHES.md P10): upstream's WhatsNew slot (components/SiteExtensions.jsx), filled through
// components/marketing/SiteExtensions.jsx. It gets the account and shows what shipped since its owner last closed it.
export default function WhatsNew({ account }) {
  const unseen = getUnseenEntries(account);
  if (!unseen.length) return null;
  const entries = unseen
    .slice(0, WHATS_NEW_LIMIT)
    .map(({ id, date, title, text }) => ({
      id,
      date,
      title,
      parts: splitEntryText(text),
    }));
  return (
    <CardWhatsNew
      entries={entries}
      ids={unseen.map(({ id }) => id)}
      more={unseen.length - entries.length}
    />
  );
}
