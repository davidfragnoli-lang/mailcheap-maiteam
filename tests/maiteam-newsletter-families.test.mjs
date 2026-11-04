import assert from "node:assert/strict";
import { test } from "node:test";
import { findNewsletterFamilies, pickFamilyMember, sortFamily, splitLanguageName } from "../lib/maiteam/newsletter-families.js";

// PATCHES.md P16 (QI-28058): lists of one newsletter in several languages show as one row of the newsletter menu,
// derived from existing fields only.
const DAVID = "a1";
const OTHER = "b2";
const list = (id, name, language, accountId = DAVID) => ({ _id: id, name, language, accountId });

const fortuna = [
	list("f-en", "fortuna (EN)", "en"),
	list("f-fr", "fortuna (FR)", "fr"),
	list("f-it", "fortuna (IT)", "it"),
	list("f-de", "fortuna (DE)", "de"),
	list("f-es", "fortuna (ES)", "es"),
];

test("the suffix is split off, its language lowercase", () => {
	assert.deepEqual(splitLanguageName("fortuna (EN)"), { base: "fortuna", suffix: "en" });
	assert.deepEqual(splitLanguageName("  maiteam (fr) "), { base: "maiteam", suffix: "fr" });
	assert.deepEqual(splitLanguageName("maiteam"), { base: "maiteam", suffix: null });
	assert.deepEqual(splitLanguageName("notes (draft)"), { base: "notes (draft)", suffix: null });
});

test("the five fortuna lists and maiteam / maiteam (FR) are two families; a list alone is none", () => {
	const families = findNewsletterFamilies([...fortuna, list("m", "maiteam", "en"), list("m-fr", "maiteam (FR)", "fr"), list("s", "solo", "en")]);
	for (const { _id, language } of fortuna) assert.deepEqual(families.get(_id), { key: "f-en", name: "fortuna", language });
	assert.deepEqual(families.get("m"), { key: "m", name: "maiteam", language: "en" });
	assert.deepEqual(families.get("m-fr"), { key: "m", name: "maiteam", language: "fr" });
	assert.equal(families.has("s"), false);
});

test("no family without a set language, a matching suffix, one owner and distinct languages", () => {
	assert.equal(findNewsletterFamilies([list("1", "news (EN)", "en"), list("2", "news (FR)", undefined)]).size, 0, "language unset");
	assert.equal(findNewsletterFamilies([list("1", "news (EN)", "en"), list("2", "news (FR)", "de")]).size, 0, "suffix isn't the language");
	assert.equal(findNewsletterFamilies([list("1", "news (EN)", "en"), list("2", "news (FR)", "fr", OTHER)]).size, 0, "two owners");
	assert.equal(findNewsletterFamilies([list("1", "news", "en"), list("2", "news (EN)", "en")]).size, 0, "same language twice");
	assert.equal(findNewsletterFamilies([list("1", "news (EN)", "en"), list("2", "News (FR)", "fr")]).size, 0, "another base name");
	assert.equal(findNewsletterFamilies([list("1", "news (EN)", "en"), list("2", "news (PT)", "pt")]).size, 0, "a language mailcheap doesn't have");
});

test("a family row opens the language last used, else English, else the first in EN FR IT DE ES order", () => {
	const families = findNewsletterFamilies(fortuna);
	const members = [...fortuna].reverse().map(({ _id }) => ({ id: _id, family: families.get(_id) }));
	assert.deepEqual(
		sortFamily(members).map(({ family }) => family.language),
		["en", "fr", "it", "de", "es"],
	);
	assert.equal(pickFamilyMember(members, "de").id, "f-de");
	assert.equal(pickFamilyMember(members, null).id, "f-en");
	assert.equal(pickFamilyMember(members, "pt").id, "f-en");
	assert.equal(pickFamilyMember(members.filter(({ id }) => id !== "f-en"), null).id, "f-fr");
});

// The menu as the server renders it, closed: the trigger, and for a family the language row under it.
test("the menu names a family without its language and shows its languages; a single list shows as before", async () => {
	const { createElement } = await import("react");
	const { renderToStaticMarkup } = await import("react-dom/server");
	const MenuNewsletter = (await import("../components/MenuNewsletter.jsx")).default;
	const families = findNewsletterFamilies([...fortuna, list("s", "solo", "en")]);
	const options = [...fortuna, list("s", "solo", "en")].map(({ _id, name }) => ({ id: _id, name, imageUrl: null, role: null, family: families.get(_id) ?? null }));
	const render = (selectedId, isCompact = false) =>
		renderToStaticMarkup(createElement(MenuNewsletter, { newsletters: options, selectedId, savedId: selectedId, isCompact, addForm: null }));

	const full = render("f-fr");
	assert.match(full, /aria-label="Newsletter: fortuna, French"/);
	assert.doesNotMatch(full, /fortuna \(FR\)/);
	assert.match(full, /role="group" aria-label="fortuna language"/);
	const codes = [...full.matchAll(/aria-pressed="(true|false)"[^>]*>([A-Z]{2})</g)].map(([, pressed, code]) => `${code}:${pressed}`);
	assert.deepEqual(codes, ["EN:false", "FR:true", "IT:false", "DE:false", "ES:false"]);

	assert.match(render("f-de", true), /aria-label="Language: DE, German"/);

	const solo = render("s");
	assert.match(solo, /aria-label="Newsletter: solo"/);
	assert.doesNotMatch(solo, /language|aria-pressed/i);
});
