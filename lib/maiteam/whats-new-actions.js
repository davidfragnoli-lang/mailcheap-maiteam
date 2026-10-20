"use server";

import { revalidatePath } from "next/cache";
import { requireAccount } from "@/lib/auth";
import { isChangelogId } from "@/lib/maiteam/changelog";
import Account from "@/models/Account";

// maiteam (PATCHES.md P10): closing the what's new card marks the entries it listed as seen, on the account, so the card
// stays closed on every device until a new entry ships. Ids this server doesn't know are ignored.
export async function markChangelogSeen(ids) {
  const { account } = await requireAccount();
  const known = [...new Set(Array.isArray(ids) ? ids : [])].filter(
    (id) => typeof id === "string" && isChangelogId(id),
  );
  if (known.length)
    await Account.updateOne(
      { _id: account._id },
      { $addToSet: { "changelog.seen": { $each: known } } },
    );
  revalidatePath("/", "layout");
  return { ok: true };
}
