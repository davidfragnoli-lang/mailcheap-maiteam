import assert from "node:assert/strict";
import { test } from "node:test";
import { EMAIL_LANGUAGES, getEmailLanguage } from "../lib/maiteam/email-language.js";
import { renderEmail } from "../lib/render-email.js";

// PATCHES.md P12 (QI-27854): the footer and Read online mailcheap adds follow the newsletter's language, in both
// upstream's theme and a maiteam look, and in an HTML issue built elsewhere. Strings from Design & Offer; Italian and
// German from P13 (FRA-26541).
const UNSUBSCRIBE = "https://mail.example.com/unsubscribe?token=t";
const WEB = "https://news.example.com/issue";
const newsletter = (language, extra = {}) => ({ name: "fortuna", postalAddress: "1 Main St, Paris", ...(language && { language }), ...extra });
const render = (nl, options = {}) => renderEmail({ markdown: "Hola", subject: "S", newsletter: nl, unsubscribeUrl: UNSUBSCRIBE, webUrl: WEB, ...options });

const EXPECTED = {
	es: { reason: "Recibes este correo porque te suscribiste a fortuna.", link: "Darte de baja", text: `Darte de baja: ${UNSUBSCRIBE}`, read: "Leer en la web", readText: `Leer en la web: ${WEB}` },
	fr: { reason: "Vous recevez cet e-mail suite à votre inscription à fortuna.", link: "Se désinscrire", text: `Se désinscrire : ${UNSUBSCRIBE}`, read: "Lire en ligne", readText: `Lire en ligne : ${WEB}` },
	it: { reason: "Ricevi questa email per la tua iscrizione a fortuna.", link: "Annulla l'iscrizione", text: `Annulla l'iscrizione: ${UNSUBSCRIBE}`, read: "Leggi online", readText: `Leggi online: ${WEB}` },
	de: { reason: "Du erhältst diese E-Mail, weil du dich für fortuna angemeldet hast.", link: "Abmelden", text: `Abmelden: ${UNSUBSCRIBE}`, read: "Online lesen", readText: `Online lesen: ${WEB}` },
	en: { reason: "You're receiving this because you subscribed to fortuna.", link: "Unsubscribe", text: `Unsubscribe: ${UNSUBSCRIBE}`, read: "Read online", readText: `Read online: ${WEB}` },
};
const LOOKS = { theme: {}, look: { look: { preset: "maiteam" } }, html: { format: "html", html: "<html><body><p>Hola</p></body></html>" } };

for (const [language, strings] of Object.entries(EXPECTED)) {
	for (const [kind, options] of Object.entries(LOOKS)) {
		test(`${language} footer and Read online, ${kind}`, () => {
			const { html, text } = render(newsletter(language === "en" ? null : language), options);
			assert.ok(html.includes(strings.reason), html);
			assert.match(html, new RegExp(`<a (?:class="[^"]*" )?href="${UNSUBSCRIBE.replace(/[?.]/g, "\\$&")}"[^>]*>${strings.link}</a><br>1 Main St, Paris`));
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
	assert.match(render(newsletter("it", { name: "" })).html, /iscrizione a questa newsletter\./);
	assert.match(render(newsletter("de", { name: "" })).text, /dich für diesen Newsletter angemeldet hast\./);
});

test("an unknown or missing language is English", () => {
	assert.equal(getEmailLanguage({ language: "pt" }), "en");
	assert.equal(getEmailLanguage({ language: "DE" }), "en", "codes are lowercase");
	assert.equal(getEmailLanguage(null), "en");
	assert.match(render(newsletter("xx")).html, /<html lang="en">[\s\S]*>Unsubscribe<\/a>/);
});

test("it and de are newsletter languages the settings, the API and the model accept", () => {
	assert.deepEqual(EMAIL_LANGUAGES, ["en", "es", "fr", "it", "de"]);
	for (const language of ["it", "de"]) assert.equal(getEmailLanguage({ language }), language);
});

// FRA-25998 r4e: P13's it and de, merged onto the upstream 40244c9 renderer. An Italian and a German issue written in
// 40244c9's editor (a <div data-button> button) under the maiteam fortuna look: the footer and Read online are in the
// newsletter's language, <html lang> follows, and the editor button is drawn in fortuna's malva, not left as a marker.
test("it and de footers render through 40244c9's editor output under the fortuna look", () => {
	const html = '<p>Ciao</p><div data-button=""><a href="https://example.com/go">Go</a></div>';
	for (const language of ["it", "de"]) {
		const strings = EXPECTED[language];
		const rendered = renderEmail({
			format: "rich",
			html,
			subject: "S",
			newsletter: newsletter(language, { theme: { look: { preset: "maiteam", product: "fortuna" } } }),
			unsubscribeUrl: UNSUBSCRIBE,
			webUrl: WEB,
		});
		assert.match(rendered.html, new RegExp(`<html lang="${language}">`), language);
		assert.ok(rendered.html.includes(strings.reason), language);
		assert.match(rendered.html, new RegExp(`>${strings.link}</a>`), language);
		assert.match(rendered.html, new RegExp(`>${strings.read}</a>`), language);
		assert.ok(rendered.text.includes(strings.text), language);
		assert.ok(!rendered.html.includes("data-button"), `${language}: no raw button marker`);
		assert.match(rendered.html, /<a[^>]*href="https:\/\/example.com\/go"[^>]*background:#6e5c96;/, `${language}: malva button`);
		assert.doesNotMatch(`${rendered.html}\n${rendered.text}`, /receiving this|>Unsubscribe<|Read online/, language);
	}
});

// FRA-25998 r9 (upstream e6b5d72): an issue's author byline, in upstream's theme and under a maiteam look, says "By" in
// the newsletter's language, and stays out of the web version.
test("the author byline follows the newsletter's language, in upstream's theme and in a look", () => {
	const author = { name: "Ada", imageUrl: null };
	const BY = { en: "By Ada", es: "Por Ada", fr: "Par Ada", it: "Di Ada", de: "Von Ada" };
	for (const [language, line] of Object.entries(BY)) {
		for (const options of [{}, { look: { preset: "maiteam", product: "fortuna" } }]) {
			const { html, text } = render(newsletter(language === "en" ? null : language), { ...options, author });
			assert.match(html, new RegExp(`vertical-align:middle;">${line}</span>`), `${language} ${options.look ? "look" : "theme"}`);
			assert.ok(text.includes(`${line}\n\n`), text);
			assert.ok(!render(newsletter(language), { ...options, author, isWebVersion: true }).html.includes(line), "no byline on the web version");
		}
	}
	assert.ok(!render(newsletter("es"), { look: { preset: "maiteam" } }).html.includes("Por "), "no author, no byline");
});
