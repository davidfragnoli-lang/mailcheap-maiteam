// maiteam (PATCHES.md P12): the language of the lines mailcheap adds to every email, the subscriber footer and
// "Read online", so a Spanish or French issue doesn't end in English. Strings from Design & Offer (QI-27854);
// Italian and German (P13, FRA-26541) in the same shape: short, "tu"/"du", gender-neutral.
// by: the byline above an issue when its author shows in emails (upstream e6b5d72).
// The issue itself is written in whatever language its author writes it in.
export const EMAIL_LANGUAGES = ["en", "es", "fr", "it", "de"];

const STRINGS = {
	en: {
		by: (name) => `By ${name}`,
		reason: (name) => `You're receiving this because you subscribed to ${name}.`,
		fallbackName: "this newsletter",
		unsubscribe: "Unsubscribe",
		unsubscribeText: (url) => `Unsubscribe: ${url}`,
		readOnline: "Read online",
		readOnlineText: (url) => `Read online: ${url}`,
	},
	es: {
		by: (name) => `Por ${name}`,
		reason: (name) => `Recibes este correo porque te suscribiste a ${name}.`,
		fallbackName: "este boletín",
		unsubscribe: "Darte de baja",
		unsubscribeText: (url) => `Darte de baja: ${url}`,
		readOnline: "Leer en la web",
		readOnlineText: (url) => `Leer en la web: ${url}`,
	},
	fr: {
		by: (name) => `Par ${name}`,
		reason: (name) => `Vous recevez cet e-mail suite à votre inscription à ${name}.`,
		fallbackName: "cette newsletter",
		unsubscribe: "Se désinscrire",
		unsubscribeText: (url) => `Se désinscrire : ${url}`,
		readOnline: "Lire en ligne",
		readOnlineText: (url) => `Lire en ligne : ${url}`,
	},
	it: {
		by: (name) => `Di ${name}`,
		reason: (name) => `Ricevi questa email per la tua iscrizione a ${name}.`,
		fallbackName: "questa newsletter",
		unsubscribe: "Annulla l'iscrizione",
		unsubscribeText: (url) => `Annulla l'iscrizione: ${url}`,
		readOnline: "Leggi online",
		readOnlineText: (url) => `Leggi online: ${url}`,
	},
	de: {
		by: (name) => `Von ${name}`,
		reason: (name) => `Du erhältst diese E-Mail, weil du dich für ${name} angemeldet hast.`,
		fallbackName: "diesen Newsletter",
		unsubscribe: "Abmelden",
		unsubscribeText: (url) => `Abmelden: ${url}`,
		readOnline: "Online lesen",
		readOnlineText: (url) => `Online lesen: ${url}`,
	},
};

export function getEmailLanguage(newsletter) {
	return EMAIL_LANGUAGES.includes(newsletter?.language) ? newsletter.language : "en";
}

export function getEmailStrings(newsletter) {
	return STRINGS[getEmailLanguage(newsletter)];
}
