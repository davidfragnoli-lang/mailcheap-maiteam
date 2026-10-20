import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  CHANGELOG,
  WHATS_NEW_LIMIT,
  getUnseenEntries,
  splitEntryText,
} from "../lib/maiteam/changelog.js";
import { listAppPages } from "./helpers/app-pages.mjs";
import { activate, as, signIn, startTestApp } from "./helpers/app.mjs";

// P10 (PATCHES.md), COO's R7 disposition (FRA-25998): the what's new card in upstream's WhatsNew slot, with this
// server's own release entries, closed per account in upstream's Account.changelog.seen.
const ROOT = fileURLToPath(new URL("../", import.meta.url));
// The names P2 lowercases, spelled out of parts so P2's own check passes this file.
const UPPERCASE_NAMES = new RegExp(
  [
    ["Mail", "Cheap"],
    ["mAI", "fortune"],
    ["Q", "2I"],
  ]
    .map((parts) => parts.join(""))
    .join("|"),
);
let app;
let m;

before(async () => {
  app = await startTestApp();
  m = {
    extensions: await import("../components/marketing/SiteExtensions.jsx"),
    defaults: await import("../components/SiteExtensions.jsx"),
    actions: await import("../lib/maiteam/whats-new-actions.js"),
    Account: (await import("../models/Account.js")).default,
  };
});

after(() => app?.stop());

test("entries: unique ids, ISO dates newest first, a title and text, and commits this history has", () => {
  assert.ok(CHANGELOG.length >= 8);
  assert.equal(new Set(CHANGELOG.map(({ id }) => id)).size, CHANGELOG.length);
  const dates = CHANGELOG.map(({ date }) => date);
  assert.deepEqual(dates, [...dates].sort().reverse());
  const hasGit = existsSync(`${ROOT}.git`);
  for (const { id, date, title, text, commits } of CHANGELOG) {
    assert.match(date, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(id.startsWith(date), `${id} starts with its date`);
    assert.ok(title && text, id);
    assert.doesNotMatch(
      `${title} ${text}`,
      UPPERCASE_NAMES,
      `${id}: product names in lowercase`,
    );
    assert.ok(commits.length, `${id} names its commits`);
    if (hasGit)
      for (const commit of commits)
        execFileSync("git", ["cat-file", "-e", `${commit}^{commit}`], {
          cwd: ROOT,
        });
  }
});

test("every entry links the dashboard pages it names, and each link is one of the app's pages", async () => {
  const pages = await listAppPages();
  for (const { id, text } of CHANGELOG) {
    const links = splitEntryText(text).filter(({ href }) => href);
    assert.ok(links.length, `${id} links a page`);
    for (const { href } of links)
      assert.ok(pages.has(href), `${id}: ${href} is a page`);
  }
  assert.deepEqual(splitEntryText("See [Sender](/newsletters/sender) now."), [
    { text: "See " },
    { text: "Sender", href: "/newsletters/sender" },
    { text: " now." },
  ]);
});

test("the site extension fills only WhatsNew; every other slot stays the open source's", () => {
  assert.equal(typeof m.extensions.WhatsNew, "function");
  assert.equal(m.defaults.WhatsNew, null);
  for (const [name, value] of Object.entries(m.defaults))
    if (name !== "WhatsNew") assert.equal(m.extensions[name], value, name);
  assert.deepEqual(
    Object.keys(m.extensions).sort(),
    Object.keys(m.defaults).sort(),
  );
});

test("the card lists the newest unseen entries; closing it marks them all seen on the account, unknown ids ignored", async () => {
  const user = await signIn("whats-new@example.com");
  await activate(user);
  const read = () => m.Account.findById(user.accountId).lean();

  const html = renderToStaticMarkup(
    createElement(m.extensions.WhatsNew, { account: await read() }),
  );
  assert.match(html, /What&#x27;s new/);
  for (const { title } of CHANGELOG.slice(0, WHATS_NEW_LIMIT))
    assert.ok(html.includes(title), title);
  assert.ok(
    !html.includes(CHANGELOG[WHATS_NEW_LIMIT].title),
    "only the newest are shown",
  );
  assert.ok(html.includes(`And ${CHANGELOG.length - WHATS_NEW_LIMIT} more`));
  assert.match(html, /href="\/sequences"/);

  await as(user, () =>
    m.actions.markChangelogSeen([CHANGELOG[0].id, "not-an-entry", 7]),
  );
  assert.deepEqual((await read()).changelog.seen, [CHANGELOG[0].id]);
  assert.equal(getUnseenEntries(await read()).length, CHANGELOG.length - 1);

  await as(user, () =>
    m.actions.markChangelogSeen(CHANGELOG.map(({ id }) => id)),
  );
  assert.equal(
    (await read()).changelog.seen.length,
    CHANGELOG.length,
    "no duplicates",
  );
  assert.equal(
    renderToStaticMarkup(
      createElement(m.extensions.WhatsNew, { account: await read() }),
    ),
    "",
    "nothing new: no card",
  );

  const other = await signIn("whats-new-other@example.com");
  await activate(other);
  assert.equal(
    getUnseenEntries(await m.Account.findById(other.accountId).lean()).length,
    CHANGELOG.length,
    "another account is untouched",
  );
});
