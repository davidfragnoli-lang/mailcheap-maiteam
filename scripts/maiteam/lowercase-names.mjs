// P2 (PATCHES.md): product names in lowercase wherever a person sees them (David, 20 Oct 2026, FRA-25997).
//
//   node scripts/maiteam/lowercase-names.mjs          rewrite in place
//   node scripts/maiteam/lowercase-names.mjs --check  exit 1 if anything is left to rewrite
//
// The weekly upstream sync runs this after each merge instead of carrying ~170 hand-edited lines, so a merge never
// conflicts on a name. Only whole words in code and text are changed: comment lines, identifiers (isMailCheapX,
// MAILCHEAP_*), env names, URLs and hosts (mailcheap.ai) are left alone because they are already lowercase or are
// not words. Idempotent.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const DIRS = ["app", "components", "lib", "tests", "public"];
const ROOT_FILES = ["instrumentation.js", "proxy.js", "next.config.mjs"];
const EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".md", ".txt", ".json", ".webmanifest"]);
const SKIP = new Set(["node_modules", ".next", "fonts"]);
// Whole word only: \b on both sides keeps identifiers like isMailCheapUser or MailCheapLogo as they are.
const NAMES = [[/\bMailCheap\b/g, "mailcheap"], [/\bMailcheap\b/g, "mailcheap"], [/\bMAILCHEAP\b(?![_A-Z])/g, "mailcheap"]];
const COMMENT = /^\s*(\/\/|\*|\/\*)/;

function* files(dir) {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		if (SKIP.has(entry.name)) continue;
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) yield* files(full);
		else if (EXTENSIONS.has(path.extname(entry.name))) yield full;
	}
}

function rewrite(text, isCode) {
	return text
		.split("\n")
		.map((line) => {
			if (isCode && COMMENT.test(line)) return line;
			// MAILCHEAP as a whole word in env-style names (MAILCHEAP_CLOUD) is excluded by the lookahead.
			return NAMES.reduce((out, [pattern, to]) => out.replace(pattern, to), line);
		})
		.join("\n");
}

const check = process.argv.includes("--check");
const changed = [];
const targets = [
	...DIRS.flatMap((dir) => (fs.existsSync(path.join(ROOT, dir)) ? [...files(path.join(ROOT, dir))] : [])),
	...ROOT_FILES.map((name) => path.join(ROOT, name)).filter((file) => fs.existsSync(file)),
];
{
	for (const file of targets) {
		const before = fs.readFileSync(file, "utf8");
		const after = rewrite(before, /\.(m?js|jsx)$/.test(file));
		if (after === before) continue;
		changed.push(path.relative(ROOT, file));
		if (!check) fs.writeFileSync(file, after);
	}
}
console.log(JSON.stringify({ mode: check ? "check" : "write", files: changed.length, changed }));
if (check && changed.length) process.exit(1);
