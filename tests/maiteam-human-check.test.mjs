import assert from "node:assert/strict";
import { test } from "node:test";
import {
	MIN_FILL_MS,
	SITEVERIFY_URL,
	checkFormStamp,
	isHoneypotFilled,
	isTestSecret,
	issueFormStamp,
	readTurnstileConfig,
	verifyTurnstile,
} from "../lib/maiteam/human-check.js";

const SECRET = "synthetic-turnstile-secret";
const BASE = { token: "token-1", secret: SECRET, hostnames: ["mailcheap.maiteam.ch"], action: "archive-signup" };

function siteverify(answer, calls = []) {
	return async (url, init) => {
		calls.push({ url, body: Object.fromEntries(init.body) });
		if (answer instanceof Error) throw answer;
		if (typeof answer === "function") return answer(init);
		return new Response(JSON.stringify(answer), { status: 200, headers: { "content-type": "application/json" } });
	};
}

test("config: missing secret or hostnames refuses; test secrets refused on any Vercel deployment", () => {
	assert.equal(readTurnstileConfig({}), null);
	assert.equal(readTurnstileConfig({ TURNSTILE_SECRET_KEY: SECRET }), null);
	assert.equal(readTurnstileConfig({ TURNSTILE_HOSTNAMES: "a.example" }), null);
	assert.deepEqual(readTurnstileConfig({ TURNSTILE_SECRET_KEY: SECRET, TURNSTILE_HOSTNAMES: " A.example , b.example" }), {
		secret: SECRET,
		hostnames: ["a.example", "b.example"],
	});
	const testSecret = "1x0000000000000000000000000000000AA";
	assert.equal(isTestSecret(testSecret), true);
	assert.equal(isTestSecret(SECRET), false);
	assert.notEqual(readTurnstileConfig({ TURNSTILE_SECRET_KEY: testSecret, TURNSTILE_HOSTNAMES: "localhost" }), null);
	for (const VERCEL_ENV of ["production", "preview", "development"]) {
		assert.equal(readTurnstileConfig({ TURNSTILE_SECRET_KEY: testSecret, TURNSTILE_HOSTNAMES: "localhost", VERCEL_ENV }), null);
	}
});

test("honeypot: any value counts, an empty field doesn't", () => {
	assert.equal(isHoneypotFilled("http://spam"), true);
	assert.equal(isHoneypotFilled(" "), true);
	assert.equal(isHoneypotFilled(""), false);
	assert.equal(isHoneypotFilled(null), false);
});

test("fill time: signed stamp, too fast, expired, forged, missing", () => {
	const issued = 1_000_000;
	const stamp = issueFormStamp(SECRET, issued);
	assert.equal(checkFormStamp(stamp, SECRET, issued + MIN_FILL_MS - 1), "too_fast");
	assert.equal(checkFormStamp(stamp, SECRET, issued + MIN_FILL_MS), "ok");
	assert.equal(checkFormStamp(stamp, SECRET, issued + 25 * 3_600_000), "expired");
	// A script that backdates the time can't sign it.
	const [, mac] = stamp.split(".");
	assert.equal(checkFormStamp(`${issued - 60_000}.${mac}`, SECRET, issued + 10), "invalid");
	assert.equal(checkFormStamp(issueFormStamp("another-secret", issued - 60_000), SECRET, issued), "invalid");
	assert.equal(checkFormStamp("12345", SECRET, issued), "invalid");
	assert.equal(checkFormStamp("", SECRET, issued), "missing");
	assert.equal(checkFormStamp(null, SECRET, issued), "missing");
});

test("turnstile accepts a valid token for the right hostname and action, and sends secret, token and IP", async () => {
	const calls = [];
	const fetch = siteverify({ success: true, hostname: "mailcheap.maiteam.ch", action: "archive-signup" }, calls);
	assert.equal(await verifyTurnstile({ ...BASE, remoteIp: "203.0.113.9" }, { fetch }), "ok");
	assert.equal(calls[0].url, SITEVERIFY_URL);
	assert.deepEqual(calls[0].body, { secret: SECRET, response: "token-1", remoteip: "203.0.113.9" });
});

test("turnstile: missing token is refused without calling Cloudflare", async () => {
	const calls = [];
	const fetch = siteverify({ success: true }, calls);
	assert.equal(await verifyTurnstile({ ...BASE, token: "" }, { fetch }), "missing");
	assert.equal(await verifyTurnstile({ ...BASE, token: null }, { fetch }), "missing");
	assert.equal(await verifyTurnstile({ ...BASE, token: "x".repeat(2049) }, { fetch }), "invalid");
	assert.equal(calls.length, 0);
});

test("turnstile: bad, spent or expired token is refused", async () => {
	for (const codes of [["invalid-input-response"], ["timeout-or-duplicate"], []]) {
		const fetch = siteverify({ success: false, "error-codes": codes });
		assert.equal(await verifyTurnstile(BASE, { fetch }), "invalid", codes.join());
	}
});

test("turnstile: wrong hostname or action is refused even when Cloudflare says success", async () => {
	const other = siteverify({ success: true, hostname: "evil.example", action: "archive-signup" });
	assert.equal(await verifyTurnstile(BASE, { fetch: other }), "hostname");
	const noHost = siteverify({ success: true, action: "archive-signup" });
	assert.equal(await verifyTurnstile(BASE, { fetch: noHost }), "hostname");
	const wrongAction = siteverify({ success: true, hostname: "mailcheap.maiteam.ch", action: "site-signup" });
	assert.equal(await verifyTurnstile(BASE, { fetch: wrongAction }), "action");
	const noAction = siteverify({ success: true, hostname: "mailcheap.maiteam.ch" });
	assert.equal(await verifyTurnstile(BASE, { fetch: noAction }), "action");
	// What Cloudflare's always-pass test secret actually returns (read 2026-10-14).
	const testKey = siteverify({ success: true, "error-codes": [], hostname: "example.com", metadata: { result_with_testing_key: true } });
	assert.equal(await verifyTurnstile(BASE, { fetch: testKey }), "hostname");
});

test("turnstile outage fails closed: throw, timeout, 5xx, bad JSON, internal-error, bad secret", async () => {
	const hang = (init) =>
		new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason)));
	const cases = [
		siteverify(new Error("ECONNRESET")),
		siteverify(hang),
		siteverify(() => new Response("upstream", { status: 502 })),
		siteverify(() => new Response("<html>", { status: 200 })),
		siteverify({ success: false, "error-codes": ["internal-error"] }),
		siteverify({ success: false, "error-codes": ["invalid-input-secret"] }),
	];
	for (const fetch of cases) {
		assert.equal(await verifyTurnstile(BASE, { fetch, timeoutMs: 30 }), "unavailable");
	}
});
