// maiteam (PATCHES.md P3c): proves the email-look port renders what the old fork rendered, and that emails without a
// look render as upstream did before the port.
//
//   node tests/runners/maiteam-look-equivalence.mjs [--old-repo <path>] [--write-fixture]
//
// It extracts the old fork's renderer (lib/ at 7bdd14c, from --old-repo, default ../mailcheap-brand-correction) and
// this repository's lib/ before the port (e0842e7) into a temporary directory with this checkout's node_modules
// linked, renders every case of tests/helpers/maiteam-look-cases.mjs through them and through the port, and prints a
// JSON report. --write-fixture records the old outputs' hashes in tests/fixtures/maiteam-look-equivalence.json, which
// tests/maiteam-email-look.test.mjs checks the port against without needing the old repository. Reads nothing else
// and touches no network.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { NEWSLETTER, listCases, listDefaultCases, listUpstreamCases, newArguments, oldArguments } from "../helpers/maiteam-look-cases.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const OLD_COMMIT = "7bdd14c";
const BASE_COMMIT = "e0842e7";
const OLD_FILES = ["lib/email-theme.js", "lib/render-email.js", "lib/callouts.js", "lib/clean-html.js", "lib/markdown.js"];
const FIXTURE = join(ROOT, "tests/fixtures/maiteam-look-equivalence.json");

const args = process.argv.slice(2);
const oldRepo = resolve(ROOT, args.includes("--old-repo") ? args[args.indexOf("--old-repo") + 1] : "../mailcheap-brand-correction");
const shouldWriteFixture = args.includes("--write-fixture");

function extract(repo, commit, paths, into) {
	mkdirSync(into, { recursive: true });
	const archive = execFileSync("git", ["-C", repo, "archive", "--format=tar", commit, ...paths], { maxBuffer: 64 * 1024 * 1024 });
	execFileSync("tar", ["-x", "-C", into], { input: archive });
	writeFileSync(join(into, "package.json"), JSON.stringify({ type: "module" }));
	symlinkSync(join(ROOT, "node_modules"), join(into, "node_modules"), "dir");
	return into;
}

function sha256(value) {
	return createHash("sha256").update(value).digest("hex");
}

// Where two outputs part, with a little of each around it.
function firstDifference(a, b) {
	let index = 0;
	while (index < a.length && index < b.length && a[index] === b[index]) index += 1;
	return { index, old: a.slice(Math.max(0, index - 40), index + 80), new: b.slice(Math.max(0, index - 40), index + 80) };
}

function compare(id, before, after) {
	const html = before.html === after.html;
	const text = before.text === after.text;
	return { id, identical: html && text, html, text, ...(!html && { htmlDifference: firstDifference(before.html, after.html) }), ...(!text && { textDifference: firstDifference(before.text, after.text) }) };
}

const scratch = mkdtempSync(join(tmpdir(), "maiteam-look-equivalence-"));
try {
	const oldDir = extract(oldRepo, OLD_COMMIT, OLD_FILES, join(scratch, "old"));
	const baseDir = extract(ROOT, BASE_COMMIT, ["lib"], join(scratch, "base"));
	const oldRender = (await import(pathToFileURL(join(oldDir, "lib/render-email.js")).href)).renderEmail;
	const baseRender = (await import(pathToFileURL(join(baseDir, "lib/render-email.js")).href)).renderEmail;
	const newRender = (await import(pathToFileURL(join(ROOT, "lib/render-email.js")).href)).renderEmail;

	const lookResults = listCases().map((testCase) => {
		const before = oldRender(oldArguments(testCase));
		const after = newRender(newArguments(testCase));
		return { ...compare(testCase.id, before, after), hashes: { html: sha256(before.html), text: sha256(before.text) } };
	});

	// The default look is upstream's own email, plus the old default's ink fill on a <a data-button>: compared with the
	// old fork's default wrapper, and with upstream's email without a look (equal unless the email has a marked button).
	const defaultResults = listDefaultCases().map((testCase) => {
		const { previewScheme, ...upstreamInput } = testCase.input;
		const after = newRender(newArguments(testCase));
		const upstream = baseRender({ ...upstreamInput, newsletter: NEWSLETTER });
		const before = oldRender(oldArguments(testCase));
		return {
			...compare(testCase.id, before, after),
			equalsUpstreamWithoutLook: after.html === upstream.html && after.text === upstream.text,
			hashes: { html: sha256(before.html), text: sha256(before.text) },
		};
	});
	const defaultLook = {
		cases: defaultResults.length,
		equalToUpstreamWithoutLook: defaultResults.filter((result) => result.equalsUpstreamWithoutLook).map(({ id }) => id),
		identicalToOldDefault: defaultResults.filter((result) => result.identical).length,
		differentFromOldDefault: defaultResults.filter((result) => !result.identical).map(({ hashes, ...result }) => result),
	};

	const upstreamResults = listUpstreamCases().map(({ id, input }) => {
		const before = baseRender(input);
		const after = newRender(input);
		return { ...compare(id, before, after), hashes: { html: sha256(before.html), text: sha256(before.text) } };
	});

	const summarize = (results) => ({
		cases: results.length,
		identical: results.filter((result) => result.identical).length,
		different: results.filter((result) => !result.identical).map(({ hashes, ...result }) => result),
	});
	const report = {
		oldFork: { commit: OLD_COMMIT, ...summarize(lookResults) },
		defaultLook,
		upstreamWithoutLook: { commit: BASE_COMMIT, ...summarize(upstreamResults) },
	};
	if (shouldWriteFixture) {
		mkdirSync(join(ROOT, "tests/fixtures"), { recursive: true });
		const fixture = {
			about: `sha256 of the old fork's output (${OLD_COMMIT}) per look case and of upstream's (${BASE_COMMIT}) per case without a look; written by tests/runners/maiteam-look-equivalence.mjs --write-fixture`,
			looks: Object.fromEntries([...lookResults, ...defaultResults].map(({ id, hashes }) => [id, hashes])),
			upstream: Object.fromEntries(upstreamResults.map(({ id, hashes }) => [id, hashes])),
		};
		writeFileSync(FIXTURE, `${JSON.stringify(fixture, null, "\t")}\n`);
		report.fixture = "tests/fixtures/maiteam-look-equivalence.json";
	}
	console.log(JSON.stringify(report, null, 2));
	const failed = report.oldFork.different.length > 0 || report.upstreamWithoutLook.different.length > 0 || defaultLook.differentFromOldDefault.length > 0;
	process.exitCode = failed ? 1 : 0;
} finally {
	rmSync(scratch, { recursive: true, force: true });
}
