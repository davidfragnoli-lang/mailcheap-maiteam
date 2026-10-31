import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

// fortuna pricing v2 (QI-27910, QI-27885 COPY-DELTAS §C2): the live three-mail series says fortuna is free and that
// fortuna + Agent costs CHF 89 a year; the 19 Oct single-offer lines are gone. Mail 02 makes no price claim.
const load = (lang) => JSON.parse(readFileSync(new URL(`../fixtures/maifortune-welcome/copy.maiteam.${lang}.json`, import.meta.url), "utf8"));

const EXPECT = {
	en: {
		intro: "fortuna is a free personal finance tracker in Swiss francs; with fortuna + Agent, your own AI agent can file into it.",
		invite: "with what is free and what fortuna + Agent costs, before anything costs you money.",
		agent: "A key from Settings → Agent keys is all it needs; the key is part of fortuna + Agent, CHF 89 a year, and the rest of fortuna is free.",
		old: /file into\. |with the price before|Agent access is all/,
	},
	fr: {
		intro: "fortuna est un suivi de finances personnelles gratuit, en francs suisses ; avec fortuna + Agent, votre propre agent IA peut y classer vos opérations.",
		invite: "avec ce qui est gratuit et ce que coûte fortuna + Agent, avant que quoi que ce soit vous coûte de l'argent.",
		agent: "Une clé créée dans Réglages → Clés d'agent suffit ; la clé fait partie de fortuna + Agent, CHF 89 par an, et le reste de fortuna est gratuit.",
		old: /dans lequel votre propre agent|avec le prix avant|Accès agents/,
	},
	es: {
		intro: "fortuna es un panel de finanzas personales gratuito, en francos suizos; con fortuna + Agent, tu propio agente de IA puede archivar transacciones en él.",
		invite: "con lo que es gratis y lo que cuesta fortuna + Agent, antes de que nada te cueste dinero.",
		agent: "Una clave de Ajustes → Claves de agente es todo lo que necesita; la clave forma parte de fortuna + Agent, CHF 89 al año, y el resto de fortuna es gratis.",
		old: /en el que tu propio agente|con el precio antes|Acceso de agentes/,
	},
};

describe("fortuna welcome series, pricing v2", () => {
	for (const [lang, want] of Object.entries(EXPECT)) {
		test(`${lang}: mail 01 and 03 carry the §C2 lines, mail 02 no price, no old offer`, () => {
			const copy = load(lang);
			assert.match(copy.source.path, /68c1696280c8761592d34eda86785c0f2458b394/);
			assert.ok(copy.confirmation.markdown.includes(want.intro));
			assert.ok(copy.confirmation.markdown.includes(want.invite));
			assert.ok(copy.steps[1].markdown.includes(want.agent));
			assert.doesNotMatch(copy.steps[0].markdown, /CHF|fortuna \+ Agent/);
			const all = [copy.confirmation, ...copy.steps].flatMap((m) => [m.subject, m.previewText, m.markdown, m.alternative.subject, m.alternative.previewText]).join("\n");
			assert.doesNotMatch(all, want.old);
			// One price only, never a self-hosted price, no trial, no "dashboard and agent together".
			assert.deepEqual([...all.matchAll(/CHF\s?\d+/g)].map(([m]) => m.replace(/\s/, " ")), ["CHF 89"]);
			assert.doesNotMatch(all, /self-hosted|auto-hébergé|autoalojado|trial|essai|prueba gratuita|together|ensemble|juntos/i);
			assert.doesNotMatch(all, /\[(?:pending|sender|postal|adresse|dirección)[^\]]*\]/i);
		});
	}
});
