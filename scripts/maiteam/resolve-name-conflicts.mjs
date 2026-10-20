// During the weekly sync's merge (scripts/maiteam/weekly-upstream-sync.sh): a file whose only local change is P2's
// lowercase names takes upstream's version, and the sync re-runs lowercase-names.mjs on it afterwards. Any other
// conflict is left as it is, and the sync stops. Prints what it resolved and what is left.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { isCodeFile, rewrite } from "./lowercase-names.mjs";

const git = (...args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const stage = (number, file) => {
	try {
		return git("show", `:${number}:${file}`);
	} catch {
		return null;
	}
};

const conflicted = git("diff", "--name-only", "--diff-filter=U").split("\n").filter(Boolean);
const resolved = [];
const left = [];
for (const file of conflicted) {
	const [base, ours, theirs] = [1, 2, 3].map((number) => stage(number, file));
	if (base !== null && ours !== null && theirs !== null && rewrite(base, isCodeFile(file)) === ours) {
		fs.writeFileSync(file, theirs);
		git("add", "--", file);
		resolved.push(file);
	} else left.push(file);
}
console.log(JSON.stringify({ resolved, left }));
process.exit(left.length ? 1 : 0);
