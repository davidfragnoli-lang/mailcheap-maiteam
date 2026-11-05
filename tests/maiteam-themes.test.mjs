import assert from "node:assert/strict";
import { test } from "node:test";
import { getContrast } from "../lib/colors.js";
import { getConfirmationContent } from "../lib/confirmation-content.js";
import { renderEmail } from "../lib/render-email.js";
import { getFont, getFontFaceCss, getFontStack } from "../lib/theme-fonts.js";
import { PRESET_IDS, getEmailTheme, getThemeVariables, normalizeTheme, resolveTheme } from "../lib/themes.js";

// maiteam's looks (PATCHES.md P3), from maiteam-ships/.shared/brand/design-system/tokens.json, 20 Oct 2026.
const TOKENS = { ground: "#fafaf8", ink: "#1a1a18", line: "#e6e4de", inkMuted: "#6b6a64", surfaceMuted: "#f2f1ec", darkGround: "#141412" };
const HELVETICA = "'Helvetica Neue',Helvetica,Arial,sans-serif";
const PETROL = ["#0e5c63", "#4fd1c5", "#0f1b1d", "#5b6b6d"];
const SLOTS = {
	maiteam: { link: "#6b6a64", button: "#1a1a18", label: "#fafaf8", dark: { link: "#a3a29b", button: "#f2f1ec", label: "#141412" } },
	fortuna: { link: "#6e5c96", button: "#6e5c96", label: "#ffffff", dark: { link: "#ae9cd2", button: "#ae9cd2", label: "#141412" } },
	"quote-to-invoice": { link: "#9e4318", button: "#c85a2a", label: "#ffffff", dark: { link: "#d9703f", button: "#d9703f", label: "#141412" } },
};
const newsletter = (preset) => ({ name: preset, postalAddress: "Sample address", theme: { preset } });
const BUTTON = (href) => `<a href="${href}" style="display:inline-block;background:#18181b;color:#ffffff;text-decoration:none;font-weight:600;padding:12px 20px;border-radius:8px;">Start here</a>`;

test("maiteam company and product mail: shared ground, ink and line, Helvetica, the slot's link and button", () => {
	for (const [preset, slot] of Object.entries(SLOTS)) {
		const markdown = `Hello, a [link](https://maiteam.ch/a).\n\n${BUTTON("https://maiteam.ch/go")}\n\nDavid`;
		const { html } = renderEmail({ markdown, subject: "Hi", newsletter: newsletter(preset) });
		assert.match(html, new RegExp(`<body[^>]* style="margin:0;padding:0;background:${TOKENS.ground};">`), `${preset}: ground`);
		// Upstream e6b5d72's dark palette, from the tokens' dark variants (lib/maiteam/email-look.js has the same).
		const darkBlock = html.slice(html.indexOf("prefers-color-scheme: dark"));
		assert.ok(darkBlock.includes(`background: ${TOKENS.darkGround} !important;`), `${preset}: dark ground`);
		assert.ok(darkBlock.includes(`.body a { color: ${slot.dark.link}; }`), `${preset}: dark link`);
		assert.ok(darkBlock.includes(`background: ${slot.dark.button} !important; color: ${slot.dark.label} !important;`), `${preset}: dark button`);
		assert.ok(html.includes(`font-family:${HELVETICA};font-size:16px;line-height:1.65;color:${TOKENS.ink};`), `${preset}: Helvetica in ink`);
		assert.ok(html.includes(`.body a { color: ${slot.link}; }`), `${preset}: link`);
		assert.ok(html.includes(`background:${slot.button};color:${slot.label};`), `${preset}: button`);
		assert.ok(html.includes(`color: ${TOKENS.ink}; font-family: ${HELVETICA}; font-weight: 700;`), `${preset}: headings`);
		assert.match(html, new RegExp(`color:${TOKENS.inkMuted};border-top:1px solid ${TOKENS.line};`), `${preset}: footer`);
		assert.ok(!/@font-face|\/fonts\//.test(html), `${preset}: nothing to download`);
		for (const colour of PETROL) assert.ok(!html.includes(colour), `${preset}: no ${colour}`);
		for (const [other, { button }] of Object.entries(SLOTS)) {
			if (other !== preset && other !== "maiteam") assert.ok(!html.includes(button), `${preset}: never ${other}'s accent`);
		}
	}
});

test("the product is the saved preset: the email's words never choose it", () => {
	const markdown = `fortuna and quote-to-invoice are maiteam products.\n\n${BUTTON("https://maiteam.ch")}`;
	const { html } = renderEmail({ markdown, subject: "Hi", newsletter: newsletter("maiteam") });
	assert.ok(html.includes("background:#1a1a18;color:#fafaf8;"));
	for (const colour of ["#6e5c96", "#c85a2a", "#9e4318"]) assert.ok(!html.includes(colour));
	for (const id of ["maiteam", "fortuna", "quote-to-invoice", "landing"]) {
		assert.ok(PRESET_IDS.includes(id));
		assert.deepEqual(normalizeTheme({ preset: id }), { preset: id }, `${id} is stored as itself`);
	}
});

test("company mail keeps its button ink and its links grey; the built-in confirmation button is repainted", () => {
	const { link, button, buttonText } = getEmailTheme(resolveTheme({ preset: "maiteam" }));
	assert.deepEqual([link, button, buttonText], ["#6b6a64", "#1a1a18", "#fafaf8"]);
	const confirmation = getConfirmationContent({ name: "fortuna" });
	const { html } = renderEmail({ ...confirmation, newsletter: newsletter("fortuna") });
	// Upstream draws its built-in button from the theme now (lib/buttons.js getEmailButtonHtml).
	assert.ok(html.includes("background:#6e5c96;color:#ffffff;"), "the confirmation button takes fortuna's malva");
	assert.equal(html.match(/<a[^>]*style="display:inline-block;[^"]*background:/g).length, 1, "one button per message");
});

test("contrast: text and links pass AA on the ground; the terracotta label is the tokens' 16px exception", () => {
	for (const [preset, slot] of Object.entries(SLOTS)) {
		const theme = getEmailTheme(resolveTheme({ preset }));
		assert.ok(getContrast(theme.text, theme.background) >= 7, `${preset} text`);
		assert.ok(getContrast(slot.link, TOKENS.ground) >= 4.5, `${preset} links`);
		assert.ok(getContrast(theme.muted, theme.background) >= 4.5, `${preset} footer`);
		assert.ok(getContrast(theme.buttonText, theme.button) >= (preset === "quote-to-invoice" ? 4.2 : 4.5), `${preset} label`);
	}
	assert.equal(getContrast("#ffffff", "#c85a2a").toFixed(2), "4.24");
});

test("a changed color drops the token shades and derives them again, like every other preset", () => {
	const recolored = resolveTheme({ preset: "fortuna", colors: { accent: "#123456" } });
	assert.deepEqual(recolored.fixed, {});
	assert.equal(getEmailTheme(recolored).button, "#123456");
	assert.notEqual(getEmailTheme(recolored).text, TOKENS.ink, "body text is derived again");
	const site = getThemeVariables(resolveTheme({ preset: "maiteam" }));
	assert.equal(site["--primary"], TOKENS.ink, "the site's primary is ink, as the design system's shadcn mapping says");
	assert.equal(site["--muted-foreground"], TOKENS.inkMuted);
	assert.equal(site["--border"], TOKENS.line);
	assert.equal(site["--muted"], TOKENS.surfaceMuted);
});

test("the email-safe faces load nothing and name their own stacks", () => {
	for (const id of ["helvetica", "georgia"]) {
		const font = getFont(id);
		assert.equal(getFontFaceCss([font]), "");
		assert.ok(!getFontStack(font).includes("'MC "));
	}
	assert.equal(getFontStack(getFont("helvetica")), HELVETICA);
});

test("the landing look keeps davidfragnoli.ch's paper, ink, deep orange links and Georgia text", () => {
	const theme = getEmailTheme(resolveTheme({ preset: "landing" }));
	assert.deepEqual(
		[theme.background, theme.text, theme.heading, theme.link, theme.muted, theme.border, theme.surface],
		["#f4f1ea", "#121212", "#121212", "#b8380f", "#6b675f", "#d5d0c5", "#ebe7de"]
	);
	assert.equal(theme.fonts.body, "Georgia,'Times New Roman',Times,serif");
	assert.equal(theme.fonts.heading, HELVETICA);
});

// FRA-25998 r9 (upstream e6b5d72): themes have a light and a dark palette. The maiteam presets fix each mode's shades
// from the tokens, and a changed colour in either mode hands both back to upstream's derived shades.
test("the maiteam presets' fixed shades hold in both modes until a colour changes", () => {
	const fortuna = resolveTheme({ preset: "fortuna" });
	assert.equal(fortuna.modes.light.palette.link, "#6e5c96");
	assert.equal(fortuna.modes.dark.palette.link, "#ae9cd2");
	assert.equal(fortuna.modes.dark.colors.background, "#141412");
	assert.equal(getEmailTheme(fortuna).dark.border, "#2e2e2a");
	const recolored = resolveTheme({ preset: "fortuna", lightColors: { accent: "#3355aa" } });
	assert.notEqual(recolored.modes.light.palette.link, "#6e5c96");
	assert.notEqual(recolored.modes.dark.palette.border, "#2e2e2a", "the dark mode's fixed shades go too");
	assert.equal(resolveTheme({ preset: "landing" }).modes.light.palette.link, "#b8380f", "the landing page's light palette is unchanged");
});
