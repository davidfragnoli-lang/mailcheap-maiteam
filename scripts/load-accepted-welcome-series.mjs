// maiteam (PATCHES.md P6): loads the accepted EN/FR welcome series (days 0, 3 and 7) into one newsletter of one account,
// as two draft sequences, welcome-en and welcome-fr. Rewritten for upstream's accounts from the old fork's script.
//
//   node scripts/load-accepted-welcome-series.mjs --source <accepted markdown> --account <accountId> --newsletter <slug>
//   ... --write   also needs MONGODB_URI; without it nothing connects to a database
//
// The source must match the accepted file's SHA-256, or nothing happens. Without --write the script only parses the
// source and prints the receipt it would write. With --write it upserts both sequences as drafts (nothing is sent:
// a draft takes no signups and start_sequence is a separate, explicit step), reads them back, refuses unless every
// field matches the source, and prints a receipt of content hashes. It never changes the newsletter itself.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import process from "node:process";
import { pathToFileURL } from "node:url";

const EXPECTED_SHA256 = "3e39ef5769590ff54339c248f8b490060713a04f88c381489bc10549c2538643";
const DELAYS = [0, 3, 7];
const DAY_MS = 86_400_000;
const OBJECT_ID = /^[a-f0-9]{24}$/i;
const SLUG = /^[a-z0-9-]{1,60}$/;
const NAMES = { EN: "Welcome — English", FR: "Bienvenue — Français" };
const PAUSE_REASON = "Awaiting davidfragnoli.ch link readiness and approved test window";

function fail(message) {
	console.error(`STOP: ${message}`);
	process.exit(1);
}

function readArgs(argv) {
	const args = { write: false };
	for (let index = 0; index < argv.length; index++) {
		const name = argv[index];
		if (name === "--write") args.write = true;
		else if (["--source", "--account", "--newsletter"].includes(name) && argv[index + 1] && !argv[index + 1].startsWith("--")) args[name.slice(2)] = argv[++index];
		else fail(`unknown or incomplete argument ${name}`);
	}
	if (!args.source || !args.account || !args.newsletter) {
		fail("Usage: node scripts/load-accepted-welcome-series.mjs --source <accepted markdown> --account <accountId> --newsletter <slug> [--write]");
	}
	if (!OBJECT_ID.test(args.account)) fail("--account must be an account's id");
	if (!SLUG.test(args.newsletter)) fail("--newsletter must be a newsletter's slug");
	return args;
}

export function parseAcceptedSeries(text) {
	const heading = /^## (EN|FR) ([1-3]) — .*? · (?:day|jour) (0|3|7)\n\n/gm;
	const matches = [...text.matchAll(heading)];
	if (matches.length !== 6) throw new Error(`Expected six accepted steps, found ${matches.length}.`);
	const parsed = { EN: [], FR: [] };
	for (let index = 0; index < matches.length; index += 1) {
		const match = matches[index];
		const end = index + 1 < matches.length ? matches[index + 1].index : text.length;
		const block = text.slice(match.index + match[0].length, end).replace(/\n\n---\n*$/, "").replace(/\n+$/, "");
		const labels = match[1] === "EN" ? { subject: "Subject", preview: "Preview text", colon: ":" } : { subject: "Objet", preview: "Texte d'aperçu", colon: " :" };
		const prefix = `**${labels.subject}${labels.colon}** `;
		if (!block.startsWith(prefix)) throw new Error(`Missing ${labels.subject} in ${match[1]} ${match[2]}.`);
		const subjectEnd = block.indexOf("\n");
		const previewPrefix = `**${labels.preview}${labels.colon}** `;
		if (!block.startsWith(previewPrefix, subjectEnd + 1)) throw new Error(`Missing preview in ${match[1]} ${match[2]}.`);
		const previewEnd = block.indexOf("\n", subjectEnd + 1);
		parsed[match[1]].push({
			position: Number(match[2]),
			delayDays: Number(match[3]),
			delayFromEnrollmentMs: Number(match[3]) * DAY_MS,
			useWelcome: false,
			subject: block.slice(prefix.length, subjectEnd),
			previewText: block.slice(subjectEnd + 1 + previewPrefix.length, previewEnd),
			markdown: block.slice(previewEnd + 2),
		});
	}
	for (const language of ["EN", "FR"]) {
		if (parsed[language].some((step, index) => step.position !== index + 1 || step.delayDays !== DELAYS[index])) {
			throw new Error(`${language} positions or delays do not match 0/3/7.`);
		}
	}
	return parsed;
}

const contentHash = (steps) => createHash("sha256").update(JSON.stringify(steps)).digest("hex");
const pick = ({ position, delayDays, delayFromEnrollmentMs, useWelcome, subject, previewText, markdown }) => ({
	position,
	delayDays,
	delayFromEnrollmentMs,
	useWelcome,
	subject,
	previewText,
	markdown,
});

async function main() {
	const args = readArgs(process.argv.slice(2));
	const bytes = await readFile(args.source);
	const sourceSha256 = createHash("sha256").update(bytes).digest("hex");
	if (sourceSha256 !== EXPECTED_SHA256) fail(`source SHA-256 is ${sourceSha256}, the accepted file's is ${EXPECTED_SHA256}. Nothing written.`);
	const accepted = parseAcceptedSeries(bytes.toString("utf8"));
	const receipt = { mode: args.write ? "write" : "dry-run", sourceSha256, sourceBytes: bytes.length, account: args.account, newsletter: args.newsletter, sequences: [] };

	if (!args.write) {
		for (const language of ["EN", "FR"]) {
			receipt.sequences.push({ slug: `welcome-${language.toLowerCase()}`, status: "draft", steps: accepted[language].length, contentSha256: contentHash(accepted[language]) });
		}
		console.log(JSON.stringify(receipt));
		return;
	}
	if (!process.env.MONGODB_URI) fail("--write needs MONGODB_URI.");
	const { default: mongoose } = await import("mongoose");
	const { default: Newsletter } = await import("../models/Newsletter.js");
	const { default: Sequence } = await import("../models/Sequence.js");
	await mongoose.connect(process.env.MONGODB_URI);
	try {
		const accountId = new mongoose.Types.ObjectId(args.account);
		const newsletter = await Newsletter.findOne({ accountId, slug: args.newsletter }).select({ _id: 1 }).lean();
		if (!newsletter) fail(`newsletter ${args.newsletter} was not found in account ${args.account}. Nothing written.`);
		for (const language of ["EN", "FR"]) {
			const slug = `welcome-${language.toLowerCase()}`;
			const sequence = await Sequence.findOneAndUpdate(
				{ accountId, newsletterId: newsletter._id, slug },
				{ $set: { name: NAMES[language], status: "draft", pauseReason: PAUSE_REASON, steps: accepted[language] }, $setOnInsert: { accountId, newsletterId: newsletter._id, slug } },
				{ upsert: true, returnDocument: "after", runValidators: true }
			).lean();
			const loaded = sequence.steps.map(pick);
			if (JSON.stringify(loaded) !== JSON.stringify(accepted[language])) throw new Error(`Loaded ${slug} fields do not exactly match the accepted source.`);
			receipt.sequences.push({ slug, id: String(sequence._id), status: sequence.status, steps: loaded.length, contentSha256: contentHash(loaded) });
		}
		console.log(JSON.stringify(receipt));
	} finally {
		await mongoose.disconnect();
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
