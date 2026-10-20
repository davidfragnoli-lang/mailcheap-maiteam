// maiteam (PATCHES.md P3c): the email looks accepted on the old fork (lib/email-theme.js at 7bdd14c), ported as
// they were: page and card colours, type, an optional text wordmark, the footer's tone, and dark-mode colours. A look
// is stored verbatim at Newsletter.theme.look and Campaign.look (models/maiteam-look-fields.js); without one, or with
// the default look, an email renders exactly as upstream's lib/themes.js makes it. Email clients get every colour
// inline and as a bgcolor attribute; the dark colours ride in a prefers-color-scheme block for the clients that read
// <style>. The editor opens this in the browser too, so it imports nothing server-only.

export const HEX_COLOR_PATTERN = /^#[0-9a-f]{6}$/;
export const MAX_WORDMARK_LENGTH = 60;

export const THEME_PRESETS = ["default", "landing", "letter", "maiteam"];
export const THEME_LAYOUTS = ["plain", "card"];
// Fonts every mail app has installed, so nothing is downloaded: Outlook, Gmail and Apple Mail show exactly these.
export const THEME_FONTS = ["system", "grotesk", "serif", "verdana"];
export const FOOTER_TONES = ["quiet", "plain"];
export const THEME_COLOR_KEYS = ["page", "card", "text", "accent", "muted"];

export const FONT_STACKS = {
	system: "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif",
	// The landing page sets headlines in Cabinet Grotesk; these are its own fallbacks.
	grotesk: "'Helvetica Neue',Helvetica,Arial,sans-serif",
	// The page's text face, Sentient, falls back to Georgia the same way.
	serif: "Georgia,'Times New Roman',Times,serif",
	// Drawn for screens: wide and very legible, also at small sizes.
	verdana: "Verdana,Geneva,sans-serif",
};

// Code only; never offered for headlines or text.
export const CODE_FONT_STACK = "ui-monospace,Menlo,Consolas,'Courier New',monospace";

// What the pickers show for each font, in this order.
export const THEME_FONT_OPTIONS = [
	{ id: "system", label: "System sans", note: "The reader's own: San Francisco, Segoe UI, Roboto." },
	{ id: "grotesk", label: "Helvetica / Arial", note: "The same neutral sans everywhere." },
	{ id: "serif", label: "Georgia", note: "A serif made for screens." },
	{ id: "verdana", label: "Verdana", note: "Large and very legible." },
];

// Today's look. heading, line and box are derived for custom colours and fixed here for the presets.
const DEFAULT_PRESET = {
	preset: "default",
	layout: "plain",
	headingFont: "system",
	bodyFont: "system",
	wordmark: "",
	wordmarkDot: false,
	titleFromSubject: false,
	footerTone: "quiet",
	light: {
		page: "#ffffff",
		card: "#ffffff",
		text: "#27272a",
		accent: "#18181b",
		muted: "#71717a",
		heading: "#09090b",
		line: "#e4e4e7",
		box: "#f4f4f5",
		rule: null,
	},
	dark: {
		enabled: false,
		page: "#111113",
		card: "#1b1b1f",
		text: "#e4e4e7",
		accent: "#fafafa",
		muted: "#a1a1aa",
		heading: "#fafafa",
		line: "#2e2e33",
		box: "#232327",
		rule: null,
	},
};

// Option A: davidfragnoli.ch in the inbox. Paper, a lighter card, ink, the page's orange on one rule
// and (deepened to pass WCAG AA on paper) on links, a small wordmark in the page's type stack.
const LANDING_PRESET = {
	preset: "landing",
	layout: "card",
	headingFont: "grotesk",
	bodyFont: "serif",
	wordmark: "",
	wordmarkDot: true,
	titleFromSubject: false,
	footerTone: "quiet",
	light: {
		page: "#f4f1ea",
		card: "#fcfbf8",
		text: "#121212",
		accent: "#b8380f",
		muted: "#6b675f",
		heading: "#121212",
		line: "#d5d0c5",
		box: "#ebe7de",
		rule: "#ff4d1c",
	},
	dark: {
		enabled: true,
		page: "#121212",
		card: "#1c1b19",
		text: "#ebe7de",
		accent: "#ff8a63",
		muted: "#a8a39a",
		heading: "#f4f1ea",
		line: "#3a3835",
		box: "#26241f",
		rule: "#ff4d1c",
	},
};

// Option B: a plain letter. White, no card, the subject as a serif headline, system text, navy links.
const LETTER_PRESET = {
	preset: "letter",
	layout: "plain",
	headingFont: "serif",
	bodyFont: "system",
	wordmark: "",
	wordmarkDot: false,
	titleFromSubject: true,
	footerTone: "quiet",
	light: {
		page: "#ffffff",
		card: "#ffffff",
		text: "#27272a",
		accent: "#1e40af",
		muted: "#71717a",
		heading: "#121212",
		line: "#e4e4e7",
		box: "#f4f4f5",
		rule: null,
	},
	dark: {
		enabled: true,
		page: "#0f0f10",
		card: "#0f0f10",
		text: "#e4e4e7",
		accent: "#93b4ff",
		muted: "#a1a1aa",
		heading: "#fafafa",
		line: "#2a2a2e",
		box: "#1f1f23",
		rule: null,
	},
};

// maiteam, rebuilt from the design system's tokens.json (maiteam-ships/.shared/brand/design-system, 20 Oct
// 2026): ink on ground, line hairlines, Helvetica/Arial as the email-safe stand-in for Inter, the subject as
// the headline. maiteam itself is grey; each product mail takes its own slot. The single call to action is
// a button (an <a data-button>), coloured apart from links: ink for company mail, the product's accent for
// product mail. Links carry the accent at text strength.
const MAITEAM_NEUTRALS = {
	light: { page: "#fafaf8", card: "#ffffff", text: "#1a1a18", heading: "#1a1a18", line: "#e6e4de", box: "#f2f1ec", rule: null },
	dark: { page: "#141412", card: "#1c1c1a", text: "#f2f1ec", heading: "#f2f1ec", line: "#2e2e2a", box: "#23231f", rule: null },
};
// accent: link colour (the slot's text-strength shade); button and buttonText: the CTA fill and its label.
const MAITEAM_SLOTS = {
	company: {
		light: { accent: "#6b6a64", muted: "#6b6a64", button: "#1a1a18", buttonText: "#fafaf8" },
		dark: { accent: "#a3a29b", muted: "#a3a29b", button: "#f2f1ec", buttonText: "#141412" },
	},
	fortuna: {
		light: { accent: "#6e5c96", muted: "#6b6a64", button: "#6e5c96", buttonText: "#ffffff" },
		dark: { accent: "#ae9cd2", muted: "#a3a29b", button: "#ae9cd2", buttonText: "#141412" },
	},
	// The fill is terracotta itself; its white label is 4.24:1, which the system allows at 16px semibold
	// (the button's size). Links use quote-to-invoice-accent-strong, since #c85a2a is under 4.5:1 as text.
	"quote-to-invoice": {
		light: { accent: "#9e4318", muted: "#6b6a64", button: "#c85a2a", buttonText: "#ffffff" },
		dark: { accent: "#d9703f", muted: "#a3a29b", button: "#d9703f", buttonText: "#141412" },
	},
};

function maiteamPreset(product) {
	const slot = MAITEAM_SLOTS[product] ?? MAITEAM_SLOTS.company;
	return {
		preset: "maiteam",
		product: MAITEAM_SLOTS[product] ? product : "company",
		layout: "plain",
		headingFont: "grotesk",
		bodyFont: "grotesk",
		wordmark: "",
		wordmarkDot: false,
		titleFromSubject: true,
		footerTone: "quiet",
		light: { ...MAITEAM_NEUTRALS.light, ...slot.light },
		dark: { enabled: true, ...MAITEAM_NEUTRALS.dark, ...slot.dark },
	};
}

const MAITEAM_PRESET = maiteamPreset("company");

// The petrol/teal maiteam look this preset replaced (FRA-25890). A saved look stores its colours and fonts, so in
// a maiteam look saved before products existed (no `product`), a value still equal to the old preset's is read
// as "not edited" and takes the new one; a value someone changed stays theirs. Looks saved since carry a
// product, and every value in them is a choice.
const LEGACY_MAITEAM_FONTS = { headingFont: "grotesk", bodyFont: "system" };
const LEGACY_MAITEAM_COLORS = {
	light: { page: "#ffffff", card: "#ffffff", text: "#0f1b1d", accent: "#0e5c63", muted: "#5b6b6d" },
	dark: { page: "#0f1b1d", card: "#16262a", text: "#e3eaea", accent: "#4fd1c5", muted: "#9aabad" },
};

// Which maiteam mail this is. Chosen explicitly in the picker and saved with the look; never read from the
// email's text.
export const THEME_PRODUCTS = Object.keys(MAITEAM_SLOTS);
export const THEME_PRODUCT_OPTIONS = [
	{ id: "company", label: "maiteam", note: "Company mail: grey links, an ink button." },
	{ id: "fortuna", label: "fortuna", note: "fortuna mail: malva links and button." },
	{ id: "quote-to-invoice", label: "quote-to-invoice", note: "quote-to-invoice mail: terracotta links and button." },
];

export const PRESETS = { default: DEFAULT_PRESET, landing: LANDING_PRESET, letter: LETTER_PRESET, maiteam: MAITEAM_PRESET };

// What the pickers show for each look.
export const THEME_LOOKS = [
	{ id: "default", label: "Default", note: "White, system type: the look every newsletter started with." },
	{ id: "landing", label: "Landing page", note: "Paper, a lighter card, serif text, grotesk headlines, orange on links and one rule, a text wordmark." },
	{ id: "letter", label: "Letter", note: "White, no card, the subject as a serif headline, system text, navy links." },
	{ id: "maiteam", label: "maiteam", note: "Warm white, ink, Helvetica, the subject as the headline, the wordmark; grey for company mail, the product's colour for product mail." },
];

// A saved look filled out with its preset's values, for the pickers: an older document stores only part.
export function completeTheme(saved) {
	const stored = withoutLegacy(saved);
	const base = presetTheme(stored?.preset, stored?.product);
	const full = {
		...base,
		...stored,
		light: { ...base.light, ...stored?.light },
		dark: { ...base.dark, ...stored?.dark },
	};
	if (base.product) full.product = base.product;
	else delete full.product;
	return full;
}

// What a saved look really chose: a maiteam look from before products loses the values still equal to the old
// petrol preset's.
// Named keys only, so a stored Mongoose subdocument reads the same as a plain object.
function withoutLegacy(stored) {
	if (stored?.preset !== "maiteam" || stored.product) return stored;
	const kept = {};
	for (const key of ["preset", "layout", "headingFont", "bodyFont", "wordmark", "titleFromSubject", "footerTone"]) {
		if (stored[key] !== undefined && LEGACY_MAITEAM_FONTS[key] !== stored[key]) kept[key] = stored[key];
	}
	for (const mode of ["light", "dark"]) {
		if (!stored[mode]) continue;
		kept[mode] = {};
		if (mode === "dark" && stored.dark.enabled !== undefined) kept.dark.enabled = stored.dark.enabled;
		for (const key of THEME_COLOR_KEYS) {
			const value = stored[mode][key];
			if (value !== undefined && value !== null && LEGACY_MAITEAM_COLORS[mode][key] !== value) kept[mode][key] = value;
		}
	}
	return kept;
}

// The full definition of a look; maiteam has one per product.
function presetBase(name, product) {
	if (name === "maiteam") return maiteamPreset(product);
	return PRESETS[name] ?? DEFAULT_PRESET;
}

// The wordmark a look starts with: the landing page shows the newsletter's name, maiteam its own.
export function presetWordmark(name, newsletterName = "", product = "company") {
	if (name === "landing") return String(newsletterName ?? "").trim().slice(0, MAX_WORDMARK_LENGTH);
	if (name === "maiteam") return MAITEAM_SLOTS[product] && product !== "company" ? product : "maiteam";
	return "";
}

function cloneColors(colors) {
	return { ...colors };
}

// What the dashboard stores: the preset plus the colours it shows, so an edit survives.
export function presetTheme(name, product) {
	const base = presetBase(name, product);
	return {
		preset: base.preset,
		...(base.product ? { product: base.product } : {}),
		layout: base.layout,
		headingFont: base.headingFont,
		bodyFont: base.bodyFont,
		wordmark: "",
		titleFromSubject: base.titleFromSubject,
		footerTone: base.footerTone,
		light: Object.fromEntries(THEME_COLOR_KEYS.map((key) => [key, base.light[key]])),
		dark: { enabled: base.dark.enabled, ...Object.fromEntries(THEME_COLOR_KEYS.map((key) => [key, base.dark[key]])) },
	};
}

function isHex(value) {
	return typeof value === "string" && HEX_COLOR_PATTERN.test(value);
}

function hexToRgb(hex) {
	return [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16));
}

function rgbToHex(rgb) {
	return `#${rgb.map((channel) => Math.round(Math.min(255, Math.max(0, channel))).toString(16).padStart(2, "0")).join("")}`;
}

// `amount` of `to` over `from`, in sRGB; enough for hairlines and box tints.
export function mixColors(from, to, amount) {
	const a = hexToRgb(from);
	const b = hexToRgb(to);
	return rgbToHex(a.map((channel, index) => channel + (b[index] - channel) * amount));
}

function relativeLuminance(hex) {
	const [r, g, b] = hexToRgb(hex)
		.map((channel) => channel / 255)
		.map((channel) => (channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4));
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// WCAG 2 contrast ratio, 1 to 21. AA text needs 4.5.
export function contrastRatio(foreground, background) {
	const [light, dark] = [relativeLuminance(foreground), relativeLuminance(background)].sort((a, b) => b - a);
	return (light + 0.05) / (dark + 0.05);
}

function resolveColors(base, stored, { derive }) {
	const colors = cloneColors(base);
	let changed = false;
	for (const key of THEME_COLOR_KEYS) {
		if (isHex(stored?.[key]) && stored[key] !== base[key]) {
			colors[key] = stored[key];
			changed = true;
		}
	}
	// Edited colours keep the preset's heading, line and box only while they still fit; a new page or text
	// colour gets a hairline and box tinted from the new values instead.
	if (changed && derive) {
		colors.heading = colors.text;
		colors.line = mixColors(colors.page, colors.text, 0.14);
		colors.box = mixColors(colors.card, colors.text, 0.06);
	}
	// A look without its own button (every one but maiteam) fills it with the link colour, labelled in the card's.
	colors.button = base.button ?? colors.accent;
	colors.buttonText = base.buttonText ?? colors.card;
	return colors;
}

function pick(value, allowed, fallback) {
	return allowed.includes(value) ? value : fallback;
}

// The full set of values the renderer reads. `theme` is what the newsletter stores, or nothing.
export function resolveTheme(saved) {
	const theme = withoutLegacy(saved);
	const base = presetBase(theme?.preset, theme?.product);
	const light = resolveColors(base.light, theme?.light, { derive: true });
	const darkStored = theme?.dark;
	const dark = resolveColors(base.dark, darkStored, { derive: true });
	dark.enabled = typeof darkStored?.enabled === "boolean" ? darkStored.enabled : base.dark.enabled;
	const wordmark = typeof theme?.wordmark === "string" ? theme.wordmark.trim().slice(0, MAX_WORDMARK_LENGTH) : "";
	return {
		preset: base.preset,
		product: base.product ?? null,
		layout: pick(theme?.layout, THEME_LAYOUTS, base.layout),
		headingFont: pick(theme?.headingFont, THEME_FONTS, base.headingFont),
		bodyFont: pick(theme?.bodyFont, THEME_FONTS, base.bodyFont),
		wordmark,
		wordmarkDot: base.wordmarkDot,
		titleFromSubject: typeof theme?.titleFromSubject === "boolean" ? theme.titleFromSubject : base.titleFromSubject,
		footerTone: pick(theme?.footerTone, FOOTER_TONES, base.footerTone),
		light,
		dark,
	};
}

const DEFAULT_RESOLVED = JSON.stringify(resolveTheme(null));

// True when the email should render exactly as it did before themes existed.
export function isDefaultTheme(resolved) {
	return JSON.stringify(resolved) === DEFAULT_RESOLVED;
}

// Checks one look, however it arrived. Colour values are raw strings; a null dark colour while dark mode is
// off takes the look's own. Returns the theme to store, or the first problem.
function validateTheme({ preset: rawPreset, product: rawProduct, layout: rawLayout, headingFont: rawHeading, bodyFont: rawBody, footerTone: rawFooter, wordmark: rawWordmark, titleFromSubject, darkEnabled, light, dark }) {
	const preset = pick(rawPreset, THEME_PRESETS, null);
	if (!preset) return { error: "Choose a look for the emails" };
	// Only maiteam has products. A form or autosave from before products existed means company mail.
	const product = preset === "maiteam" ? pick(rawProduct ?? "company", THEME_PRODUCTS, null) : undefined;
	if (product === null) return { error: "The email look has an unknown option" };
	const base = presetBase(preset, product);
	const layout = pick(rawLayout, THEME_LAYOUTS, null);
	const headingFont = pick(rawHeading, THEME_FONTS, null);
	const bodyFont = pick(rawBody, THEME_FONTS, null);
	const footerTone = pick(rawFooter, FOOTER_TONES, null);
	if (!layout || !headingFont || !bodyFont || !footerTone) return { error: "The email look has an unknown option" };
	const wordmark = String(rawWordmark ?? "").trim();
	if (wordmark.length > MAX_WORDMARK_LENGTH) return { error: `Keep the wordmark under ${MAX_WORDMARK_LENGTH} characters` };
	if (/[\p{Cc}]/u.test(wordmark)) return { error: "The wordmark can only hold printable text" };
	const colors = { light: {}, dark: {} };
	for (const [mode, source] of [["light", light], ["dark", dark]]) {
		for (const key of THEME_COLOR_KEYS) {
			const raw = source?.[key] ?? null;
			if (raw === null && mode === "dark" && !darkEnabled) {
				colors.dark[key] = base.dark[key];
				continue;
			}
			const value = String(raw ?? "").trim().toLowerCase();
			if (!isHex(value)) return { error: `${capitalize(mode)} ${COLOR_LABELS[key]} colour must be a hex value like #f4f1ea` };
			colors[mode][key] = value;
		}
	}
	return {
		theme: {
			preset,
			...(product ? { product } : {}),
			layout,
			headingFont,
			bodyFont,
			wordmark,
			titleFromSubject: titleFromSubject === true,
			footerTone,
			light: colors.light,
			dark: { enabled: darkEnabled === true, ...colors.dark },
		},
	};
}

// Reads the dashboard form. `read(name)` returns the field's string, or null when it was not sent.
export function readThemeForm(read) {
	if (read("themePreset") === null) return { theme: undefined };
	const colorsOf = (mode) => Object.fromEntries(THEME_COLOR_KEYS.map((key) => [key, read(`theme${capitalize(mode)}${capitalize(key)}`)]));
	return validateTheme({
		preset: read("themePreset"),
		product: read("themeProduct"),
		layout: read("themeLayout"),
		headingFont: read("themeHeadingFont"),
		bodyFont: read("themeBodyFont"),
		footerTone: read("themeFooterTone"),
		wordmark: read("themeWordmark"),
		titleFromSubject: read("themeTitleFromSubject") === "on",
		darkEnabled: read("themeDarkEnabled") === "on",
		light: colorsOf("light"),
		dark: colorsOf("dark"),
	});
}

// Reads a look sent as an object (the campaign editor's autosave, a sequence step's hidden field). Nothing,
// null or an empty string means "the newsletter's look" and comes back as null.
export function parseThemeInput(value) {
	if (value === undefined || value === null || value === "") return { theme: null };
	if (typeof value !== "object" || Array.isArray(value)) return { error: "The email look is not valid" };
	return validateTheme({
		preset: value.preset,
		product: value.product,
		layout: value.layout,
		headingFont: value.headingFont,
		bodyFont: value.bodyFont,
		footerTone: value.footerTone,
		wordmark: value.wordmark,
		titleFromSubject: value.titleFromSubject === true,
		darkEnabled: value.dark?.enabled === true,
		light: value.light ?? {},
		dark: value.dark ?? {},
	});
}

// An issue (Campaign.look) or a sequence step with its own look uses it; otherwise the newsletter's
// (Newsletter.theme.look) applies, and without either upstream's theme does.
export function effectiveLook(content, newsletter) {
	return content?.look ?? newsletter?.theme?.look ?? null;
}

// The text and background pairs of a look that fall under their minimum (WCAG AA 4.5), for the pickers' warning.
export function contrastProblems(theme) {
	const resolved = resolveTheme(theme);
	return contrastPairs(resolved)
		.map((pair) => ({ ...pair, ratio: contrastRatio(pair.foreground, pair.background) }))
		.filter((pair) => pair.ratio < pair.minimum);
}

// The button label is 16px semibold. maiteam's tokens accept an on-accent label from 4.24:1 at that size
// (quote-to-invoice terracotta), so the button pair is held to that rather than to 4.5.
export const BUTTON_LABEL_MINIMUM = 4.2;

export const COLOR_LABELS = {
	page: "page background",
	card: "card background",
	text: "text",
	accent: "link",
	muted: "footer",
};

function capitalize(value) {
	return value.charAt(0).toUpperCase() + value.slice(1);
}

// Text and background pairs a reader has to be able to read, for the WCAG AA check.
export function contrastPairs(resolved) {
	const pairs = [];
	for (const mode of ["light", "dark"]) {
		if (mode === "dark" && !resolved.dark.enabled) continue;
		const colors = resolved[mode];
		const surfaces = resolved.layout === "card" ? ["page", "card"] : ["page"];
		for (const surface of surfaces) {
			pairs.push({ mode, name: `text on ${surface}`, foreground: colors.text, background: colors[surface], minimum: 4.5 });
			pairs.push({ mode, name: `heading on ${surface}`, foreground: colors.heading, background: colors[surface], minimum: 4.5 });
			pairs.push({ mode, name: `link on ${surface}`, foreground: colors.accent, background: colors[surface], minimum: 4.5 });
		}
		pairs.push({ mode, name: "text in box", foreground: colors.text, background: colors.box, minimum: 4.5 });
		pairs.push({ mode, name: "link in box", foreground: colors.accent, background: colors.box, minimum: 4.5 });
		const footer = resolved.footerTone === "quiet" ? colors.muted : colors.text;
		pairs.push({ mode, name: "footer on page", foreground: footer, background: colors.page, minimum: 4.5 });
		pairs.push({ mode, name: "button label", foreground: colors.buttonText, background: colors.button, minimum: BUTTON_LABEL_MINIMUM });
	}
	return pairs;
}
