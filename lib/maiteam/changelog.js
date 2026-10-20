// maiteam (PATCHES.md P10): what's new on this server, for the dashboard's what's new card (components/maiteam/WhatsNew.jsx),
// which fills upstream's WhatsNew slot. Upstream ships no changelog in the open source, so these are this server's own
// release entries: what the move onto upstream (FRA-26000) brought, each with the commits it came in. Newest first. An
// entry's id is stored in Account.changelog.seen once its owner closes the card, so ids never change. Text links the
// dashboard pages it names, written [words](/path), as upstream's changelog does; tests/maiteam-changelog.test.mjs
// checks each path against the app's pages.
export const CHANGELOG = [
  {
    id: "2026-10-20-welcome-sequences",
    date: "2026-10-20",
    title: "Welcome sequences",
    text: "New subscribers can get a series of emails, days apart, in their own language. Set one up in [Sequences](/sequences).",
    commits: ["0e99cd7", "582c02d"],
  },
  {
    id: "2026-10-20-daily-sending",
    date: "2026-10-20",
    title: "Daily sending cap",
    text: "Each newsletter has a daily cap, with its sender domain's warm-up shown next to it, on the [Sender](/newsletters/sender) page.",
    commits: ["36bf0de", "c547b92"],
  },
  {
    id: "2026-10-20-email-looks",
    date: "2026-10-20",
    title: "maiteam email looks",
    text: "The maiteam, fortuna and quote-to-invoice looks, each with a dark version, are in [Design](/newsletters/design). An issue can have its own look.",
    commits: ["f611857", "9221a91", "515e3c1"],
  },
  {
    id: "2026-10-19-newsletter-settings",
    date: "2026-10-19",
    title: "Newsletter settings, one page each",
    text: "Settings are split into their own pages, like [General](/newsletters/general), [Website](/newsletters/website) and [Welcome email](/newsletters/welcome).",
    commits: ["5e69c1b", "f6a9a8b"],
  },
  {
    id: "2026-10-18-segments",
    date: "2026-10-18",
    title: "Segments",
    text: "Send to some of your contacts, picked by opens, clicks, signup date, source or address. Build them in [Contacts](/contacts).",
    commits: ["bbf9023"],
  },
  {
    id: "2026-10-18-contact-status",
    date: "2026-10-18",
    title: "Contact status you can change",
    text: "Mark a contact dormant or active, unsubscribe them or resubscribe them from their menu in [Contacts](/contacts).",
    commits: ["966d5b6"],
  },
  {
    id: "2026-10-18-themes",
    date: "2026-10-18",
    title: "Newsletter themes",
    text: "Pick a theme for your website and emails in [Design](/newsletters/design).",
    commits: ["74f699f"],
  },
  {
    id: "2026-10-18-help-center",
    date: "2026-10-18",
    title: "Help center",
    text: "Every feature explained in plain words, one article per area, at [Help](/help).",
    commits: ["7a578a0"],
  },
  {
    id: "2026-10-17-image-toolbar",
    date: "2026-10-17",
    title: "Picture toolbar",
    text: "Place a picture left, centered or right from its toolbar in the editor, and emails keep it there. Start from [Campaigns](/campaigns).",
    commits: ["556595a", "94ddf3c"],
  },
  {
    id: "2026-10-17-gmail-preview",
    date: "2026-10-17",
    title: "Gmail on iPhone preview",
    text: "Preview an issue as it opens in Gmail on an iPhone, from the editor in [Campaigns](/campaigns).",
    commits: ["e235e3d", "d013dce"],
  },
  {
    id: "2026-10-15-write-review-send",
    date: "2026-10-15",
    title: "Write, Review, Send",
    text: "The campaign editor goes one step at a time, with any step a click away, in [Campaigns](/campaigns).",
    commits: ["bdd3b79", "e2649d7"],
  },
  {
    id: "2026-10-14-mcp",
    date: "2026-10-14",
    title: "Connect an AI agent",
    text: "Claude, ChatGPT and other agents can work with your newsletters through MCP. Connect one from [API keys](/api-keys).",
    commits: ["45672d3", "f929fa6"],
  },
];

// The card shows this many entries, newest first; closing it marks every unseen entry as seen.
export const WHATS_NEW_LIMIT = 5;

const CHANGELOG_IDS = new Set(CHANGELOG.map(({ id }) => id));

export function isChangelogId(id) {
  return CHANGELOG_IDS.has(id);
}

// The entries the account's owner hasn't closed the card on.
export function getUnseenEntries(account, changelog = CHANGELOG) {
  const seen = new Set(account?.changelog?.seen ?? []);
  return changelog.filter(({ id }) => !seen.has(id));
}

// An entry's text as parts: plain text, and links written [words](/path) to a dashboard page.
export function splitEntryText(text) {
  const parts = [];
  let last = 0;
  for (const match of text.matchAll(/\[([^\]]+)\]\((\/[^)\s]*)\)/g)) {
    if (match.index > last) parts.push({ text: text.slice(last, match.index) });
    parts.push({ text: match[1], href: match[2] });
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
}
