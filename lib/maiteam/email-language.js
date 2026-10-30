// maiteam (PATCHES.md P11): the language of the lines mailcheap adds to every email, the subscriber footer and
// "Read online", so a Spanish or French issue doesn't end in English. Strings from Design & Offer (QI-27854).
// The issue itself is written in whatever language its author writes it in.
export const EMAIL_LANGUAGES = ["en", "es", "fr"];

const STRINGS = {
	en: {
		reason: (name) => `You're receiving this because you subscribed to ${name}.`,
		fallbackName: "this newsletter",
		unsubscribe: "Unsubscribe",
		unsubscribeText: (url) => `Unsubscribe: ${url}`,
		readOnline: "Read online",
		readOnlineText: (url) => `Read online: ${url}`,
	},
	es: {
		reason: (name) => `Recibes este correo porque te suscribiste a ${name}.`,
		fallbackName: "este boletín",
		unsubscribe: "Darte de baja",
		unsubscribeText: (url) => `Darte de baja: ${url}`,
		readOnline: "Leer en la web",
		readOnlineText: (url) => `Leer en la web: ${url}`,
	},
	fr: {
		reason: (name) => `Vous recevez cet e-mail suite à votre inscription à ${name}.`,
		fallbackName: "cette newsletter",
		unsubscribe: "Se désinscrire",
		unsubscribeText: (url) => `Se désinscrire : ${url}`,
		readOnline: "Lire en ligne",
		readOnlineText: (url) => `Lire en ligne : ${url}`,
	},
};

export function getEmailLanguage(newsletter) {
	return EMAIL_LANGUAGES.includes(newsletter?.language) ? newsletter.language : "en";
}

export function getEmailStrings(newsletter) {
	return STRINGS[getEmailLanguage(newsletter)];
}
