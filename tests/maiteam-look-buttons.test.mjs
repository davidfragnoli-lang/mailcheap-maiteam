import assert from "node:assert/strict";
import { test } from "node:test";
import { getConfirmationContent } from "../lib/confirmation-content.js";
import { renderEmail } from "../lib/render-email.js";

// A maiteam look repaints upstream's ink buttons (the built-in confirmation, copy written for upstream's renderer) as
// its one button, light and dark; the old fork's other looks leave them as it always did.
const buttonOf = (html) => html.match(/<a[^>]*\{\{confirm_url\}\}[^>]*>/)[0];

test("maiteam product and company looks paint the confirmation button in their own colours", () => {
	const content = getConfirmationContent({ name: "fortuna" });
	for (const [product, light, dark] of [["fortuna", "#6e5c96", "#ae9cd2"], ["quote-to-invoice", "#c85a2a", "#d9703f"], ["company", "#1a1a18", "#f2f1ec"]]) {
		const { html } = renderEmail({ ...content, newsletter: { name: "n", theme: { look: { preset: "maiteam", product } } } });
		assert.match(buttonOf(html), new RegExp(`class="button"[^>]*background:${light};`), product);
		assert.ok(html.includes(`.body a.button { background: ${dark} !important;`), `${product} dark`);
	}
});

test("the landing and letter looks keep the accepted ink button", () => {
	const content = getConfirmationContent({ name: "David Fragnoli" });
	for (const preset of ["landing", "letter"]) {
		const { html } = renderEmail({ ...content, newsletter: { name: "n", theme: { look: { preset } } } });
		assert.match(buttonOf(html), /background:#18181b;color:#ffffff;/, preset);
		assert.ok(!buttonOf(html).includes('class="button"'), preset);
	}
});

// Upstream 40244c9 (FRA-25998 r4): its editor writes buttons as <div data-button> and HTML blocks as markers. Under a
// look neither may reach the reader raw: a button is drawn as the ink link the looks repaint, a block is expanded.
test("an editor button and an HTML block under a look render, not their markers", () => {
	const html = '<p>Hi</p><div data-button=""><a href="https://example.com/go">Go</a></div>';
	for (const [look, colour] of [[{ preset: "maiteam", product: "fortuna" }, "#6e5c96"], [{ preset: "landing" }, "#18181b"]]) {
		const rendered = renderEmail({ format: "rich", html, subject: "s", newsletter: { name: "n", theme: { look } } }).html;
		assert.ok(!rendered.includes("data-button"), `${look.preset}: no raw button marker`);
		assert.match(rendered, new RegExp(`<a[^>]*href="https://example.com/go"[^>]*background:${colour};`), `${look.preset}: drawn in ${colour}`);
	}
	const empty = renderEmail({ format: "rich", html: '<div data-button=""><a href="https://example.com/go"></a></div>', subject: "s", newsletter: { name: "n", theme: { look: { preset: "maiteam" } } } }).html;
	assert.ok(!empty.includes("example.com/go"), "a button without text is left out, as upstream does");
});
