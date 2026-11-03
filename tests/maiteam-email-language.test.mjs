import assert from "node:assert/strict";
import { test } from "node:test";
import { getEmailLanguage } from "../lib/maiteam/email-language.js";
import { renderEmail } from "../lib/render-email.js";

// PATCHES.md P12 (QI-27854): the footer and Read online mailcheap adds follow the newsletter's language, in both
// upstream's theme and a maiteam look, and in an HTML issue built elsewhere. Strings from Design & Offer.
const UNSUBSCRIBE = "https://mail.example.com/unsubscribe?token=t";
const WEB = "https://news.example.com/issue";
const newsletter = (language, extra = {}) => ({ name: "fortuna", postalAddress: "1 Main St, Paris", ...(language && { language }), ...extra });
const render = (nl, options = {}) => renderEmail({ markdown: "Hola", subject: "S", newsletter: nl, unsubscribeUrl: UNSUBSCRIBE, webUrl: WEB, ...options });

const EXPECTED = {
	es: { reason: "Recibes este correo porque te suscribiste a fortuna.", link: "Darte de baja", text: `Darte de baja: ${UNSUBSCRIBE}`, read: "Leer en la web", readText: `Leer en la web: ${WEB}` },
	fr: { reason: "Vous recevez cet e-mail suite à votre inscription à fortuna.", link: "Se désinscrire", text: `Se désinscrire : ${UNSUBSCRIBE}`, read: "Lire en ligne", readText: `Lire en ligne : ${WEB}` },
	en: { reason: "You're receiving this because you subscribed to fortuna.", link: "Unsubscribe", text: `Unsubscribe: ${UNSUBSCRIBE}`, read: "Read online", readText: `Read online: ${WEB}` },
};
const LOOKS = { theme: {}, look: { look: { preset: "maiteam" } }, html: { format: "html", html: "<html><body><p>Hola</p></body></html>" } };

for (const [language, strings] of Object.entries(EXPECTED)) {
	for (const [kind, options] of Object.entries(LOOKS)) {
		test(`${language} footer and Read online, ${kind}`, () => {
			const { html, text } = render(newsletter(language === "en" ? null : language), options);
			assert.ok(html.includes(strings.reason), html);
			assert.match(html, new RegExp(`<a href="${UNSUBSCRIBE.replace(/[?.]/g, "\\$&")}"[^>]*>${strings.link}</a><br>1 Main St, Paris`));
			assert.match(html, new RegExp(`>${strings.read}</a>`));
			if (kind !== "html") {
				assert.match(html, new RegExp(`<html lang="${language}">`));
				assert.ok(text.startsWith(`${strings.readText}\n\n`), text);
			}
			// An HTML issue's text part is its HTML as text, links included.
			assert.ok(text.includes(kind === "html" ? `${strings.link} (${UNSUBSCRIBE})` : strings.text), text);
			if (language !== "en") assert.doesNotMatch(`${html}\n${text}`, /receiving this|>Unsubscribe<|Read online/);
		});
	}
}

test("a newsletter without a name gets the language's own fallback", () => {
	assert.match(render(newsletter("es", { name: "" })).html, /te suscribiste a este boletín\./);
	assert.match(render(newsletter("fr", { name: "" })).text, /inscription à cette newsletter\./);
});

test("an unknown or missing language is English", () => {
	assert.equal(getEmailLanguage({ language: "de" }), "en");
	assert.equal(getEmailLanguage(null), "en");
	assert.match(render(newsletter("xx")).html, /<html lang="en">[\s\S]*>Unsubscribe<\/a>/);
});
