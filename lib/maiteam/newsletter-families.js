// maiteam (PATCHES.md P16, QI-28058): one list per language of the same newsletter ("fortuna (EN)" … "fortuna (ES)",
// "maiteam" and "maiteam (FR)") shows as one row of the newsletter menu, with a language selector. Display only: each
// list keeps its own settings, contacts, campaigns and sequences, and nothing is stored.
//
// A family is derived from existing fields only. Lists of the same owner (accountId) whose names are the same base name,
// alone or followed by a "(XX)" suffix, and whose `language` is set, form one when there are at least two and no two
// have the same language. A "(XX)" suffix has to name the list's own language. Anything else stays a row of its own.

// The selector's order, by David (QI-28058).
export const FAMILY_LANGUAGES = ["en", "fr", "it", "de", "es"];

export const LANGUAGE_LABELS = { en: "English", fr: "French", it: "Italian", de: "German", es: "Spanish" };

const SUFFIX = /^(.*\S)\s*\(([A-Za-z]{2})\)$/;

// The base name and the suffix's language, lowercase, if the name has one.
export function splitLanguageName(name) {
	const trimmed = String(name ?? "").trim();
	const match = trimmed.match(SUFFIX);
	return match ? { base: match[1], suffix: match[2].toLowerCase() } : { base: trimmed, suffix: null };
}

// newsletters: { _id, name, accountId, language }. Returns a Map from each grouped list's ID to its family:
// { key, name, language }. key: the family's first list's ID, so it stays the same as long as that list exists.
export function findNewsletterFamilies(newsletters) {
	const candidates = new Map();
	for (const newsletter of newsletters ?? []) {
		const language = newsletter.language;
		if (!FAMILY_LANGUAGES.includes(language) || !newsletter.accountId) continue;
		const { base, suffix } = splitLanguageName(newsletter.name);
		if (!base || (suffix && suffix !== language)) continue;
		const key = `${newsletter.accountId}\u0000${base}`;
		const members = candidates.get(key) ?? [];
		members.push({ id: String(newsletter._id), base, language });
		candidates.set(key, members);
	}
	const families = new Map();
	for (const members of candidates.values()) {
		if (members.length < 2 || new Set(members.map(({ language }) => language)).size !== members.length) continue;
		const key = members[0].id;
		for (const { id, base, language } of members) families.set(id, { key, name: base, language });
	}
	return families;
}

// The list a family row opens: the language last used, else English, else the first in the selector's order.
export function pickFamilyMember(members, lastLanguage) {
	const sorted = sortFamily(members);
	return sorted.find(({ family }) => family.language === lastLanguage) ?? sorted.find(({ family }) => family.language === "en") ?? sorted[0] ?? null;
}

export function sortFamily(members) {
	return [...members].sort((a, b) => FAMILY_LANGUAGES.indexOf(a.family.language) - FAMILY_LANGUAGES.indexOf(b.family.language));
}

export function familyLanguageKey(familyKey) {
	return `mailcheap:family-language:${familyKey}`;
}
