import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import mongoose from "mongoose";
import {
	BUTTON_LABEL_MINIMUM,
	MAX_WORDMARK_LENGTH,
	THEME_LOOKS,
	THEME_PRODUCTS,
	completeTheme,
	contrastPairs,
	contrastProblems,
	contrastRatio,
	effectiveLook,
	isDefaultTheme,
	parseThemeInput,
	presetTheme,
	presetWordmark,
	readThemeForm,
	resolveTheme,
} from "../lib/maiteam/email-look.js";
import { UNSUBSCRIBE_PLACEHOLDER, renderEmail } from "../lib/render-email.js";
import { buildRecipientEmail } from "../lib/sending-rules.js";
import { lookFields } from "../models/maiteam-look-fields.js";
import { listCases, listDefaultCases, listUpstreamCases, newArguments } from "./helpers/maiteam-look-cases.mjs";

// maiteam (PATCHES.md P3c): the old fork's look tests (tests/email-theme.test.mjs at 7bdd14c), on the port. A look
// sits at newsletter.theme.look and an issue's at campaign.look.
const GMAIL_CLIP_BYTES = 102 * 1024;
const FIXTURE = JSON.parse(readFileSync(new URL("./fixtures/maiteam-look-equivalence.json", import.meta.url), "utf8"));
const newsletter = { name: "Field Notes", postalAddress: "Rue de l'Exemple 1, 2000 Neuchâtel" };
const welcome = {
	subject: "You're on the list",
	previewText: "One short email a week. What you'll get.",
	markdown: [
		"Hello,",
		"",
		"Thanks for confirming. You're on the list.",
		"",
		"Who's writing: Jane, who keeps field notes on small tools that do one job well.",
		"",
		"To see what the notes cover: [The index](https://example.com/#index).",
		"",
		"Jane",
	].join("\n"),
};

function sha256(value) {
	return createHash("sha256").update(value).digest("hex");
}

function landing() {
	return { ...presetTheme("landing"), wordmark: "Field Notes" };
}

function render(look, extra = {}) {
	return renderEmail({ ...welcome, newsletter: { ...newsletter, theme: { look } }, ...extra });
}

test("every look renders the old fork's bytes (hashes from tests/runners/maiteam-look-equivalence.mjs)", () => {
	const cases = [...listCases(), ...listDefaultCases()];
	assert.equal(cases.length, Object.keys(FIXTURE.looks).length);
	for (const testCase of cases) {
		const { html, text } = renderEmail(newArguments(testCase));
		assert.deepEqual({ html: sha256(html), text: sha256(text) }, FIXTURE.looks[testCase.id], testCase.id);
	}
});

test("without a look, every email renders upstream's bytes from before the port", () => {
	for (const { id, input } of listUpstreamCases()) {
		const { html, text } = renderEmail(input);
		assert.deepEqual({ html: sha256(html), text: sha256(text) }, FIXTURE.upstream[id], id);
		const unset = renderEmail({ ...input, look: null, newsletter: input.newsletter && { ...input.newsletter, theme: { ...input.newsletter.theme, look: undefined } } });
		assert.equal(unset.html, html, `${id}: an unset look is no look`);
	}
});

test("a default look is upstream's email, plus the old default's ink fill on a marked button", () => {
	const before = renderEmail({ ...welcome, newsletter });
	assert.equal(render(presetTheme("default")).html, before.html);
	assert.ok(isDefaultTheme(resolveTheme(undefined)));
	assert.ok(isDefaultTheme(resolveTheme(presetTheme("default"))));
	assert.ok(!isDefaultTheme(resolveTheme(presetTheme("landing"))));
	assert.ok(before.html.includes('<meta name="color-scheme" content="light">'));
	assert.ok(!before.html.includes("prefers-color-scheme"));

	const cta = '\n\n<a href="https://example.com/go" data-button>Go</a>\n';
	const upstream = renderEmail({ markdown: cta, subject: "Hi", newsletter });
	assert.ok(upstream.html.includes('<a href="https://example.com/go" data-button>Go</a>'), "upstream leaves a marked link alone");
	const withDefault = renderEmail({ markdown: cta, subject: "Hi", newsletter: { ...newsletter, theme: { look: presetTheme("default") } } });
	assert.match(withDefault.html, /<a class="button" style="display:inline-block;padding:12px 20px;border-radius:10px;background:#18181b;color:#ffffff;[^"]*" href="https:\/\/example.com\/go">Go<\/a>/);
	assert.equal(withDefault.text, upstream.text);
});

test("the landing look puts the page in the inbox: paper, card, wordmark, one orange rule, deep-orange links", () => {
	const { html, bytes } = render(landing(), { webUrl: "https://example.com/p/1" });
	assert.ok(html.includes('<body class="page" bgcolor="#f4f1ea" style="margin:0;padding:0;background:#f4f1ea;">'));
	assert.ok(html.includes('class="page" bgcolor="#f4f1ea" style="background:#f4f1ea;"'));
	assert.ok(html.includes('class="card" bgcolor="#fcfbf8" style="background:#fcfbf8;'));
	assert.match(html, /<td class="wordmark" style="[^"]*font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;[^"]*">Field Notes<span class="dot" style="color:#ff4d1c;">\.<\/span><\/td>/);
	assert.equal(html.match(/bgcolor="#ff4d1c"/g).length, 1, "one rule carries the page's true orange");
	assert.ok(!html.includes("<img"), "no images: the wordmark is type");
	assert.ok(html.includes("font-family:Georgia,'Times New Roman',Times,serif;font-size:16px"));
	assert.ok(html.includes('<a style="color:#b8380f;" href="https://example.com/#index">The index</a>'));
	assert.ok(html.includes(".body a { color: #b8380f; }"));
	assert.match(html, /<td class="footer" style="[^"]*color:#6b675f;border-top:1px solid #d5d0c5;"/);
	assert.ok(!html.includes('class="title"'));
	assert.ok(bytes < GMAIL_CLIP_BYTES / 4, `well under Gmail's clip: ${bytes} bytes`);
});

test("the letter look: white, no card, the subject as a serif headline, navy links only", () => {
	const { html } = render(presetTheme("letter"));
	assert.ok(html.includes('<body class="page" bgcolor="#ffffff" style="margin:0;padding:0;background:#ffffff;">'));
	assert.ok(!html.includes('class="card"'));
	assert.ok(!html.includes('class="wordmark"'));
	assert.match(html, /<h1 class="title" style="[^"]*font-family:Georgia,'Times New Roman',Times,serif;font-weight:600;color:#121212;font-size:30px;[^"]*">You&#39;re on the list<\/h1>/);
	assert.ok(html.includes('<a style="color:#1e40af;" href="https://example.com/#index">'));
	assert.ok(!html.includes("#ff4d1c") && !html.includes("#b8380f"), "no orange anywhere");
});

test("looks with dark colours declare both schemes and carry a dark block; dark off stays light-only", () => {
	for (const look of [landing(), presetTheme("letter")]) {
		const { html } = render(look);
		assert.ok(html.includes('<meta name="color-scheme" content="light dark">'));
		assert.ok(html.includes('<meta name="supported-color-schemes" content="light dark">'));
		assert.match(html, /@media \(prefers-color-scheme: dark\) \{[^]*body, \.page, \.page td\.pad \{ background: #[0-9a-f]{6} !important; \}/);
		assert.ok(html.includes("[data-ogsc] .body a"), "Outlook.com dark hooks");
	}
	const dark = render(landing()).html;
	assert.ok(dark.includes("body, .page, .page td.pad { background: #121212 !important; }"));
	assert.ok(dark.includes(".card { background: #1c1b19 !important; }"));
	assert.ok(dark.includes(".body a, .body a span { color: #ff8a63 !important; }"));
	const { html } = render({ ...landing(), dark: { ...landing().dark, enabled: false } });
	assert.ok(html.includes('<meta name="color-scheme" content="light">'));
	assert.ok(!html.includes("prefers-color-scheme"));
});

test("the dashboard's dark preview renders the dark colours as the page", () => {
	const { html } = render(landing(), { previewScheme: "dark" });
	assert.ok(html.includes('<body class="page" bgcolor="#121212"'));
	assert.ok(html.includes('class="card" bgcolor="#1c1b19"'));
	assert.ok(html.includes('<a style="color:#ff8a63;" href='));
	assert.ok(!html.includes("prefers-color-scheme"));
});

test("looks change the look only: preheader, footer, unsubscribe and the text part are upstream's", () => {
	const plain = renderEmail({ ...welcome, newsletter, webUrl: "https://example.com/p/1" });
	const preheader = /<div style="display:none;[^>]*data-preheader>[^]*?<\/div>/.exec(plain.html)[0];
	for (const look of [landing(), presetTheme("letter"), presetTheme("maiteam", "fortuna")]) {
		const themed = render(look, { webUrl: "https://example.com/p/1" });
		assert.ok(themed.html.includes(preheader), "preheader unchanged");
		assert.ok(themed.html.includes("You're receiving this because you subscribed to Field Notes.<br>"));
		assert.ok(themed.html.includes(`<a href="${UNSUBSCRIBE_PLACEHOLDER}" style="color:`));
		assert.ok(themed.html.includes("Rue de l&#39;Exemple 1, 2000 Neuchâtel"));
		assert.ok(themed.html.includes('class="readonline" href="https://example.com/p/1"'));
		assert.equal(themed.text, plain.text, "the text part is identical");
	}
	const unsubscribed = render(landing(), { unsubscribeUrl: "https://mail.example.com/unsubscribe?token=abc" });
	assert.ok(unsubscribed.html.includes('href="https://mail.example.com/unsubscribe?token=abc"'));
	assert.ok(!unsubscribed.text.includes(UNSUBSCRIBE_PLACEHOLDER));
});

test("the web version takes the look too, without the subscriber footer", () => {
	const { html } = render(landing(), { isWebVersion: true });
	assert.ok(html.includes('class="wordmark"'));
	assert.ok(!html.includes(UNSUBSCRIBE_PLACEHOLDER));
	assert.ok(!html.includes("You're receiving this"));
});

test("an issue's own look wins over the newsletter's, null falls back to it, and HTML issues ignore both", () => {
	const landingNewsletter = { ...newsletter, theme: { preset: "maiteam", look: landing() } };
	const inherited = renderEmail({ ...welcome, newsletter: landingNewsletter });
	assert.equal(renderEmail({ ...welcome, newsletter: landingNewsletter, look: null }).html, inherited.html);
	assert.ok(inherited.html.includes('bgcolor="#f4f1ea"'));
	const own = renderEmail({ ...welcome, newsletter: landingNewsletter, look: presetTheme("letter") });
	assert.ok(own.html.includes('bgcolor="#ffffff"') && !own.html.includes("#f4f1ea"));
	assert.ok(own.html.includes('class="title"'));
	// An explicit default look on a newsletter with one is upstream's email in the newsletter's theme.
	const asDefault = renderEmail({ ...welcome, newsletter: landingNewsletter, look: presetTheme("default") });
	assert.equal(asDefault.html, renderEmail({ ...welcome, newsletter: { ...newsletter, theme: { preset: "maiteam" } } }).html);

	const html = "<html><body><p>Own design</p></body></html>";
	const designed = renderEmail({ format: "html", html, subject: "Hi", newsletter });
	assert.equal(renderEmail({ format: "html", html, subject: "Hi", newsletter: landingNewsletter, look: presetTheme("letter") }).html, designed.html);

	assert.equal(effectiveLook({ look: null }, landingNewsletter), landingNewsletter.theme.look);
	assert.equal(effectiveLook({}, landingNewsletter), landingNewsletter.theme.look);
	assert.equal(effectiveLook({ look: presetTheme("letter") }, landingNewsletter).preset, "letter");
	assert.equal(effectiveLook({}, newsletter), null);
	assert.equal(effectiveLook(undefined, { theme: { preset: "maiteam" } }), null);
});

test("the recipient email takes the issue's own look, and the newsletter's without one", () => {
	process.env.BETTER_AUTH_SECRET ??= "test-session-secret-with-at-least-32-characters";
	process.env.APP_URL ??= "https://mail.example.com";
	const landingNewsletter = { ...newsletter, _id: "64b000000000000000000001", slug: "notes", fromEmail: "hello@example.com", theme: { look: landing() } };
	const issue = { _id: "64b000000000000000000002", format: "markdown", markdown: welcome.markdown, subject: welcome.subject, previewText: "", look: presetTheme("letter") };
	const contact = { _id: "64b000000000000000000003", email: "reader@example.com" };
	const own = buildRecipientEmail({ campaign: issue, newsletter: landingNewsletter, contact, messageId: null });
	assert.ok(own.html.includes('<a style="color:#1e40af;"') && !own.html.includes("#f4f1ea"));
	const inherited = buildRecipientEmail({ campaign: { ...issue, look: undefined }, newsletter: landingNewsletter, contact, messageId: null });
	assert.ok(inherited.html.includes('bgcolor="#f4f1ea"'));
	assert.ok(!inherited.html.includes(UNSUBSCRIBE_PLACEHOLDER) && inherited.html.includes("/unsubscribe?token="));
	const plain = buildRecipientEmail({ campaign: { ...issue, look: undefined }, newsletter: { ...landingNewsletter, theme: undefined }, contact, messageId: null });
	assert.equal(inherited.text, plain.text);
	assert.ok(!plain.html.includes('class="page"'));
});

test("every text and background pair in the presets passes WCAG AA, light and dark", () => {
	for (const name of ["default", "landing", "letter"]) {
		const resolved = resolveTheme({ ...presetTheme(name), wordmark: "x" });
		for (const pair of contrastPairs(resolved)) {
			const ratio = contrastRatio(pair.foreground, pair.background);
			assert.ok(ratio >= 4.5, `${name} ${pair.mode} ${pair.name}: ${pair.foreground} on ${pair.background} is ${ratio.toFixed(2)}`);
		}
	}
	assert.ok(contrastRatio("#ff4d1c", "#f4f1ea") < 4.5, "the page's true orange fails as text on paper, which is why links use the deeper one");
});

test("the wordmark and subject are escaped, and a wordmark is cut to its limit", () => {
	const look = { ...presetTheme("letter"), wordmark: '<img src=x onerror=alert(1)> "Notes"' };
	const { html } = renderEmail({ ...welcome, subject: "<b>Hi</b> & bye", newsletter: { ...newsletter, theme: { look } } });
	assert.ok(html.includes("&lt;img src=x onerror=alert(1)&gt; &quot;Notes&quot;<"));
	assert.ok(!html.includes("<img src=x"));
	assert.ok(html.includes("&lt;b&gt;Hi&lt;/b&gt; &amp; bye</h1>"));
	assert.equal(resolveTheme({ ...presetTheme("letter"), wordmark: "w".repeat(200) }).wordmark.length, MAX_WORDMARK_LENGTH);
});

test("edited colours apply, unknown values fall back, and hairline and box follow the new colours", () => {
	const edited = resolveTheme({
		...presetTheme("landing"),
		layout: "nope",
		headingFont: "comic",
		light: { ...presetTheme("landing").light, page: "#000000", text: "#ffffff", accent: "not-a-colour" },
	});
	assert.equal(edited.layout, "card");
	assert.equal(edited.headingFont, "grotesk");
	assert.equal(edited.light.page, "#000000");
	assert.equal(edited.light.accent, "#b8380f");
	assert.equal(edited.light.heading, "#ffffff");
	assert.notEqual(edited.light.line, "#d5d0c5");
	assert.equal(edited.wordmarkDot, true);
});

test("the form is read strictly and a missing section leaves the saved look alone", () => {
	const values = {
		themePreset: "landing",
		themeLayout: "card",
		themeHeadingFont: "grotesk",
		themeBodyFont: "serif",
		themeWordmark: "  Field Notes ",
		themeFooterTone: "quiet",
		themeTitleFromSubject: null,
		themeDarkEnabled: "on",
		themeLightPage: "#F4F1EA",
		themeLightCard: "#fcfbf8",
		themeLightText: "#121212",
		themeLightAccent: "#b8380f",
		themeLightMuted: "#6b675f",
		themeDarkPage: "#121212",
		themeDarkCard: "#1c1b19",
		themeDarkText: "#ebe7de",
		themeDarkAccent: "#ff8a63",
		themeDarkMuted: "#a8a39a",
	};
	const read = (name) => (name in values ? values[name] : null);
	const { theme, error } = readThemeForm(read);
	assert.equal(error, undefined);
	assert.deepEqual(theme, {
		preset: "landing",
		layout: "card",
		headingFont: "grotesk",
		bodyFont: "serif",
		wordmark: "Field Notes",
		titleFromSubject: false,
		footerTone: "quiet",
		light: { page: "#f4f1ea", card: "#fcfbf8", text: "#121212", accent: "#b8380f", muted: "#6b675f" },
		dark: { enabled: true, page: "#121212", card: "#1c1b19", text: "#ebe7de", accent: "#ff8a63", muted: "#a8a39a" },
	});
	assert.deepEqual(readThemeForm(() => null), { theme: undefined });
	const darkOff = (name) => (name === "themeDarkEnabled" || name.startsWith("themeDark") ? null : read(name));
	assert.deepEqual(readThemeForm(darkOff).theme.dark, { enabled: false, page: "#121212", card: "#1c1b19", text: "#ebe7de", accent: "#ff8a63", muted: "#a8a39a" });
	assert.match(readThemeForm((name) => (name.startsWith("themeDark") && name !== "themeDarkEnabled" ? null : read(name))).error, /Dark page background/);
	assert.match(readThemeForm((name) => (name === "themeLightPage" ? "paper" : read(name))).error, /hex value/);
	assert.match(readThemeForm((name) => (name === "themePreset" ? "neon" : read(name))).error, /look/);
	assert.match(readThemeForm((name) => (name === "themeWordmark" ? "w".repeat(61) : read(name))).error, /wordmark/);
	assert.match(readThemeForm((name) => (name === "themeWordmark" ? "a\u0007b" : read(name))).error, /printable/);
});

test("a callout box takes the look's tint and the dark block covers it", () => {
	const { html } = renderEmail({ markdown: "Before\n\n:::box\nInside\n:::\n", subject: "Hi", newsletter: { ...newsletter, theme: { look: landing() } } });
	assert.ok(html.includes('<div class="box" style="margin:24px 0;padding:24px 24px 8px;border-radius:12px;background:#ebe7de;">'));
	assert.ok(html.includes(".body code, .box { background: #26241f !important; color: #ebe7de !important; }"));
});

test("an editor issue keeps upstream's image alignment in a look", () => {
	const html = '<p>x</p><img src="https://example.com/a.png" data-align="right"><img src="https://example.com/b.png">';
	const rendered = renderEmail({ format: "rich", html, subject: "Hi", newsletter: { ...newsletter, theme: { look: landing() } } }).html;
	assert.ok(rendered.includes('<img style="display:block;max-width:100%;height:auto;margin:24px 0 24px auto;border-radius:8px;" src="https://example.com/a.png">'));
	assert.ok(rendered.includes('<img style="display:block;max-width:100%;height:auto;margin:24px auto;border-radius:8px;" src="https://example.com/b.png">'));
});

// The maiteam tokens (maiteam-ships/.shared/brand/design-system/tokens.json, 20 Oct 2026).
const MAITEAM = { ground: "#fafaf8", ink: "#1a1a18", line: "#e6e4de", grey: "#6b6a64", darkGround: "#141412" };
const PETROL = ["#0e5c63", "#4fd1c5", "#0f1b1d", "#5b6b6d", "#e3eaea", "#16262a"];
const HELVETICA = "font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;";
const cta = (url = "https://example.com/start") => `\n\n<a href="${url}" data-button>Start here</a>\n`;

function maiteam(product) {
	return { ...presetTheme("maiteam", product), wordmark: presetWordmark("maiteam", "", product) };
}

function buttonOf(html) {
	return /<a class="button" style="([^"]*)"[^>]*>([^<]*)<\/a>/.exec(html);
}

test("maiteam company mail: ground, ink, Helvetica, grey links, an ink button, line hairlines, no petrol", () => {
	const look = maiteam("company");
	const { html, bytes } = renderEmail({ ...welcome, markdown: welcome.markdown + cta(), newsletter: { ...newsletter, theme: { look } }, webUrl: "https://example.com/p/1" });
	assert.ok(html.includes(`<body class="page" bgcolor="${MAITEAM.ground}" style="margin:0;padding:0;background:${MAITEAM.ground};">`));
	assert.ok(!html.includes('class="card"'));
	assert.match(html, new RegExp(`<td class="wordmark" style="[^"]*${HELVETICA.replace(/[()]/g, "\\$&")}[^"]*">maiteam</td>`));
	assert.match(html, /<h1 class="title" style="[^"]*Helvetica[^"]*color:#1a1a18;font-size:30px;/);
	assert.ok(html.includes(`${HELVETICA}font-size:16px;line-height:1.65;color:${MAITEAM.ink};`));
	assert.ok(html.includes(`<a style="color:${MAITEAM.grey};" href="https://example.com/#index">`));
	const button = buttonOf(html);
	assert.match(button[1], /background:#1a1a18;color:#fafaf8;/);
	assert.equal(button[2], "Start here");
	assert.match(html, new RegExp(`<td class="footer" style="[^"]*color:${MAITEAM.grey};border-top:1px solid ${MAITEAM.line};"`));
	assert.ok(html.includes(`body, .page, .page td.pad { background: ${MAITEAM.darkGround} !important; }`));
	assert.ok(html.includes(".body a.button { background: #f2f1ec !important; color: #141412 !important; }"));
	for (const colour of [...PETROL, "#f4f1ea", "#ff4d1c", "#b8380f", "#6e5c96", "#c85a2a"]) assert.ok(!html.includes(colour), `no ${colour}`);
	assert.ok(bytes < GMAIL_CLIP_BYTES / 4);
	assert.deepEqual(contrastProblems(look), []);
});

test("maiteam product mail takes the product's slot for links and the button, light and dark", () => {
	const expected = {
		fortuna: { link: "#6e5c96", button: "#6e5c96", label: "#ffffff", darkLink: "#ae9cd2", darkButton: "#ae9cd2", other: "#c85a2a" },
		"quote-to-invoice": { link: "#9e4318", button: "#c85a2a", label: "#ffffff", darkLink: "#d9703f", darkButton: "#d9703f", other: "#6e5c96" },
	};
	for (const [product, colours] of Object.entries(expected)) {
		const look = maiteam(product);
		const { html } = renderEmail({ ...welcome, markdown: welcome.markdown + cta(), newsletter: { ...newsletter, theme: { look } } });
		assert.ok(html.includes(`<a style="color:${colours.link};" href=`), `${product}: links`);
		assert.match(buttonOf(html)[1], new RegExp(`background:${colours.button};color:${colours.label};`), `${product}: button`);
		assert.ok(html.includes(`>${product}</td>`), `${product}: wordmark`);
		assert.ok(html.includes(`.body a, .body a span { color: ${colours.darkLink} !important; }`));
		assert.ok(html.includes(`.body a.button { background: ${colours.darkButton} !important; color: #141412 !important; }`));
		assert.ok(!html.includes(colours.other), `${product}: never another product's accent`);
		for (const pair of contrastPairs(resolveTheme(look))) {
			assert.ok(contrastRatio(pair.foreground, pair.background) >= pair.minimum, `${product} ${pair.mode} ${pair.name}`);
		}
	}
	assert.equal(contrastRatio("#ffffff", "#c85a2a").toFixed(2), "4.24");
	assert.equal(BUTTON_LABEL_MINIMUM, 4.2);
});

test("the product comes only from the saved look, and a look from before products is company mail", () => {
	const body = `${welcome.markdown}\n\nfortuna and quote-to-invoice are maiteam products.${cta()}`;
	const company = renderEmail({ ...welcome, markdown: body, newsletter: { ...newsletter, theme: { look: maiteam("company") } } });
	assert.match(buttonOf(company.html)[1], /background:#1a1a18;/);
	for (const colour of ["#6e5c96", "#c85a2a", "#9e4318"]) assert.ok(!company.html.includes(colour));
	const { product, ...older } = maiteam("company");
	assert.equal(product, "company");
	assert.equal(resolveTheme(older).product, "company");
	assert.equal(resolveTheme({ preset: "maiteam", product: "neon" }).product, "company");
	assert.equal(resolveTheme(presetTheme("landing")).product, null);
	assert.equal(parseThemeInput(maiteam("fortuna")).theme.product, "fortuna");
	assert.equal(parseThemeInput(older).theme.product, "company");
	assert.match(parseThemeInput({ ...maiteam("fortuna"), product: "q2i" }).error, /unknown option/);
	assert.equal("product" in parseThemeInput({ ...presetTheme("letter"), product: "fortuna" }).theme, false);
	assert.equal(completeTheme({ ...presetTheme("letter"), product: "fortuna" }).product, undefined);
	assert.deepEqual(lookFields.product.enum, THEME_PRODUCTS);
	assert.deepEqual(THEME_PRODUCTS, ["company", "fortuna", "quote-to-invoice"]);
});

test("a saved look still holding the old petrol preset takes the new colours; a colour someone changed stays", () => {
	const legacy = {
		preset: "maiteam",
		layout: "plain",
		headingFont: "grotesk",
		bodyFont: "system",
		wordmark: "maiteam",
		titleFromSubject: true,
		footerTone: "quiet",
		light: { page: "#ffffff", card: "#ffffff", text: "#0f1b1d", accent: "#0e5c63", muted: "#5b6b6d" },
		dark: { enabled: true, page: "#0f1b1d", card: "#16262a", text: "#e3eaea", accent: "#4fd1c5", muted: "#9aabad" },
	};
	const resolved = resolveTheme(legacy);
	assert.deepEqual(
		[resolved.light.page, resolved.light.text, resolved.light.accent, resolved.light.line, resolved.dark.page, resolved.dark.accent],
		[MAITEAM.ground, MAITEAM.ink, MAITEAM.grey, MAITEAM.line, MAITEAM.darkGround, "#a3a29b"]
	);
	const { html } = renderEmail({ ...welcome, newsletter: { ...newsletter, theme: { look: legacy } } });
	for (const colour of PETROL) assert.ok(!html.includes(colour), `no ${colour}`);
	assert.equal(resolved.bodyFont, "grotesk");
	const edited = resolveTheme({ ...legacy, bodyFont: "serif", light: { ...legacy.light, accent: "#123456" } });
	assert.equal(edited.light.accent, "#123456");
	assert.equal(edited.bodyFont, "serif");
	const chosen = resolveTheme({ ...legacy, product: "company" });
	assert.equal(chosen.light.page, "#ffffff");
	// A stored Mongoose subdocument reads the same as the plain object, and the schema checks the product.
	const Stored = mongoose.models.MaiteamLookCheck ?? mongoose.model("MaiteamLookCheck", new mongoose.Schema({ look: lookFields }));
	assert.deepEqual(resolveTheme(new Stored({ look: legacy }).look), resolved);
	assert.equal(new Stored({ look: { ...legacy, product: "q2i" } }).validateSync().errors["look.product"].kind, "enum");
});

test("the button is its own colour: one marked link, other links stay links, a styled one keeps its style", () => {
	const markdown = `Read [the note](https://example.com/note).${cta("https://example.com/go")}\nThen <a href="https://x.example" style="color:#000;" data-button>own</a>.`;
	const { html, text } = renderEmail({ markdown, subject: "Hi", newsletter: { ...newsletter, theme: { look: maiteam("fortuna") } } });
	assert.equal(html.match(/class="button"/g).length, 1);
	assert.ok(html.includes('<a style="color:#6e5c96;" href="https://example.com/note">the note</a>'));
	assert.ok(html.includes('href="https://x.example" style="color:#000;" data-button>own</a>'));
	assert.ok(text.includes("Start here (https://example.com/go)"));
});

test("a look sent as an object is checked like the form, and nothing means the newsletter's", () => {
	assert.deepEqual(parseThemeInput(undefined), { theme: null });
	assert.deepEqual(parseThemeInput(null), { theme: null });
	assert.deepEqual(parseThemeInput(""), { theme: null });
	assert.equal(parseThemeInput("letter").error, "The email look is not valid");
	assert.equal(parseThemeInput([]).error, "The email look is not valid");
	assert.equal(parseThemeInput({ preset: "neon" }).error, "Choose a look for the emails");
	assert.deepEqual(parseThemeInput(presetTheme("letter")).theme, presetTheme("letter"));
	assert.equal(parseThemeInput({ ...presetTheme("letter"), light: { ...presetTheme("letter").light, accent: "#FF0000" } }).theme.light.accent, "#ff0000");
	assert.match(parseThemeInput({ ...presetTheme("letter"), light: { ...presetTheme("letter").light, accent: "red" } }).error, /Light link colour must be a hex/);
	const lightOnly = parseThemeInput({ ...presetTheme("letter"), dark: { enabled: false } });
	assert.equal(lightOnly.theme.dark.enabled, false);
	assert.equal(lightOnly.theme.dark.page, presetTheme("letter").dark.page);
	assert.match(parseThemeInput({ ...presetTheme("letter"), dark: { enabled: true } }).error, /Dark page background colour/);
	assert.equal(parseThemeInput({ ...presetTheme("letter"), wordmark: "x".repeat(MAX_WORDMARK_LENGTH + 1) }).error, `Keep the wordmark under ${MAX_WORDMARK_LENGTH} characters`);
});

test("completeTheme fills a partial saved look from its preset, and the wordmark helper follows the look", () => {
	const partial = completeTheme({ preset: "maiteam", light: { accent: "#123456" } });
	assert.equal(partial.layout, "plain");
	assert.equal(partial.light.accent, "#123456");
	assert.equal(partial.light.page, "#fafaf8");
	assert.equal(partial.product, "company");
	assert.equal(partial.dark.enabled, true);
	assert.equal(completeTheme(undefined).preset, "default");
	assert.equal(presetWordmark("landing", "  Field Notes "), "Field Notes");
	assert.equal(presetWordmark("letter", "Jane"), "");
	assert.equal(THEME_LOOKS.map((look) => look.id).join(","), "default,landing,letter,maiteam");
	// Visible names are lowercase (PATCHES.md P2).
	for (const { label, note } of THEME_LOOKS) assert.doesNotMatch(`${label} ${note}`, /Mail[Cc]heap|Fortuna|Maiteam|Q2I/);
});
