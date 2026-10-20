// maiteam (PATCHES.md P3c): the themed email wrapper of the old fork's lib/render-email.js (7bdd14c), ported as it
// was, so an accepted look renders the same bytes: a page and optional card, the wordmark with its full stop and one
// rule, every colour and email-safe font inline for clients that drop <style>, a <a data-button> filled with the look's
// button colour, and a prefers-color-scheme block (with Outlook.com's data-ogs* hooks) for dark mode. lib/render-email.js
// calls it only for a non-default look on a markdown or rich issue; everything else is upstream's own path.
import { EMAIL_BOX_TAG, inlineCalloutStyles } from "../callouts.js";
import { cleanRichHtml } from "../clean-html.js";
import { CODE_FONT_STACK, FONT_STACKS, isDefaultTheme, resolveTheme } from "./email-look.js";

// Email-safe tags the body can carry colours on; the <style> block repeats them for clients that keep it.
const BODY_LINK_PATTERN = /<a\s(?![^>]*\bstyle=)/gi;
// The one call to action: a link marked <a data-button href="...">. It is filled with the look's button
// colour, which is kept apart from the link colour. A marked link that brings its own style keeps it.
const BODY_BUTTON_PATTERN = /<a\s((?![^>]*\bstyle=)[^>]*?)\s*\bdata-button(?:="[^"]*")?([^>]*)>/gi;
const BODY_HEADING_PATTERN = /<(h[1-3])(?![^>]*\bstyle=)/gi;
// Outlook's Word engine does not pass a font down from the table to the text inside it, so every text block
// names its own. Links and other inline tags take their block's font, so a link inside a headline keeps the
// headline's.
const BODY_TEXT_TAGS = ["p", "li", "blockquote", "td", "th", "pre"];
const CODE_TAGS = ["code", "pre"];
const STYLE_ATTRIBUTE_PATTERN = /\sstyle="([^"]*)"/i;
// Where the editor puts a picture in the column (upstream's data-align). Center, the default, is the old fork's margin.
const IMAGE_MARGINS = { left: "24px auto 24px 0", center: "24px auto", right: "24px 0 24px auto" };

// The same as lib/render-email.js's: kept here so the two modules don't import each other.
function escapeHtml(value) {
	return String(value ?? "")
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

// The look a document renders with, or null for upstream's own email: no look, or the default one. The dashboard's
// dark preview renders the look's dark colours as the light ones.
export function getEmailLook(stored, previewScheme = "light") {
	if (!stored) return null;
	const resolved = resolveTheme(stored);
	if (isDefaultTheme(resolved)) return null;
	if (previewScheme === "dark" && resolved.dark.enabled) {
		return { ...resolved, light: { ...resolved.dark }, dark: { ...resolved.dark, enabled: false } };
	}
	return resolved;
}

// The old fork's default look filled a marked button with its ink, labelled white, and was otherwise upstream's plain
// email. A stored default look keeps that; an email without any look is left exactly as upstream renders it.
const DEFAULT_BUTTON = { button: "#18181b", buttonText: "#ffffff" };

export function withDefaultLookButtons(bodyHtml, stored) {
	return stored ? inlineButtons(bodyHtml, DEFAULT_BUTTON) : bodyHtml;
}

// Editor content with its layout inline, as the old fork wrote it: images centered with an 8px radius (left or right
// when upstream's editor aligned them), and no margin on the paragraph inside each list item.
export function lookRichBody(html) {
	return inlineCalloutStyles(cleanRichHtml(html))
		.replaceAll("<li><p>", '<li><p style="margin:0;">')
		.replace(/<img\b([^>]*)>/gi, (_, attributes) => {
			const align = attributes.match(/\sdata-align="(left|right)"/)?.[1];
			const margin = IMAGE_MARGINS[align] ?? IMAGE_MARGINS.center;
			const kept = attributes.replace(/\sdata-align="[^"]*"/, "");
			return `<img style="display:block;max-width:100%;height:auto;margin:${margin};border-radius:8px;"${kept}>`;
		});
}

function footerHtml({ newsletter, unsubscribeUrl, theme }) {
	const address = newsletter?.postalAddress
		? `<br>${escapeHtml(newsletter.postalAddress)}`
		: "";
	const color = theme.footerTone === "quiet" ? theme.light.muted : theme.light.text;
	return `<tr><td class="footer" style="padding:32px 0 0;font-family:${FONT_STACKS[theme.bodyFont]};font-size:12px;line-height:1.6;color:${color};border-top:1px solid ${theme.light.line};">
You're receiving this because you subscribed to ${escapeHtml(newsletter?.name || "this newsletter")}.<br>
<a href="${unsubscribeUrl}" style="color:${color};text-decoration:underline;">Unsubscribe</a>${address}
</td></tr>`;
}

function preheaderHtml(previewText) {
	if (!previewText) return "";
	// Padding characters stop clients from pulling body text into the inbox preview.
	return `<div style="display:none;max-height:0;overflow:hidden;opacity:0;" data-preheader>${escapeHtml(previewText)}${"&#847;&zwnj;&nbsp;".repeat(40)}</div>`;
}

function readOnlineLink(webUrl, color) {
	return `<a class="readonline" href="${escapeHtml(webUrl)}" style="color:${color};text-decoration:none;">Read online</a>`;
}

function buttonStyle({ button, buttonText }, font) {
	return `display:inline-block;padding:12px 20px;border-radius:10px;background:${button};color:${buttonText};${font ? `font-family:${font};` : ""}font-size:16px;font-weight:600;line-height:1.25;text-decoration:none;`;
}

// The built-in confirmation and last-chance buttons, and copy written for upstream's renderer (lib/render-email.js
// BUTTON_STYLE_PATTERN), are ink buttons. A maiteam look repaints them as its one button, so product mail keeps its
// product's colour; the old fork's other looks never did, so they leave them as they are.
const UPSTREAM_BUTTON_PATTERN = /(<a\s[^>]*style="display:inline-block;)background:#18181b;color:#ffffff;([^"]*?)border-radius:\d+px;/gi;

function repaintUpstreamButtons(bodyHtml, colors) {
	return bodyHtml.replace(UPSTREAM_BUTTON_PATTERN, (_, start, middle) => {
		// The class lets the dark-mode block repaint it too.
		const tagged = /\sclass=/.test(start) ? start : start.replace(/^<a\s/, '<a class="button" ');
		return `${tagged}background:${colors.button};color:${colors.buttonText};${middle}border-radius:10px;`;
	});
}

function inlineButtons(bodyHtml, colors, font) {
	return bodyHtml.replace(BODY_BUTTON_PATTERN, (_, before, after) => {
		const attributes = `${before}${after}`.trim();
		return `<a class="button" style="${buttonStyle(colors, font)}"${attributes ? ` ${attributes}` : ""}>`;
	});
}

// Heading type: the page's grotesk is set tight and medium, a serif stays regular.
function headingStyle(theme, colors) {
	const font = FONT_STACKS[theme.headingFont];
	const spacing = theme.headingFont === "grotesk" ? "letter-spacing:-0.02em;font-weight:500;" : "font-weight:600;";
	return `font-family:${font};${spacing}color:${colors.heading};`;
}

// Names `font` on every opening tag of `tags`, inside the style attribute it already has or in a new one.
// A tag that already names a font keeps it.
function inlineFont(html, tags, font) {
	const pattern = new RegExp(`<(${tags.join("|")})\\b([^>]*)>`, "gi");
	return html.replace(pattern, (tag, name, attributes) => {
		const style = STYLE_ATTRIBUTE_PATTERN.exec(attributes);
		if (!style) return `<${name} style="font-family:${font};"${attributes}>`;
		if (/font-family\s*:/i.test(style[1])) return tag;
		const existing = style[1].trim();
		const joined = existing && !existing.endsWith(";") ? `${existing};` : existing;
		return `<${name}${attributes.replace(style[0], ` style="${joined}font-family:${font};"`)}>`;
	});
}

// Colours and fonts that have to survive a client dropping <style> ride on the tags themselves.
function inlineBodyStyles(bodyHtml, theme) {
	const { light } = theme;
	const repainted = theme.preset === "maiteam" ? repaintUpstreamButtons(bodyHtml, light) : bodyHtml;
	const coloured = inlineButtons(repainted, light, FONT_STACKS[theme.bodyFont])
		.replace(BODY_LINK_PATTERN, `<a style="color:${light.accent};" `)
		.replace(BODY_HEADING_PATTERN, (_, tag) => `<${tag} style="${headingStyle(theme, light)}line-height:1.25;margin:32px 0 12px;"`)
		.replaceAll(EMAIL_BOX_TAG, `<div class="box" style="margin:24px 0;padding:24px 24px 8px;border-radius:12px;background:${light.box};">`);
	// Code first, so a <pre> keeps the code face rather than the text one.
	return inlineFont(inlineFont(coloured, CODE_TAGS, CODE_FONT_STACK), BODY_TEXT_TAGS, FONT_STACKS[theme.bodyFont]);
}

// A dark block for the clients that read <style> and honour prefers-color-scheme (Apple Mail, iOS
// Gmail, Outlook for Mac); Outlook.com's own dark mode gets the same rules through its data-ogs* hooks.
// Button rules are added only when the email has a button, so an email without one renders as before.
function darkStyles(theme, hasButton) {
	const { dark } = theme;
	const footer = theme.footerTone === "quiet" ? dark.muted : dark.text;
	const rules = `
  body, .page, .page td.pad { background: ${dark.page} !important; }
  .card { background: ${dark.card} !important; }
  .col, .body, .body p, .body li, .body td, .wordmark, .title { color: ${dark.text} !important; }
  .body h1, .body h2, .body h3, .title { color: ${dark.heading} !important; }
  .body a, .body a span { color: ${dark.accent} !important; }${hasButton ? `
  .body a.button { background: ${dark.button} !important; color: ${dark.buttonText} !important; }` : ""}
  .footer, .footer a, .readonline { color: ${footer} !important; }
  .footer { border-top-color: ${dark.line} !important; }
  .body blockquote { border-left-color: ${dark.line} !important; color: ${dark.muted} !important; }
  .body hr { border-top-color: ${dark.line} !important; }
  .body code, .box { background: ${dark.box} !important; color: ${dark.text} !important; }`;
	return `@media (prefers-color-scheme: dark) {${rules}
}
[data-ogsc] .col, [data-ogsc] .body, [data-ogsc] .body p, [data-ogsc] .body li, [data-ogsc] .wordmark, [data-ogsc] .title { color: ${dark.text} !important; }
[data-ogsc] .body a { color: ${dark.accent} !important; }${hasButton ? `
[data-ogsc] .body a.button { color: ${dark.buttonText} !important; }` : ""}
[data-ogsc] .footer, [data-ogsc] .footer a, [data-ogsc] .readonline { color: ${footer} !important; }
[data-ogsb] body, [data-ogsb] .page { background: ${dark.page} !important; }
[data-ogsb] .card { background: ${dark.card} !important; }
[data-ogsb] .box { background: ${dark.box} !important; }${hasButton ? `
[data-ogsb] .body a.button { background: ${dark.button} !important; }` : ""}`;
}

function wordmarkHtml(theme) {
	if (!theme.wordmark) return "";
	const { light } = theme;
	const dot = theme.wordmarkDot ? `<span class="dot" style="color:${light.rule ?? light.accent};">.</span>` : "";
	const rule = light.rule
		? `<tr><td style="padding:0 0 24px;"><table role="presentation" cellpadding="0" cellspacing="0"><tr><td width="28" height="2" bgcolor="${light.rule}" style="width:28px;height:2px;font-size:0;line-height:0;background:${light.rule};">&nbsp;</td></tr></table></td></tr>
`
		: "";
	return `<tr><td class="wordmark" style="padding:0 0 ${light.rule ? "10" : "24"}px;${headingStyle(theme, light)}font-size:15px;line-height:1.2;">${escapeHtml(theme.wordmark)}${dot}</td></tr>
${rule}`;
}

function wrapThemedBody({ bodyHtml, subject, previewText, footer, webUrl, theme }) {
	const { light, dark } = theme;
	const bodyFont = FONT_STACKS[theme.bodyFont];
	const title = theme.titleFromSubject && subject
		? `<h1 class="title" style="margin:0 0 24px;${headingStyle(theme, light)}font-size:30px;line-height:1.15;">${escapeHtml(subject)}</h1>\n`
		: "";
	const body = `${title}${inlineBodyStyles(bodyHtml, theme)}`;
	const column =
		theme.layout === "card"
			? `<tr><td class="card" bgcolor="${light.card}" style="background:${light.card};border-radius:12px;padding:32px 36px 20px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td class="body" style="font-family:${bodyFont};color:${light.text};">${body}</td></tr></table></td></tr>`
			: `<tr><td class="body" style="font-family:${bodyFont};color:${light.text};">${body}</td></tr>`;
	const readOnline = webUrl
		? `<tr><td align="right" style="padding:0 0 24px;font-family:${bodyFont};font-size:12px;line-height:1;">${readOnlineLink(webUrl, light.muted)}</td></tr>\n`
		: "";
	const schemes = dark.enabled ? "light dark" : "light";
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="${schemes}">
<meta name="supported-color-schemes" content="${schemes}">
<title>${escapeHtml(subject)}</title>
<style>
:root { color-scheme: ${schemes}; supported-color-schemes: ${schemes}; }
.body a { color: ${light.accent}; }
.body img { max-width: 100%; height: auto; border-radius: 8px; }
.body h1, .body h2, .body h3 { ${headingStyle(theme, light)} line-height: 1.25; margin: 32px 0 12px; }
.body p, .body ul, .body ol { margin: 0 0 16px; }
.body blockquote { margin: 0 0 16px; padding-left: 16px; border-left: 3px solid ${light.line}; color: ${light.muted}; }
.body code { font-family: ${CODE_FONT_STACK}; font-size: 14px; background: ${light.box}; padding: 2px 4px; border-radius: 4px; }
.body hr { border: 0; border-top: 1px solid ${light.line}; margin: 32px 0; }
@media (max-width: 480px) { .card { padding: 24px 20px 12px !important; } .pad { padding: 24px 16px !important; } }
${dark.enabled ? darkStyles(theme, body.includes('<a class="button"')) : ""}
</style>
</head>
<body class="page" bgcolor="${light.page}" style="margin:0;padding:0;background:${light.page};">
${preheaderHtml(previewText)}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="page" bgcolor="${light.page}" style="background:${light.page};">
<tr><td align="center" class="pad" style="padding:32px 20px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="col" style="max-width:600px;font-family:${bodyFont};font-size:16px;line-height:1.65;color:${light.text};">
${wordmarkHtml(theme)}${readOnline}${column}
${footer}
</table>
</td></tr>
</table>
</body>
</html>`;
}

// The whole email in a look. `look` is what getEmailLook returned; the web version has no subscriber footer.
export function renderLookHtml({ bodyHtml, subject, previewText, newsletter, unsubscribeUrl, webUrl, isWebVersion, look }) {
	const footer = isWebVersion ? "" : footerHtml({ newsletter, unsubscribeUrl, theme: look });
	return wrapThemedBody({ bodyHtml, subject, previewText, footer, webUrl, theme: look });
}
