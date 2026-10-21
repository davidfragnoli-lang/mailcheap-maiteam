import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import mongoose from "mongoose";
import { catchUp } from "../scripts/maiteam/catch-up.mjs";
import { checkDumpStart } from "../scripts/maiteam/dump-start.mjs";
import { migrateFork } from "../scripts/maiteam/migrate-from-fork.mjs";
import { startTestApp } from "./helpers/app.mjs";

// P8f (PATCHES.md), QA r3 (FRA-25999): the cutover boundary is the dump's recorded start. mongodump reads each document
// once, so one the old server changes while the dump runs can be in the archive as it was before. The catch-up finds it
// only if it looks back to the start; the archive's file time (the end, or a later copy) skips it. QA's probe: an old
// contact edited during the dump, converged and released with the edit missing.
let app;
let client;
const id = () => new mongoose.Types.ObjectId();
const script = path.resolve("scripts/maiteam/rehearse-migration.sh");

before(async () => {
	app = await startTestApp();
	client = mongoose.connection.getClient();
});

after(() => app?.stop());

// The old server's database, the archive's snapshot of it (read before the edit) and a fresh target. The edit lands
// 2 s into a 5 s dump; the archive was finished at the end.
async function duringDump(prefix) {
	const live = client.db(`${prefix}-live`);
	const snapshot = client.db(`${prefix}-snapshot`);
	const target = client.db(`${prefix}-new`);
	const start = new Date(Math.floor(Date.now() / 1000) * 1000 - 60_000);
	const end = new Date(start.getTime() + 5000);
	const before = new Date(start.getTime() - DAY);
	// Ids from before the dump, as a real old contact has: the catch-up's id-time lookback must not be what finds it.
	const newsletterId = mongoose.Types.ObjectId.createFromTime(before.getTime() / 1000);
	const contactId = mongoose.Types.ObjectId.createFromTime(before.getTime() / 1000 + 1);
	const newsletter = { _id: newsletterId, name: "QA", slug: prefix, fromEmail: "qa@example.invalid", createdAt: before, updatedAt: before };
	const contact = { _id: contactId, newsletterId, email: "reader@example.invalid", status: "active", createdAt: before, updatedAt: before };
	for (const db of [live, snapshot]) {
		await db.collection("newsletters").insertOne({ ...newsletter });
		await db.collection("contacts").insertOne({ ...contact });
	}
	await live.collection("contacts").updateOne({ _id: contactId }, { $set: { status: "unsubscribed", unsubscribedAt: new Date(start.getTime() + 2000), updatedAt: new Date(start.getTime() + 2000) } });
	return { live, snapshot, target, contactId, start, end };
}
const DAY = 86_400_000;

test("a write made while the dump ran reaches the new server when the boundary is the recorded start", async () => {
	const { live, snapshot, target, contactId, start, end } = await duringDump("dump-start");
	const dumpedAt = checkDumpStart(start.toISOString().replace(".000Z", "Z"), { archiveWrittenAt: end });
	const migration = await migrateFork({ sourceDb: snapshot, targetDb: target, owner: { email: "owner@example.invalid" }, dumpedAt, execute: true });
	assert.equal(migration.checks.ok, true, JSON.stringify(migration.checks));
	assert.equal(migration.dumpedAt, start.toISOString(), "the report carries the boundary");
	assert.equal((await target.collection("contacts").findOne({ _id: contactId })).status, "active", "the archive holds the contact as read before the edit");

	const report = await catchUp({ sourceDb: live, targetDb: target, execute: true, release: true, quietMs: 0 });
	assert.equal(report.since, start.toISOString());
	assert.equal(report.converged, true);
	assert.equal(report.checks.ok, true);
	assert.ok(report.released);
	const contact = await target.collection("contacts").findOne({ _id: contactId });
	assert.equal(contact.status, "unsubscribed", "the during-dump unsubscribe survives the catch-up");
});

test("the fault it closes: with the archive's file time as the boundary, the same edit is skipped and the catch-up still converges", async () => {
	const { live, snapshot, target, contactId, end } = await duringDump("dump-end");
	await migrateFork({ sourceDb: snapshot, targetDb: target, owner: { email: "owner@example.invalid" }, dumpedAt: end, execute: true });
	const report = await catchUp({ sourceDb: live, targetDb: target, execute: true, quietMs: 0 });
	assert.equal(report.converged, true);
	assert.equal((await target.collection("contacts").findOne({ _id: contactId })).status, "active", "why the start is required and the file time is refused");
});

test("the start is required, in UTC, a real time, not in the future and not after the archive was written", () => {
	const written = new Date("2026-10-21T06:21:40Z");
	assert.equal(checkDumpStart("2026-10-21T06:21:39Z", { archiveWrittenAt: written }).toISOString(), "2026-10-21T06:21:39.000Z");
	for (const bad of [undefined, "", "2026-10-21 06:21:39", "2026-10-21T08:21:39+02:00", "1761027699", "2026-02-30T06:21:39Z", "2026-10-21T24:00:01Z"]) {
		assert.throws(() => checkDumpStart(bad, { archiveWrittenAt: written }), /dumped-at/, String(bad));
	}
	assert.throws(() => checkDumpStart("2026-10-21T06:21:41Z", { archiveWrittenAt: written }), /after the archive was written/);
	assert.throws(() => checkDumpStart("2999-01-01T00:00:00Z"), /in the future/);
});

test("the rehearsal wrapper refuses to run without a valid recorded start, before it starts a container", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dump-start-"));
	const archive = path.join(dir, "dump.archive.gz");
	fs.writeFileSync(archive, "");
	const written = new Date("2026-10-21T06:22:00Z");
	fs.utimesSync(archive, written, written);
	const common = ["--dump", archive, "--source-db", "mailcheap", "--owner-email", "owner@example.invalid", "--out", path.join(dir, "out")];
	const run = (...extra) => spawnSync("/bin/zsh", [script, ...common, ...extra], { encoding: "utf8", env: { ...process.env, PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin` } });
	for (const [extra, message] of [
		[[], /--dumped-at <ISO start, UTC>/],
		[["--dumped-at", "2026-10-21 06:21:39"], /ISO time in UTC/],
		[["--dumped-at", "2026-10-21T06:23:00Z"], /after the archive was written/],
	]) {
		const result = run(...extra);
		assert.equal(result.status, 2, result.stderr);
		assert.match(result.stderr, message);
		assert.equal(fs.existsSync(path.join(dir, "out")), false, "nothing set up");
	}
	fs.rmSync(dir, { recursive: true, force: true });
});
