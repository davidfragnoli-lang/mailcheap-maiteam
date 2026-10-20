// maiteam (PATCHES.md P3c): the emails the look port is compared on, against the old fork's renderer at 7bdd14c
// (tests/runners/maiteam-look-equivalence.mjs) and against the hashes it recorded (tests/maiteam-email-look.test.mjs).
// Made-up names and addresses only.
import { presetTheme, presetWordmark } from "../../lib/maiteam/email-look.js";

export const NEWSLETTER = { name: "Field Notes", postalAddress: "Field Notes Ltd, 1 Main St, Paris, France" };

// Every block the looks style: headlines with a link, inline code, a list, a quote, a rule, a table, a code block,
// a box, a picture, one marked button and one author-styled link.
export const MARKDOWN = [
	"# A headline with a [link](https://example.com/h)",
	"",
	"A paragraph with `inline code` and a [link](https://example.com/p), long enough to wrap onto a second line.",
	"",
	"## Second headline",
	"",
	"- A tight list item",
	"- Another",
	"",
	"> A quote worth keeping.",
	"",
	"---",
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
	"An aside in a box, with a [link](https://example.com/box).",
	":::",
	"",
	"![A picture](https://example.com/picture.png)",
	"",
	'<a href="https://example.com/start" data-button>Start here</a>',
	"",
	'Then <a href="https://example.com/own" style="color:#000;">an own style</a>.',
	"",
	"Jane",
].join("\n");

// What the dashboard editor saves: an HTML fragment.
export const RICH = [
	'<h2>A headline with a <a href="https://example.com/h">link</a></h2>',
	'<p>A paragraph with <code>inline code</code> and a <a href="https://example.com/p">link</a>.</p>',
	"<ul><li><p>A list item</p></li><li><p>Another</p></li></ul>",
	"<blockquote><p>A quote worth keeping.</p></blockquote>",
	"<hr>",
	"<pre><code>const block = true;</code></pre>",
	'<div data-callout=""><p>An aside in a box.</p></div>',
	'<img src="https://example.com/picture.png" alt="A picture">',
	"<p>Jane</p>",
].join("");

const SUBJECT = "Notes & links, week 12";
const PREVIEW_TEXT = "Three links worth your time.";
const WEB_URL = "https://news.example.com/p/notes-week-12";

function landing() {
	return { ...presetTheme("landing"), wordmark: presetWordmark("landing", NEWSLETTER.name) };
}

function maiteam(product) {
	return { ...presetTheme("maiteam", product), wordmark: presetWordmark("maiteam", "", product) };
}

// What presetTheme("maiteam") stored before products existed (FRA-25890): read as the new company look.
const LEGACY_MAITEAM = {
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

export const LOOKS = {
	landing: landing(),
	"landing-light-only": { ...landing(), dark: { ...landing().dark, enabled: false } },
	"landing-edited": { ...landing(), layout: "plain", bodyFont: "verdana", footerTone: "plain", light: { ...landing().light, page: "#000000", text: "#ffffff" } },
	letter: presetTheme("letter"),
	"letter-wordmark-card": { ...presetTheme("letter"), wordmark: '<b>Field</b> "Notes"', layout: "card" },
	"maiteam-company": maiteam("company"),
	"maiteam-fortuna": maiteam("fortuna"),
	"maiteam-quote-to-invoice": maiteam("quote-to-invoice"),
	"maiteam-legacy-petrol": LEGACY_MAITEAM,
	"default-verdana": { ...presetTheme("default"), bodyFont: "verdana" },
};

// The default look is upstream's own email (no look), not the old fork's plain wrapper: compared apart.
export const DEFAULT_LOOK = presetTheme("default");

const VARIANTS = {
	markdown: { format: "markdown", markdown: MARKDOWN },
	"markdown-web-url": { format: "markdown", markdown: MARKDOWN, webUrl: WEB_URL },
	"markdown-dark-preview": { format: "markdown", markdown: MARKDOWN, previewScheme: "dark" },
	"markdown-web-version": { format: "markdown", markdown: MARKDOWN, isWebVersion: true, webUrl: WEB_URL },
	rich: { format: "rich", html: RICH, webUrl: WEB_URL },
};

// Each case: the input both renderers get, the look, and whether the look is the issue's own (over a newsletter
// with the landing look) or the newsletter's.
export function listCases() {
	const cases = [];
	for (const [lookName, look] of Object.entries(LOOKS)) {
		for (const [variantName, variant] of Object.entries(VARIANTS)) {
			cases.push({ id: `${lookName}/${variantName}`, look, input: { subject: SUBJECT, previewText: PREVIEW_TEXT, ...variant }, isIssueLook: false });
		}
		if (lookName !== "landing") {
			cases.push({ id: `${lookName}/issue-over-landing`, look, input: { subject: SUBJECT, previewText: PREVIEW_TEXT, ...VARIANTS.markdown }, isIssueLook: true });
		}
	}
	return cases;
}

// The same case for the old renderer (newsletter.theme is the look, `theme` the issue's) and the port
// (newsletter.theme.look, `look` the issue's).
export function oldArguments({ look, input, isIssueLook }) {
	return isIssueLook
		? { ...input, newsletter: { ...NEWSLETTER, theme: LOOKS.landing }, theme: look }
		: { ...input, newsletter: { ...NEWSLETTER, theme: look } };
}

export function newArguments({ look, input, isIssueLook }) {
	return isIssueLook
		? { ...input, newsletter: { ...NEWSLETTER, theme: { look: LOOKS.landing } }, look }
		: { ...input, newsletter: { ...NEWSLETTER, theme: { look } } };
}

// The default look on each kind of email, for the comparison with the old fork's plain wrapper.
export function listDefaultCases() {
	return Object.entries(VARIANTS).map(([variantName, variant]) => ({
		id: `default/${variantName}`,
		look: DEFAULT_LOOK,
		input: { subject: SUBJECT, previewText: PREVIEW_TEXT, ...variant },
		isIssueLook: false,
	}));
}

// Emails without a look, for the proof that upstream's own output did not change.
export function listUpstreamCases() {
	const themes = [undefined, { preset: "maiteam" }, { preset: "fortuna" }, { preset: "landing" }];
	const cases = [];
	for (const theme of themes) {
		for (const [variantName, variant] of Object.entries(VARIANTS)) {
			const { previewScheme, ...rest } = variant;
			cases.push({
				id: `${theme?.preset ?? "none"}/${variantName}`,
				input: { subject: SUBJECT, previewText: PREVIEW_TEXT, ...rest, newsletter: { ...NEWSLETTER, ...(theme && { theme }) } },
			});
		}
	}
	cases.push({ id: "html", input: { format: "html", html: "<html><body><p>Own design</p></body></html>", subject: SUBJECT, newsletter: NEWSLETTER } });
	return cases;
}
