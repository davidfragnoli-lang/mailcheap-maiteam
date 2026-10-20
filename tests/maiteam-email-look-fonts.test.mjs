import assert from "node:assert/strict";
import { test } from "node:test";
import {
	CODE_FONT_STACK,
	FONT_STACKS,
	THEME_FONTS,
	THEME_FONT_OPTIONS,
	contrastProblems,
	isDefaultTheme,
	parseThemeInput,
	presetTheme,
	readThemeForm,
	resolveTheme,
} from "../lib/maiteam/email-look.js";
import { UNSUBSCRIBE_PLACEHOLDER, renderEmail } from "../lib/render-email.js";
import { lookFields as themeFields } from "../models/maiteam-look-fields.js";

// maiteam (PATCHES.md P3c): the old fork's font tests (tests/email-fonts.test.mjs at 7bdd14c), on the port. Its
// pre-send contrast check and Gmail-like preview were not ported (PATCHES.md, known gaps).

const GMAIL_CLIP_BYTES = 102 * 1024;
const newsletter = { name: "Field Notes", postalAddress: "Rue de l'Exemple 1, 2000 Neuchâtel" };
// Every kind of text block the editor and Markdown can produce.
const issue = {
	subject: "Four fonts, one footer",
	previewText: "A sample of every text block.",
	markdown: [
		"# A headline with a [link](https://example.com/h)",
		"",
		"A paragraph with `inline code` and a [link](https://example.com/p), long enough to wrap.",
		"",
		"## Second headline",
		"",
		"- A tight list item",
		"- Another",
		"",
		"1. A loose item",
		"",
		"2. With a gap",
		"",
		"> A quote",
		"",
		"| Head | Cell |",
		"| --- | --- |",
		"| a | b |",
		"",
		"```",
		"const block = true;",
		"```",
		"",
		":::box",
		"An aside in a box.",
		":::",
		"",
		"Jane",
	].join("\n"),
};

function render(look, extra = {}) {
	return renderEmail({ ...issue, newsletter: { ...newsletter, theme: { look } }, ...extra });
}

// The opening tags of `name` in the body column (between the body cell and the footer).
function openingTags(html, name) {
	const body = html.slice(html.indexOf('<td class="body"'), html.indexOf('<td class="footer"'));
	return body.match(new RegExp(`<${name}\\b[^>]*>`, "gi")) ?? [];
}

function fontOf(tag) {
	return /font-family:([^;"]+)/i.exec(tag)?.[1] ?? null;
}

test("the picker offers the four email-safe stacks and nothing to download; monospace is code only", () => {
	assert.deepEqual(THEME_FONTS, ["system", "grotesk", "serif", "verdana"]);
	assert.deepEqual(THEME_FONT_OPTIONS.map((option) => option.id), THEME_FONTS);
	assert.deepEqual(THEME_FONT_OPTIONS.map((option) => option.label), ["System sans", "Helvetica / Arial", "Georgia", "Verdana"]);
	assert.equal(FONT_STACKS.system, "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif");
	assert.equal(FONT_STACKS.serif, "Georgia,'Times New Roman',Times,serif");
	assert.equal(FONT_STACKS.verdana, "Verdana,Geneva,sans-serif");
	assert.match(FONT_STACKS.grotesk, /^('Helvetica Neue',)?Helvetica,Arial,sans-serif$/);
	for (const stack of [...Object.values(FONT_STACKS), CODE_FONT_STACK]) {
		assert.doesNotMatch(stack, /url\(|@import|https?:|@font-face/i, `${stack} loads nothing`);
	}
	assert.match(CODE_FONT_STACK, /monospace$/);
	assert.ok(!THEME_FONTS.includes("mono") && !Object.values(FONT_STACKS).includes(CODE_FONT_STACK), "no monospace body font");
	// The stored enum follows the same list, so a saved Verdana look passes the model.
	assert.deepEqual(themeFields.headingFont.enum, THEME_FONTS);
	assert.deepEqual(themeFields.bodyFont.enum, THEME_FONTS);
});

test("Verdana is accepted from the form and from the editor, monospace and unknown fonts are refused", () => {
	const base = presetTheme("default");
	assert.equal(parseThemeInput({ ...base, headingFont: "verdana", bodyFont: "verdana" }).theme.bodyFont, "verdana");
	assert.match(parseThemeInput({ ...base, bodyFont: "mono" }).error, /unknown option/);
	assert.match(parseThemeInput({ ...base, headingFont: "Comic Sans" }).error, /unknown option/);
	const values = {
		themePreset: "default",
		themeLayout: "plain",
		themeHeadingFont: "serif",
		themeBodyFont: "verdana",
		themeFooterTone: "quiet",
		themeWordmark: "",
		themeLightPage: "#ffffff",
		themeLightCard: "#ffffff",
		themeLightText: "#27272a",
		themeLightAccent: "#18181b",
		themeLightMuted: "#71717a",
	};
	const { theme, error } = readThemeForm((name) => (name in values ? values[name] : null));
	assert.equal(error, undefined);
	assert.equal(theme.headingFont, "serif");
	assert.equal(theme.bodyFont, "verdana");
	assert.match(readThemeForm((name) => (name === "themeBodyFont" ? "mono" : values[name] ?? null)).error, /unknown option/);
	// A stored value from before the list grew still resolves, an unknown one falls back to the look's own.
	assert.equal(resolveTheme({ preset: "letter", bodyFont: "verdana" }).bodyFont, "verdana");
	assert.equal(resolveTheme({ preset: "letter", bodyFont: "papyrus" }).bodyFont, "system");
});

for (const font of THEME_FONTS) {
	test(`${font}: the stack is inline on every text block, headings keep theirs, code is monospace`, () => {
		// On the Letter look: the default look with system type is the untitled email, which stays as it was.
		const { html, bytes } = render({ ...presetTheme("letter"), headingFont: font, bodyFont: font });
		const stack = FONT_STACKS[font];
		for (const name of ["p", "li", "blockquote", "td", "th"]) {
			const tags = openingTags(html, name);
			assert.ok(tags.length > 0, `${name} present`);
			for (const tag of tags) assert.equal(fontOf(tag), stack, `${name} carries the stack: ${tag}`);
		}
		for (const name of ["h1", "h2"]) {
			const tags = openingTags(html, name);
			assert.ok(tags.length > 0, `${name} present`);
			for (const tag of tags) assert.equal(fontOf(tag), stack, `${name} carries the headline stack`);
		}
		for (const name of ["code", "pre"]) {
			const tags = openingTags(html, name);
			assert.ok(tags.length > 0, `${name} present`);
			for (const tag of tags) assert.equal(fontOf(tag), CODE_FONT_STACK, `${name} is monospace: ${tag}`);
		}
		// The column, the body cell and the footer name it too, for Outlook.
		assert.ok(html.includes(`class="col" style="max-width:600px;font-family:${stack};`));
		assert.ok(html.includes(`<td class="body" style="font-family:${stack};`));
		assert.match(html, new RegExp(`<td class="footer" style="padding:32px 0 0;font-family:${stack.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")};`));
		// One style attribute and one font per tag.
		for (const tag of html.match(/<[a-z][^>]*>/gi)) {
			assert.ok((tag.match(/\sstyle="/g) ?? []).length <= 1, `one style attribute: ${tag}`);
			assert.ok((tag.match(/font-family:/g) ?? []).length <= 1, `one font: ${tag}`);
		}
		assert.ok(bytes < GMAIL_CLIP_BYTES / 4, `far under the Gmail clip: ${bytes}`);
	});
}

test("headline and text fonts are separate, and a link inside a headline keeps the headline's font", () => {
	const { html } = render({ ...presetTheme("default"), headingFont: "serif", bodyFont: "verdana" });
	const [h1] = openingTags(html, "h1");
	assert.equal(fontOf(h1), FONT_STACKS.serif);
	for (const p of openingTags(html, "p")) assert.equal(fontOf(p), FONT_STACKS.verdana);
	const headline = /<h1[^>]*>[^]*?<\/h1>/.exec(html)[0];
	assert.ok(headline.includes('<a style="color:#18181b;" href="https://example.com/h">link</a>'), "the link carries colour only");
	assert.ok(!headline.includes("Verdana"), "no text font inside the headline");
	// The grotesk headline keeps its tight medium setting; the others stay semi-bold.
	assert.match(fontOf(openingTags(render({ ...presetTheme("default"), headingFont: "grotesk" }).html, "h1")[0]), /Helvetica/);
	assert.ok(openingTags(render({ ...presetTheme("default"), headingFont: "grotesk" }).html, "h1")[0].includes("letter-spacing:-0.02em;font-weight:500;"));
	assert.ok(h1.includes("font-weight:600;"));
});

test("a font changes the type only: footer, unsubscribe, preheader and the text part stay the same", () => {
	const plain = renderEmail({ ...issue, newsletter, webUrl: "https://news.example.com/p/1" });
	// The footer's words and link, without the look's own colour.
	const footerOf = (html) =>
		html.slice(html.indexOf("You're receiving this"), html.indexOf("</td>", html.indexOf("You're receiving this"))).replace(/ style="[^"]*"/g, "");
	const preheader = /<div style="display:none;[^>]*data-preheader>[^]*?<\/div>/.exec(plain.html)[0];
	for (const font of THEME_FONTS) {
		for (const preset of ["default", "landing", "letter", "maiteam"]) {
			const themed = render({ ...presetTheme(preset), headingFont: font, bodyFont: font }, { webUrl: "https://news.example.com/p/1" });
			assert.equal(footerOf(themed.html), footerOf(plain.html), `${preset}/${font}: footer text and unsubscribe link unchanged`);
			assert.ok(themed.html.includes(`<a href="${UNSUBSCRIBE_PLACEHOLDER}" style="color:`), "unsubscribe placeholder present");
			assert.ok(themed.html.includes(preheader), "preheader unchanged");
			assert.equal(themed.text, plain.text, `${preset}/${font}: text part identical`);
			const unsubscribed = render({ ...presetTheme(preset), bodyFont: font }, { unsubscribeUrl: "https://mail.example.com/unsubscribe?token=abc" });
			assert.ok(unsubscribed.html.includes('href="https://mail.example.com/unsubscribe?token=abc"'));
		}
	}
});

test("nothing changes until a font is picked: the default email is byte-identical and the saved looks keep their fonts", () => {
	const before = renderEmail({ ...issue, newsletter });
	const unthemed = renderEmail({ ...issue, newsletter: { ...newsletter, theme: { look: presetTheme("default") } } });
	assert.equal(unthemed.html, before.html);
	assert.ok(isDefaultTheme(resolveTheme(presetTheme("default"))));
	assert.ok(!before.html.includes('<p style="font-family'), "the default wrapper is untouched");
	assert.deepEqual(
		["default", "landing", "letter", "maiteam"].map((id) => [id, resolveTheme(presetTheme(id)).headingFont, resolveTheme(presetTheme(id)).bodyFont]),
		[["default", "system", "system"], ["landing", "grotesk", "serif"], ["letter", "serif", "system"], ["maiteam", "grotesk", "grotesk"]]
	);
	// Picking Verdana on the default look is the only change: white page, same colours, new type.
	const verdana = resolveTheme({ ...presetTheme("default"), bodyFont: "verdana" });
	assert.ok(!isDefaultTheme(verdana));
	const { html } = render({ ...presetTheme("default"), bodyFont: "verdana" });
	assert.ok(html.includes('<body class="page" bgcolor="#ffffff"'));
	assert.ok(html.includes("color:#27272a;"));
});

test("the WCAG contrast and Gmail clip checks still run on a Verdana issue", () => {
	const theme = { ...presetTheme("maiteam"), headingFont: "verdana", bodyFont: "verdana" };
	assert.deepEqual(contrastProblems(theme), []);
	assert.equal(contrastProblems({ ...theme, light: { ...theme.light, text: "#bbbbbb" } }).length > 0, true, "fonts do not hide a contrast problem");
	// Inlining grows a long issue, but not near the clip: 300 short paragraphs stay well under it.
	const long = renderEmail({ subject: "Long", markdown: Array.from({ length: 300 }, (_, i) => `Paragraph ${i} with a few words in it.`).join("\n\n"), newsletter: { ...newsletter, theme: { look: theme } } });
	assert.ok(long.bytes < GMAIL_CLIP_BYTES * 0.75, `300 paragraphs: ${long.bytes} bytes`);
});
