import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import http from "node:http";
import { after, before, beforeEach, test } from "node:test";
import { promisify } from "node:util";

// QA r1 item 6 (FRA-25999): the weekly sync's promotion and rollback (scripts/maiteam/vercel-release.zsh) against a
// local stand-in for Vercel's API. A request that fails, or a READY deployment the production hostname doesn't serve,
// never counts as promoted or rolled back. No network: the API base points at this process.
const run = promisify(execFile);
const LIBRARY = new URL("../scripts/maiteam/vercel-release.zsh", import.meta.url).pathname;
const HOST = "mailcheap.example.test";
const OLD_SHA = "a".repeat(40);
const NEW_SHA = "b".repeat(40);
let server;
let api;
let vercel;
const calls = [];

function reset() {
	vercel = {
		production: "dpl_old",
		deployments: {
			dpl_old: { uid: "dpl_old", readyState: "READY", meta: { githubCommitSha: OLD_SHA }, url: "old.example.test" },
			dpl_new: { uid: "dpl_new", readyState: "READY", meta: { githubCommitSha: NEW_SHA }, url: "new.example.test", target: "production" },
		},
		alias: "dpl_old",
		rollbackStatus: 201,
		rollbackMovesAlias: true,
		health: 200,
	};
	calls.length = 0;
}

before(async () => {
	server = http.createServer((request, response) => {
		const url = new URL(request.url, "http://local");
		calls.push(`${request.method} ${url.pathname}`);
		const send = (status, body) => {
			response.writeHead(status, { "content-type": "application/json" });
			response.end(JSON.stringify(body));
		};
		if (url.pathname === "/api/health") return send(vercel.health, { ok: vercel.health === 200 });
		if (request.headers.authorization !== "Bearer test-token" || url.searchParams.get("teamId") !== "team_test") return send(403, { error: { code: "forbidden" } });
		if (url.pathname === "/v9/projects/prj_test") return send(200, vercel.production ? { targets: { production: { id: vercel.production } } } : { targets: {} });
		if (url.pathname.startsWith("/v13/deployments/")) {
			const deployment = vercel.deployments[url.pathname.split("/").at(-1)];
			return deployment ? send(200, deployment) : send(404, { error: { code: "not_found" } });
		}
		if (url.pathname === `/v4/aliases/${HOST}`) return send(200, { alias: HOST, deploymentId: vercel.alias });
		if (url.pathname === "/v6/deployments") {
			const target = url.searchParams.get("target");
			return send(200, { deployments: Object.values(vercel.deployments).filter((item) => (item.target ?? "production") === target).map(({ uid, readyState, meta }) => ({ uid, state: readyState, meta })) });
		}
		if (request.method === "POST" && url.pathname.startsWith("/v9/projects/prj_test/rollback/")) {
			if (vercel.rollbackStatus < 300 && vercel.rollbackMovesAlias) vercel.alias = url.pathname.split("/").at(-1);
			return send(vercel.rollbackStatus, vercel.rollbackStatus < 300 ? {} : { error: { code: "FORBIDDEN" } });
		}
		return send(404, {});
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	api = `http://127.0.0.1:${server.address().port}`;
});

after(() => server?.close());
beforeEach(reset);

async function zsh(body) {
	const script = `source ${JSON.stringify(LIBRARY)}\n${body}\nprint -r -- "PROBLEM=$RELEASE_PROBLEM"`;
	const env = { PATH: process.env.PATH, HOME: process.env.HOME, VERCEL_API: api, VERCEL_TOKEN: "test-token", VERCEL_TEAM_ID: "team_test", VERCEL_PROJECT_ID: "prj_test", RELEASE_POLLS: "3", RELEASE_SLEEP: "0" };
	const { stdout } = await run("/bin/zsh", ["-f", "-c", script], { env });
	return stdout.trim();
}

test("promotion needs a READY rollback target built from the deployed commit and served by the hostname", async () => {
	assert.match(await zsh(`release_preflight ${OLD_SHA} ${HOST} && print OK $PREVIOUS`), /^OK dpl_old/m);

	vercel.production = null;
	assert.match(await zsh(`release_preflight ${OLD_SHA} ${HOST} || print STOP`), /STOP\nPROBLEM=the project has no production deployment/);
	reset();
	vercel.deployments.dpl_old.readyState = "ERROR";
	assert.match(await zsh(`release_preflight ${OLD_SHA} ${HOST} || print STOP`), /STOP\nPROBLEM=rollback target dpl_old is ERROR/);
	reset();
	assert.match(await zsh(`release_preflight ${NEW_SHA} ${HOST} || print STOP`), /STOP\nPROBLEM=production serves aaaaaaa, the deployed branch is at bbbbbbb/);
	reset();
	vercel.alias = "dpl_other";
	assert.match(await zsh(`release_preflight ${OLD_SHA} ${HOST} || print STOP`), /STOP\nPROBLEM=mailcheap.example.test points at dpl_other/);
	assert.match(await zsh(`VERCEL_TOKEN=wrong; release_preflight ${OLD_SHA} ${HOST} || print STOP`), /STOP\nPROBLEM=GET \/v9\/projects\/prj_test answered 403/);
});

test("a READY production deployment the hostname doesn't serve is not promoted", async () => {
	assert.match(await zsh(`await_deployment ${NEW_SHA} production && await_serving ${HOST} $DEPLOYMENT_ID ${api} || print NOT-PROMOTED`), /NOT-PROMOTED\nPROBLEM=mailcheap.example.test does not serve dpl_new healthily \(alias reads dpl_old\)/);
	vercel.alias = "dpl_new";
	vercel.health = 500;
	assert.match(await zsh(`await_deployment ${NEW_SHA} production && await_serving ${HOST} $DEPLOYMENT_ID ${api} || print NOT-PROMOTED`), /NOT-PROMOTED/);
	vercel.health = 200;
	assert.match(await zsh(`await_deployment ${NEW_SHA} production && await_serving ${HOST} $DEPLOYMENT_ID ${api} && print PROMOTED`), /PROMOTED/);
});

test("a rollback counts only after the hostname reads back to the previous deployment and answers healthily", async () => {
	vercel.alias = "dpl_new";
	vercel.rollbackStatus = 403;
	assert.match(await zsh(`rollback_to dpl_old ${HOST} ${api} && print ROLLED-BACK || print ROLLBACK-FAILED`), /ROLLBACK-FAILED\nPROBLEM=POST \/v9\/projects\/prj_test\/rollback\/dpl_old answered 403/);
	assert.equal(vercel.alias, "dpl_new");

	vercel.rollbackStatus = 201;
	vercel.rollbackMovesAlias = false;
	assert.match(await zsh(`rollback_to dpl_old ${HOST} ${api} && print ROLLED-BACK || print ROLLBACK-FAILED`), /ROLLBACK-FAILED\nPROBLEM=mailcheap.example.test does not serve dpl_old healthily \(alias reads dpl_new\)/);

	vercel.rollbackMovesAlias = true;
	assert.match(await zsh(`rollback_to dpl_old ${HOST} ${api} && print ROLLED-BACK || print ROLLBACK-FAILED`), /^ROLLED-BACK/m);
	assert.equal(vercel.alias, "dpl_old");
});

test("the sync prints ROLLED BACK only from a verified rollback, and stops before pushing without a rollback target", () => {
	const script = readFileSync(new URL("../scripts/maiteam/weekly-upstream-sync.sh", import.meta.url), "utf8");
	const rolledBack = script.split("\n").filter((line) => line.includes("ROLLED BACK") && !line.trim().startsWith("#"));
	assert.equal(rolledBack.length, 1);
	assert.match(script, /if rollback_to "\$PREVIOUS"[^\n]*; then\n\tfinish "ROLLED BACK/);
	assert.ok(script.indexOf("release_preflight") < script.indexOf('git push --quiet origin "$SYNC"'), "the rollback target is verified before anything is pushed");
	assert.match(script, /finish "ROLLBACK FAILED[^\n]*" 2/);
});

test("the routine step is off until its mode file says otherwise, and passes on the sync's line and exit code", async () => {
	const { mkdtemp, writeFile } = await import("node:fs/promises");
	const { tmpdir } = await import("node:os");
	const dir = await mkdtemp(`${tmpdir()}/mailcheap-step-`);
	const step = new URL("../scripts/maiteam/weekly-routine-step.sh", import.meta.url).pathname;
	const fake = `${dir}/sync.sh`;
	await writeFile(fake, 'print -r -- "noise"\nprint -r -- "mailcheap: ROLLED BACK abc1234 (x); verified"\nprint -r -- "args $*" >&2\nexit 1\n');
	const env = { PATH: process.env.PATH, HOME: dir, MAILCHEAP_SYNC_SCRIPT: fake, MAILCHEAP_SYNC_CONFIG: `${dir}/none`, MAILCHEAP_SHARED_ENV: `${dir}/none` };
	const call = (file) => run("/bin/zsh", [step, "--mode-file", file], { env }).then(({ stdout }) => ({ code: 0, line: stdout.trim() }), (error) => ({ code: error.code, line: error.stdout.trim() }));
	assert.deepEqual(await call(`${dir}/missing`), { code: 0, line: "off (release gates pending)" });
	await writeFile(`${dir}/mode`, "off\n");
	assert.deepEqual(await call(`${dir}/mode`), { code: 0, line: "off (release gates pending)" });
	await writeFile(`${dir}/mode`, "promote\n");
	assert.deepEqual(await call(`${dir}/mode`), { code: 1, line: "ROLLED BACK abc1234 (x); verified" });
	await writeFile(`${dir}/mode`, "yolo\n");
	assert.equal((await call(`${dir}/mode`)).code, 1);
});
