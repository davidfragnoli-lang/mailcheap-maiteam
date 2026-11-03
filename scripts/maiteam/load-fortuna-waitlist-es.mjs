// maiteam (PATCHES.md P6, QI-27854 gate 4): sets up the newsletter `fortuna-waitlist-es` and its draft sequence
// `welcome` from the locked es-ES copy, through mailcheap's own REST API, so every check of the dashboard and MCP runs.
//
//   node scripts/maiteam/load-fortuna-waitlist-es.mjs --spec <private spec.json>
//   ... --write   also needs MAILCHEAP_API_URL (like https://mail.example.com) and MAILCHEAP_API_KEY (a full key)
//
// The spec holds what David decided and what stays out of this repository: { fromName, fromEmail, replyTo,
// postalAddress }. The copy is fixtures/maifortune-welcome/copy.maiteam.es.json, pinned by hash. Without --write
// nothing connects anywhere and the receipt says what would be saved. With --write it creates the newsletter or
// updates it, creates the sequence as a draft or updates it while it's still a draft, reads both back, refuses
// unless every field matches, and prints a receipt of hashes (never the address). Nothing is sent: the waitlist
// webhook stays off until its product and secret are bound, and start_sequence is a separate, explicit step.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import process from "node:process";
import { pathToFileURL } from "node:url";

export const COPY_SHA256 = "ca59626e1befe16fafd5707cbce723a27ac51db4fd7b82121d291ffeafc2573e";
const COPY_URL = new URL("../../fixtures/maifortune-welcome/copy.maiteam.es.json", import.meta.url);
const SLUG = "fortuna-waitlist-es";
const SEQUENCE = { name: "fortuna bienvenida", slug: "welcome" };
const SPEC_FIELDS = ["fromName", "fromEmail", "replyTo", "postalAddress"];
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

export function readSpec(spec) {
	const extra = Object.keys(spec).filter((key) => !SPEC_FIELDS.includes(key));
	if (extra.length) throw new Error(`spec has unknown fields: ${extra.join(", ")}`);
	for (const key of SPEC_FIELDS) if (typeof spec[key] !== "string" || !spec[key].trim()) throw new Error(`spec needs ${key}`);
	for (const key of ["fromEmail", "replyTo"]) if (!EMAIL.test(spec[key])) throw new Error(`spec ${key} is not an email address`);
	return spec;
}

// What the newsletter and the sequence must hold once loaded.
export function planRecord(spec, copy) {
	if (copy.language !== "es") throw new Error("the copy is not the es-ES series");
	const { subject, previewText, markdown } = copy.confirmation;
	return {
		newsletter: {
			name: "fortuna",
			slug: SLUG,
			...spec,
			language: "es",
			requireConfirmation: true,
			welcome: { enabled: false },
			confirmation: { subject, previewText, markdown },
			theme: { preset: "fortuna" },
		},
		sequence: { ...SEQUENCE, status: "draft", steps: copy.steps.map(({ delayDays, subject, previewText, markdown }) => ({ delayDays, subject, previewText, markdown })) },
	};
}

function check(ok, message) {
	if (!ok) throw new Error(`read back: ${message}`);
}

function expectStatus(response, statuses, what) {
	if (!statuses.includes(response.status)) throw new Error(`${what} answered ${response.status}: ${JSON.stringify(response.body?.error ?? response.body)}`);
	return response.body;
}

// `api(method, path, body)` answers { status, body } from /api/v1.
export async function loadRecord({ api, plan }) {
	const list = expectStatus(await api("GET", "/newsletters"), [200], "list_newsletters");
	const existing = (list.data ?? list.newsletters ?? list).find?.((newsletter) => newsletter.slug === SLUG);
	const saved = existing
		? expectStatus(await api("PATCH", `/newsletters/${existing.id}`, plan.newsletter), [200], "update_newsletter")
		: expectStatus(await api("POST", "/newsletters", plan.newsletter), [201], "create_newsletter");
	const newsletter = expectStatus(await api("GET", `/newsletters/${saved.id}`), [200], "get_newsletter");
	for (const key of ["name", "slug", ...SPEC_FIELDS, "language", "requireConfirmation"]) {
		check(newsletter[key] === plan.newsletter[key], `newsletter ${key}`);
	}
	check(newsletter.welcome.enabled === false, "the welcome email is off");
	check(newsletter.theme.preset === "fortuna", "the fortuna look");
	// Upstream 40244c9 answers an email as { format, content } (lib/newsletter-emails.js toDraftEmail); it still takes markdown.
	for (const key of ["subject", "previewText"]) check(newsletter.confirmation[key] === plan.newsletter.confirmation[key], `confirmation ${key}`);
	check(newsletter.confirmation.format === "markdown" && newsletter.confirmation.content === plan.newsletter.confirmation.markdown, "confirmation markdown");
	check(newsletter.confirmation.isCustom, "the confirmation email is the locked copy");

	const sequences = expectStatus(await api("GET", `/sequences?newsletter=${encodeURIComponent(newsletter.id)}`), [200], "list_sequences");
	const current = (sequences.data ?? sequences.sequences ?? sequences).find?.((sequence) => sequence.slug === SEQUENCE.slug);
	if (current && current.status !== "draft") throw new Error(`sequence ${SEQUENCE.slug} is ${current.status}, not a draft: nothing changed on it`);
	const sequenceId = current
		? expectStatus(await api("PATCH", `/sequences/${current.id}`, plan.sequence), [200], "update_sequence").id
		: expectStatus(await api("POST", "/sequences", { newsletter: newsletter.id, ...plan.sequence }), [201], "create_sequence").id;
	const sequence = expectStatus(await api("GET", `/sequences/${sequenceId}`), [200], "get_sequence");
	check(sequence.newsletterId === newsletter.id && sequence.status === "draft", "a draft on the newsletter");
	check(sequence.steps.length === plan.sequence.steps.length, "step count");
	plan.sequence.steps.forEach((step, index) => {
		for (const key of Object.keys(step)) check(sequence.steps[index][key] === step[key], `step ${index + 1} ${key}`);
	});
	return { newsletterId: newsletter.id, created: !existing, sequenceId, sequenceCreated: !current };
}

export function receiptOf(plan) {
	const { postalAddress, ...newsletter } = plan.newsletter;
	return {
		newsletter: { ...newsletter, confirmation: { subject: newsletter.confirmation.subject, markdownSha256: sha256(newsletter.confirmation.markdown) }, postalAddressSha256: sha256(postalAddress) },
		sequence: { ...plan.sequence, steps: plan.sequence.steps.map(({ delayDays, subject, markdown }) => ({ delayDays, subject, markdownSha256: sha256(markdown) })) },
	};
}

function readArgs(argv) {
	const args = { write: false };
	for (let index = 0; index < argv.length; index++) {
		if (argv[index] === "--write") args.write = true;
		else if (argv[index] === "--spec" && argv[index + 1]) args.spec = argv[++index];
		else throw new Error(`unknown or incomplete argument ${argv[index]}`);
	}
	if (!args.spec) throw new Error("Usage: node scripts/maiteam/load-fortuna-waitlist-es.mjs --spec <spec.json> [--write]");
	return args;
}

async function main() {
	const args = readArgs(process.argv.slice(2));
	const bytes = await readFile(COPY_URL);
	if (sha256(bytes) !== COPY_SHA256) throw new Error(`the copy is ${sha256(bytes)}, pinned ${COPY_SHA256}. Nothing written.`);
	const plan = planRecord(readSpec(JSON.parse(await readFile(args.spec, "utf8"))), JSON.parse(bytes));
	const receipt = { mode: args.write ? "write" : "dry-run", copySha256: COPY_SHA256, ...receiptOf(plan) };
	if (args.write) {
		const { MAILCHEAP_API_URL: base, MAILCHEAP_API_KEY: key } = process.env;
		if (!base || !key) throw new Error("--write needs MAILCHEAP_API_URL and MAILCHEAP_API_KEY.");
		const api = async (method, path, body) => {
			const response = await fetch(new URL(`/api/v1${path}`, base), {
				method,
				headers: { authorization: `Bearer ${key}`, ...(body && { "content-type": "application/json" }) },
				body: body && JSON.stringify(body),
			});
			return { status: response.status, body: await response.json().catch(() => null) };
		};
		receipt.loaded = await loadRecord({ api, plan });
	}
	console.log(JSON.stringify(receipt));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	await main().catch((error) => {
		console.error(`STOP: ${error.message}`);
		process.exit(1);
	});
}
