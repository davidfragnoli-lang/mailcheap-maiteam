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
