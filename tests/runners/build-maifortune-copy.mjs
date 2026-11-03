// Builds fixtures/maifortune-welcome/copy.maiteam.<lang>.json from maiteam's approved welcome copy.
//
//   node tests/runners/build-maifortune-copy.mjs --source <maiteam-tracker-design checkout> --lang en|fr|es
//
// Every source file must match its pinned hash, or nothing is written. All three languages are pinned at design 68c1696
// (QI-27910): Design's QI-27854 re-lock (846f6f5) plus the pricing v2 lines of QI-27885 COPY-DELTAS §C2 (f76a6e2).
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
// The copy has no bracketed placeholder left. Mail 4 (the invite) is not part of the sequence.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
// Design 68c1696 (QI-27910): the QI-27854 re-lock at 846f6f5 plus the pricing v2 lines of QI-27885 COPY-DELTAS §C2.
const EXPECTED = {
	"docs/welcome-series/01-confirm.en.html": "0cf087d4711119633115ee231c252ece312cfa822e602b64454d0fc4d58e93ba",
	"docs/welcome-series/01-confirm.en.txt": "3e25689c1f58d27b739d27be606e0b72174d6e1feff0ea692804562f0dd447de",
	"docs/welcome-series/02-data.en.html": "20ba04bab61b7a46e1182e4d3dc9e3b1b7150d4ae527c6d0653747407ff14e33",
	"docs/welcome-series/02-data.en.txt": "0e363a7d3e3175a5df6a42dfa42e0927f71fa923f59e8a71f250c2295eb273a7",
	"docs/welcome-series/03-agent.en.html": "befb411ff7857544a139aae20983814fe95ec240433b8839fdbca7413c7fb1ca",
	"docs/welcome-series/03-agent.en.txt": "d3650aebcebb1604e54497083fad873e81e8ea94faa3c9d0c63346b69605c939",
	"docs/welcome-series/01-confirm.fr.html": "bb94cd25c718c7e13ab2b9ea5f61d4c85438aca4394e8377a98181423f9b7df6",
	"docs/welcome-series/01-confirm.fr.txt": "900603fcdc6ccaa42683353fe59160c75af2e5b24ebb8872c91eecb4b32a10f5",
	"docs/welcome-series/02-data.fr.html": "a728a6a9b9753ab966e25594b2ce170cefb30711b256ceed3fe2ea4f2a98bac6",
	"docs/welcome-series/02-data.fr.txt": "3b4bad235520524a3894a985680f41290fd5ddd71c977c6147ecb1bde78a346a",
	"docs/welcome-series/03-agent.fr.html": "f437757a91d15cbb0714ca9cc3929dc0b8c8772ac5aee79c0ecdf31e27f0225a",
	"docs/welcome-series/03-agent.fr.txt": "bbf0ded55e62ac0bf69ccfb6a96a83187f1c4d6cc4787a2133a4568aca52cffb",
	"docs/welcome-series/01-confirm.es.html": "f0216516d82f9f93eccab086876a0269b9167fae056fa07e676751df5dd33eff",
	"docs/welcome-series/01-confirm.es.txt": "6ea79d69cb6492e936f7800b023296771ffa62e97743809a40d47ee188df1941",
	"docs/welcome-series/02-data.es.html": "3f2b64adcdf85b5aedb40dd80563ed2d92725c867c19250f11d1c2c19e76d67b",
	"docs/welcome-series/02-data.es.txt": "2a6079fdf2f75231b954376b313954e7152bf35fdf3c89b0a8b448fe62decae6",
	"docs/welcome-series/03-agent.es.html": "2cd3baec1a522584c2dd27bbaa5c3d2ec349b39ebfb62a1173001d7670eca494",
	"docs/welcome-series/03-agent.es.txt": "17332656308d1ef2caadff8f98d4f0a7af2055e778a9b5abb55e0f6614a03a2e",
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
const PINNED = Object.fromEntries(Object.entries(EXPECTED).filter(([file]) => file.includes(`.${lang}.`)));
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
	status: "maiteam-locked",
	source: {
		owner: "maiteam Design & Offer",
		issue: "QI-27910",
		approval:
			"Re-locked by Design & Offer on QI-27854 (comment 3b52af10, design 846f6f5) with every placeholder resolved; pricing v2 lines from QI-27885 COPY-DELTAS §C2 (design f76a6e2, David's pricing v2 of 31 Oct 2026) applied verbatim on QI-27910. Not yet independently QA'd",
		retrieved: true,
		path: "maiteam-ships/maiteam-tracker-design at 68c1696280c8761592d34eda86785c0f2458b394 (QI-27910; bytes pinned by hash)",
		files: PINNED,
		transcription: [
			"Words from the .txt mails unchanged; checked by round trip to the source bytes, and no old product name left",
			"Confirmation button line bound to mailcheap's {{confirm_url}} as upstream's built-in button markup (inline-block, #18181b on #ffffff, border-radius), which the renderer repaints in the newsletter's look",
			"Footer lines end in two spaces (Markdown line break)",
			"Subject 1 / preview 1 sent; subject 2 / preview 2 kept as the unsent alternative",
			"No placeholders: the in-copy unsubscribe and postal lines are gone, mailcheap's system footer prints them in the newsletter's language (QI-27854 option A)",
		],
	},
};

const copy = {
	status: SOURCE.status,
	language: lang,
	source: SOURCE.source,
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
