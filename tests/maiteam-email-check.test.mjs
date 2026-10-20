import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { DISPOSABLE_DOMAINS, DISPOSABLE_LIST_SHA256 } from "../lib/maiteam/disposable-domains-data.js";
import {
	checkMailDomain,
	checkSignupEmail,
	isDisposableDomain,
	screenSignupEmail,
	suggestDomain,
	suggestEmail,
} from "../lib/maiteam/email-check.js";

// Synthetic DNS: no lookup leaves this process.
function resolver(zone, calls = []) {
	const answer = (type) => async (domain) => {
		calls.push(`${type} ${domain}`);
		const value = zone[domain]?.[type];
		if (value instanceof Error) throw value;
		if (typeof value === "function") return value();
		if (value === undefined) throw Object.assign(new Error("no data"), { code: zone[domain] ? "ENODATA" : "ENOTFOUND" });
		return value;
	};
	return { resolveMx: answer("mx"), resolve4: answer("a"), resolve6: answer("aaaa") };
}
const dnsError = (code) => Object.assign(new Error(code), { code });
const ZONE = {
	"gmail.com": { mx: [{ exchange: "gmail-smtp-in.l.google.com", priority: 5 }] },
	"gamil.com": { mx: [{ exchange: "mx.gamil.example", priority: 10 }] },
	"bluewin.ch": { mx: [{ exchange: "mx.bluewin.ch", priority: 10 }] },
	"a-only.example": { a: ["192.0.2.1"] },
	"null-mx.example": { mx: [{ exchange: ".", priority: 0 }] },
	"no-mail.example": { txt: [] },
	"servfail.example": { mx: dnsError("ESERVFAIL") },
	"refused.example": { mx: dnsError("EREFUSED") },
	"hang.example": { mx: () => new Promise(() => {}) },
	"a-fails.example": { a: dnsError("ETIMEOUT") },
};

test("the vendored list is the pinned file: same sha256, same domains", () => {
	const text = readFileSync(new URL("../vendor/disposable-email-domains/disposable_email_blocklist.conf", import.meta.url), "utf8");
	assert.equal(createHash("sha256").update(text).digest("hex"), DISPOSABLE_LIST_SHA256);
	assert.equal(DISPOSABLE_LIST_SHA256, "bf235abe3d827cc9510a5cb4faedb0e1a7c5df88b7ad9437fd03d3770d826e1e");
	const lines = new Set(text.split("\n").map((line) => line.trim()).filter(Boolean));
	assert.equal(DISPOSABLE_DOMAINS.length, lines.size);
	const source = readFileSync(new URL("../vendor/disposable-email-domains/SOURCE.md", import.meta.url), "utf8");
	assert.match(source, /d1a9c51f29de15e8dab2f5ed8bda90a711ef6cb9/);
	assert.match(source, new RegExp(DISPOSABLE_LIST_SHA256));
	const license = readFileSync(new URL("../vendor/disposable-email-domains/LICENSE.txt", import.meta.url), "utf8");
	assert.match(license, /CC0 1\.0/);
});

test("disposable domains and their subdomains are refused; mainstream providers are not", () => {
	assert.equal(isDisposableDomain("0-mail.com"), true);
	assert.equal(isDisposableDomain("inbox.0-mail.com"), true);
	for (const domain of ["gmail.com", "hotmail.com", "outlook.com", "bluewin.ch", "gmx.ch", "proton.me", "icloud.com"]) {
		assert.equal(isDisposableDomain(domain), false, domain);
	}
	assert.deepEqual(screenSignupEmail("someone@0-mail.com"), { ok: false, code: "disposable" });
});

test("typo suggestions for gmail, hotmail, outlook and bluewin", () => {
	const cases = {
		"gmial.com": "gmail.com",
		"gamil.com": "gmail.com",
		"gmai.com": "gmail.com",
		"gmail.con": "gmail.com",
		"gmail.cm": "gmail.com",
		"gmial.cmo": "gmail.com",
		"hotmial.com": "hotmail.com",
		"hotmal.fr": "hotmail.fr",
		"hotmail.con": "hotmail.com",
		"outlok.com": "outlook.com",
		"outloook.fr": "outlook.fr",
		"bluwin.ch": "bluewin.ch",
		"bleuwin.ch": "bluewin.ch",
		"bluewin.cg": "bluewin.ch",
	};
	for (const [typed, meant] of Object.entries(cases)) assert.equal(suggestDomain(typed), meant, typed);
	assert.equal(suggestEmail("Jean.Dupont@gmial.com"), "Jean.Dupont@gmail.com");
});

test("no suggestion for correct domains or real neighbours", () => {
	for (const domain of [
		"gmail.com",
		"hotmail.fr",
		"hotmail.ch",
		"outlook.com",
		"bluewin.ch",
		"ymail.com",
		"email.com",
		"mail.com",
		"gmx.ch",
		"googlemail.com",
		"example.org",
		"maiteam.ch",
	]) {
		assert.equal(suggestDomain(domain), null, domain);
	}
});

test("a suggestion is never applied silently: the typed address is kept or refused, never rewritten", async () => {
	const calls = [];
	const dns = resolver(ZONE, calls);
	const first = await checkSignupEmail("reader@gamil.com", { resolver: dns });
	assert.deepEqual(first, { ok: false, code: "suggestion", suggestion: "reader@gmail.com" });
	// Asked before any lookup.
	assert.equal(calls.length, 0);

	// Accepting means the corrected address is what gets submitted.
	assert.deepEqual(await checkSignupEmail("reader@gmail.com", { resolver: dns }), { ok: true, email: "reader@gmail.com" });

	// Keeping it as typed must name that exact address, and still runs the domain check.
	assert.deepEqual(await checkSignupEmail("reader@gamil.com", { resolver: dns, keepAsTyped: "Reader@Gamil.com " }), {
		ok: true,
		email: "reader@gamil.com",
	});
	for (const keepAsTyped of [true, "yes", "other@gamil.com", "reader@gmail.com"]) {
		const again = await checkSignupEmail("reader@gamil.com", { resolver: dns, keepAsTyped });
		assert.equal(again.code, "suggestion", String(keepAsTyped));
	}
	// A kept typo still has to receive mail, and still can't be a throwaway inbox.
	const keptNoMail = await checkSignupEmail("reader@outlok.com", { resolver: dns, keepAsTyped: "reader@outlok.com" });
	assert.deepEqual(keptNoMail, { ok: false, code: "no_mail" });
	// "gmial.com" is itself on the disposable list: the suggestion is offered first, then the refusal.
	assert.deepEqual(screenSignupEmail("reader@gmial.com"), { ok: false, code: "suggestion", suggestion: "reader@gmail.com" });
	assert.deepEqual(screenSignupEmail("reader@gmial.com", { keepAsTyped: "reader@gmial.com" }), { ok: false, code: "disposable" });
});

test("MX: mail host, implicit A record, null MX, missing domain", async () => {
	const dns = resolver(ZONE);
	assert.equal(await checkMailDomain("gmail.com", { resolver: dns }), "ok");
	assert.equal(await checkMailDomain("a-only.example", { resolver: dns }), "ok");
	assert.equal(await checkMailDomain("null-mx.example", { resolver: dns }), "no_mail");
	assert.equal(await checkMailDomain("no-mail.example", { resolver: dns }), "no_mail");
	assert.equal(await checkMailDomain("nowhere.example", { resolver: dns }), "no_mail");
	assert.deepEqual(await checkSignupEmail("x@nowhere.example", { resolver: dns }), { ok: false, code: "no_mail" });
});

test("MX outage fails closed: SERVFAIL, REFUSED, timeout, A lookup failing", async () => {
	const dns = resolver(ZONE);
	for (const domain of ["servfail.example", "refused.example", "hang.example", "a-fails.example"]) {
		assert.equal(await checkMailDomain(domain, { resolver: dns, timeoutMs: 30 }), "unavailable", domain);
	}
	assert.deepEqual(await checkSignupEmail("x@servfail.example", { resolver: dns }), { ok: false, code: "unavailable" });
});

test("syntax is checked first", async () => {
	for (const raw of ["", "nope", "a@b", "Dana <dana@example.com>", "a,b@example.com", null, 42]) {
		assert.deepEqual(await checkSignupEmail(raw, { resolver: resolver({}) }), { ok: false, code: "invalid" });
	}
});
