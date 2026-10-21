// P8f (PATCHES.md), QA r3 (FRA-25999): the dump's recorded start is the boundary of the cutover. A document the old
// server changes while mongodump runs may be in the archive as it was before the change, so the catch-up must look back
// to the moment the dump began. A file's modification time is when the dump ended, or later if it was copied or touched:
// never infer the start from it.
//
//   node scripts/maiteam/dump-start.mjs <ISO start, UTC> <archive>   prints the start, normalised, or exits 2
import fs from "node:fs";

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

export function checkDumpStart(value, { archiveWrittenAt, now = new Date() } = {}) {
	if (typeof value !== "string" || !ISO_UTC.test(value)) throw new Error("--dumped-at must be the recorded start of the dump, as an ISO time in UTC (2026-10-21T06:21:39Z)");
	const start = new Date(value);
	// Date rolls 30 February over into March; reading the same calendar time back refuses it.
	if (!Number.isFinite(start.getTime()) || start.toISOString().slice(0, 19) !== value.slice(0, 19)) throw new Error(`--dumped-at ${value} is not a real time`);
	if (start > now) throw new Error(`--dumped-at ${value} is in the future`);
	// The dump began before its archive was finished; a later start is a typo or the end time.
	if (archiveWrittenAt && start > archiveWrittenAt) throw new Error(`--dumped-at ${value} is after the archive was written (${archiveWrittenAt.toISOString()}): give the start of the dump, not its end`);
	return start;
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
	const [value, archive] = process.argv.slice(2);
	try {
		const archiveWrittenAt = archive ? fs.statSync(archive).mtime : undefined;
		process.stdout.write(`${checkDumpStart(value, { archiveWrittenAt }).toISOString()}\n`);
	} catch (error) {
		process.stderr.write(`${error.message}\n`);
		process.exitCode = 2;
	}
}
