// Builds fixtures/maifortune-welcome/copy.maiteam.<lang>.json from maiteam's approved welcome copy.
//
//   node tests/runners/build-maifortune-copy.mjs --source <maiteam-tracker-design checkout> --lang en|fr|es
//
// Every source file must match its pinned hash, or nothing is written: EN/FR the hashes relayed on FRA-25943
// (comment ced223b0, design cd801e6), ES the six-hash manifest of QI-27854 (design 846f6f5), which re-locked QI-27657's copy.
// The design repository has moved on since cd801e6, so EN/FR and ES are pinned, and checked, apart.
// The words come from the plain-text mails unchanged. Only four mechanical changes are made, and each is
// checked by undoing it and comparing with the source bytes:
//   1. the confirmation button line "[Label] [confirmation link]" becomes mailcheap's confirm link, written as
//      upstream's built-in confirmation button, <a href="{{confirm_url}}" style="display:inline-block;background:#18181b;
//      color:#ffffff;...;border-radius:8px;">Label</a>: the renderer repaints exactly that markup in the newsletter's
//      look (BUTTON_STYLE_PATTERN in lib/render-email.js), so the fortuna preset colours it;
//   2. footer lines end in two spaces (a Markdown line break) so they stay on separate lines;
//   3. subject 1 and preview 1 are sent; subject 2 and preview 2 are kept, unsent, as the alternative;
//   4. the product is renamed (David, 20 Oct 2026, FRA-25997): "mAIfortune Tracker" and "mAIfortune" become
//      "fortuna". The URL maifortune.maiteam.ch is left as written. Checked by comparing with the renamed
//      source, and by finding no old name left.
// Every other bracketed placeholder (EN/FR: [pending QI-27046], [sender address], [postal address: ...]) stays as
// written; the ES copy has none left. Mail 4 is an outline in the series document and is not part of the sequence.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const EXPECTED = {
	"docs/MAIFORTUNE-WELCOME-SERIES.md": "aa0a0d7e96e69de195fa3e0c99c7f4ed0d68abfa8a8573f223067aa667bcb20a",
	"docs/welcome-series/01-confirm.en.html": "dacd7b355cf31610e93ebf4f228699b5aa9aa8f7118a00525908097e88eae9ba",
	"docs/welcome-series/01-confirm.en.txt": "0224c2e9633b4a3d212835f23754e56b588f59ddc0a7827acc4a46923ddeee23",
	"docs/welcome-series/01-confirm.fr.html": "09388f03485b369de1652033dd535f8bad161f21c93349575db94449c119db9f",
	"docs/welcome-series/01-confirm.fr.txt": "8d42791ddf3110ef9529d5acd40d3567e1bd2ab024b9496484210a52d9f56a27",
	"docs/welcome-series/02-data.en.html": "9eeab387e41db1498f0165069d72a310a6d3477b8fe9128eb8efa1bf2da29be9",
	"docs/welcome-series/02-data.en.txt": "86eb9cf53dce04c02b3d4fe2f6776989280f345c95e7b3ba000195cb951ac615",
	"docs/welcome-series/02-data.fr.html": "18f8fc35c5edcb684130c8d3a69aa0fd3d5dd985d361c12d2fed0dcbfbfd5bc5",
	"docs/welcome-series/02-data.fr.txt": "07faba50ff47272223bcd44ffe1e7f18406ed04a22c7cf7db35887205db63229",
	"docs/welcome-series/03-agent.en.html": "f403496d1e0b774406e5088bf8e46259cd36864b55a426c628c0c3e5ad827c3e",
	"docs/welcome-series/03-agent.en.txt": "c3b01c0497114c7e15edea3bfe95180ab28edbf32e1bb46a9f519f88c3e8cd30",
	"docs/welcome-series/03-agent.fr.html": "03b81aa4db7c358cb62951f685077543ea75985023b132d821f1feed7d7581e6",
	"docs/welcome-series/03-agent.fr.txt": "abfa66cf4da0dd04dacada7de4d791cce8dc10c45946d22f3b443e8b065ecdd8",
};
const EXPECTED_ES = {
	"docs/welcome-series/01-confirm.es.html": "613e82a43b079efab70d689e16c1be832f505c0a6be4d3d6785365a36ef7a307",
	"docs/welcome-series/01-confirm.es.txt": "ce9dc0c88d98ece3377db9e48abbd31dd8937bf85ce642cb95f3386fc3755f59",
	"docs/welcome-series/02-data.es.html": "3f2b64adcdf85b5aedb40dd80563ed2d92725c867c19250f11d1c2c19e76d67b",
	"docs/welcome-series/02-data.es.txt": "2a6079fdf2f75231b954376b313954e7152bf35fdf3c89b0a8b448fe62decae6",
	"docs/welcome-series/03-agent.es.html": "f72494643dfe726a8cac32c3dd20171aee96c6d8ebdb5ce73579505ee454271f",
	"docs/welcome-series/03-agent.es.txt": "6ccf55901afccb57a714784a0c95fbdf0c5fe53b3144e882d43282a3f1ea3418",
};
const DAY = 86_400_000;
// The series document, section 3: mail 1 straight after the form, mail 2 on day 1 and mail 3 on day 3
// after confirmation. mailcheap enrolls at confirmation, so mails 2 and 3 are steps 1 and 2.
const MAILS = [
	{ file: "02-data", delayDays: 1 },
	{ file: "03-agent", delayDays: 3 },
];
// Longest first, so "mAIfortune Tracker" is not left as "fortuna Tracker".
const RENAMES = [
	["mAIfortune Tracker", "fortuna"],
	["mAIfortune", "fortuna"],
];
const OLD_NAMES = /mAIfortune|MAIfortune|Maifortune(?!\.maiteam\.ch)/;
const rename = (text) => RENAMES.reduce((out, [from, to]) => out.replaceAll(from, to), text);
const CONFIRM_LINK = { en: "confirmation link", fr: "lien de confirmation", es: "enlace de confirmación" };
// Upstream's built-in confirmation button (lib/confirmation-content.js), the one markup lib/render-email.js recolours.
const BUTTON_STYLE = "display:inline-block;background:#18181b;color:#ffffff;text-decoration:none;font-weight:600;padding:12px 22px;border-radius:8px;";
const HEADER = {
	en: ["Subject 1: ", "Preview 1: ", "Subject 2: ", "Preview 2: "],
	fr: ["Objet 1 : ", "Aperçu 1 : ", "Objet 2 : ", "Aperçu 2 : "],
	es: ["Asunto 1: ", "Vista previa 1: ", "Asunto 2: ", "Vista previa 2: "],
};

const args = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 2) args[argv[i].replace(/^--/, "")] = argv[i + 1];
if (!args.source || !["en", "fr", "es"].includes(args.lang)) throw new Error("Usage: --source <dir> --lang en|fr|es");
const lang = args.lang;
const PINNED = lang === "es" ? EXPECTED_ES : EXPECTED;
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

// maiteam renamed its series document on 20 Oct 2026 (git mv, same bytes); either name is read, and the hash
// still decides.
const RENAMED_SOURCES = { "docs/MAIFORTUNE-WELCOME-SERIES.md": "docs/FORTUNA-WELCOME-SERIES.md" };
function sourcePath(relative) {
	const original = path.join(args.source, relative);
	if (fs.existsSync(original) || !RENAMED_SOURCES[relative]) return original;
	return path.join(args.source, RENAMED_SOURCES[relative]);
}

const files = {};
for (const [relative, expected] of Object.entries(PINNED)) {
	const bytes = fs.readFileSync(sourcePath(relative));
	const actual = sha256(bytes);
	if (actual !== expected) {
		console.error(`STOP: ${relative} is ${actual}, relayed hash is ${expected}. Nothing written.`);
		process.exit(3);
	}
	files[relative] = bytes.toString("utf8");
}

function parseMail(name, { confirmation = false } = {}) {
	const relative = `docs/welcome-series/${name}.${lang}.txt`;
	const source = rename(files[relative]);
	if (OLD_NAMES.test(source)) throw new Error(`${relative}: an old product name is left after the rename`);
	const lines = source.replace(/\n$/, "").split("\n");
	const header = HEADER[lang].map((prefix, index) => {
		if (!lines[index].startsWith(prefix)) throw new Error(`${relative} line ${index + 1} should start with "${prefix}"`);
		return lines[index].slice(prefix.length);
	});
	if (lines[4] !== "") throw new Error(`${relative}: expected a blank line after the subjects`);
	const separator = lines.indexOf("--");
	if (separator < 0) throw new Error(`${relative}: no "--" footer separator`);
	const body = lines.slice(5, separator);
	const footer = lines.slice(separator);

	let button = null;
	const bodyOut = body.map((line) => {
		const match = /^\[([^\]]+)\] \[([^\]]+)\]$/.exec(line);
		if (confirmation && match && match[2] === CONFIRM_LINK[lang]) {
			button = { line, label: match[1] };
			return `<a href="{{confirm_url}}" style="${BUTTON_STYLE}">${match[1]}</a>`;
		}
		return line;
	});
	if (confirmation && !button) throw new Error(`${relative}: confirmation button line not found`);
	const markdown = [...bodyOut, footer.map((line, index) => (index < footer.length - 1 ? `${line}  ` : line)).join("\n")].join("\n");

	// Undo the changes and compare with the renamed source, so nothing else can have moved.
	const undone = markdown
		.split("\n")
		.map((line) => (button && line.startsWith('<a href="{{confirm_url}}"') ? button.line : line.replace(/ {2}$/, "")))
		.join("\n");
	const rebuilt = `${lines.slice(0, 5).join("\n")}\n${undone}\n`;
	if (rebuilt !== source) throw new Error(`${relative}: transcription does not round-trip to the renamed source bytes`);

	return {
		mail: { source: relative, sha256: PINNED[relative], html: relative.replace(/\.txt$/, ".html"), htmlSha256: PINNED[relative.replace(/\.txt$/, ".html")] },
		subject: header[0],
		previewText: header[1],
		alternative: { subject: header[2], previewText: header[3], sent: false },
		markdown,
	};
}

const confirmation = parseMail("01-confirm", { confirmation: true });
const steps = MAILS.map(({ file, delayDays }, index) => ({ position: index + 1, delayDays, ...parseMail(file) }));
const SOURCE = {
	en: {
		status: "maiteam-approved",
		source: {
			owner: "maiteam Design & Offer",
			issue: "QI-27055",
			approval: "David accepted QI-27055 card 87b8afae on 2026-10-19 (relayed by the board on FRA-25943, comment ced223b0)",
			retrieved: true,
			path: "maiteam-ships/maiteam-tracker-design at cd801e6 (QI-27055; bytes pinned by hash)",
			document: { file: "docs/MAIFORTUNE-WELCOME-SERIES.md", sha256: EXPECTED["docs/MAIFORTUNE-WELCOME-SERIES.md"] },
			files: EXPECTED,
			transcription: [
				"Words from the .txt mails unchanged except the product rename; checked by round trip to the renamed source bytes",
				"Product renamed per David, 20 Oct 2026 (FRA-25997): \"mAIfortune Tracker\" and \"mAIfortune\" become \"fortuna\"; the URL maifortune.maiteam.ch is unchanged",
				"Confirmation button line bound to mailcheap's {{confirm_url}} as upstream's built-in button markup (inline-block, #18181b on #ffffff, border-radius), which the renderer repaints in the newsletter's look",
				"Footer lines end in two spaces (Markdown line break)",
				"Subject 1 / preview 1 sent; subject 2 / preview 2 kept as the unsent alternative",
				"Gated lines kept as marked: [pending QI-27046] in mail 2, \"your agent\" (no named client) in mail 3",
				"Mail 4 is an outline only and is not in the sequence",
			],
		},
	},
	// The ES series names the product "fortuna" already, so the rename finds nothing to change; the check that no old
	// name is left still runs. It has no series document of its own: the cadence is the EN/FR one, which it matches.
	es: {
		status: "maiteam-locked",
		source: {
			owner: "maiteam Design & Offer",
			issue: "QI-27854",
			approval: "Locked in QI-27657, re-locked by Design & Offer on QI-27854 (comment 3b52af10, design 846f6f5) with every placeholder resolved; built on QI-27851. Not yet independently QA'd",
			retrieved: true,
			path: "maiteam-ships/maiteam-tracker-design at 846f6f57329670586ae1b0017f5cc42257ba6ba2 (QI-27854; bytes pinned by hash)",
			files: EXPECTED_ES,
			transcription: [
				"Words from the .txt mails unchanged; checked by round trip to the source bytes",
				"Confirmation button line \"[Confirmar mi correo] [enlace de confirmación]\" bound to mailcheap's {{confirm_url}} as upstream's built-in button markup (inline-block, #18181b on #ffffff, border-radius), which the renderer repaints in the newsletter's look",
				"Footer lines end in two spaces (Markdown line break)",
				"Asunto 1 / vista previa 1 sent; asunto 2 / vista previa 2 kept as the unsent alternative",
				"No placeholders: the in-copy unsubscribe and postal lines are gone, mailcheap's system footer prints them in the newsletter's language (QI-27854 option A)",
			],
		},
	},
};
SOURCE.fr = SOURCE.en;

const copy = {
	status: SOURCE[lang].status,
	language: lang,
	source: SOURCE[lang].source,
	cadence: {
		note: "Mail 1 is the double opt-in email at signup. Mails 2 and 3 are timed from the confirmed enrollment.",
		stepDelaysMs: MAILS.map(({ delayDays }) => delayDays * DAY),
	},
	confirmation: { subject: confirmation.subject, previewText: confirmation.previewText, markdown: confirmation.markdown, mail: confirmation.mail, alternative: confirmation.alternative },
	steps,
};
const out = path.join(ROOT, `fixtures/maifortune-welcome/copy.maiteam.${lang}.json`);
fs.writeFileSync(out, `${JSON.stringify(copy, null, 2)}\n`);
console.log(JSON.stringify({ written: path.relative(ROOT, out), sha256: sha256(fs.readFileSync(out)), sourcesVerified: Object.keys(PINNED).length }));
