import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { SESv2Client } from "@aws-sdk/client-sesv2";
import { getRecordState, mergeDnsProblems } from "../lib/domain-dns-rules.js";
import { getDomainSetup, getDomainSummary } from "../lib/domain-records.js";
import { withActiveProvider } from "../lib/sender-rules.js";
import { activate, addVerifiedDomain, platformEmails, signIn, startTestApp } from "./helpers/app.mjs";
import { records as dnsAnswers } from "./stubs/dns-check.mjs";
import { state } from "./stubs/ses.mjs";

// maiteam (PATCHES.md P11, FRA-25999 QA r4 item 1): mail.maiteam.ch keeps option B, no MX on bounce.mail.maiteam.ch,
// and SES falls back to its own MAIL FROM (USE_DEFAULT_VALUE). Upstream 40244c9's DNS look must not stop that domain.
const RECORDS = [
	{ purpose: "dkim", type: "CNAME", name: "t1._domainkey.mail.maiteam.ch", value: "t1.dkim.amazonses.com" },
	{ purpose: "mail-from", type: "MX", name: "bounce.mail.maiteam.ch", value: "10 feedback-smtp.eu-north-1.amazonses.com" },
	{ purpose: "mail-from", type: "TXT", name: "bounce.mail.maiteam.ch", value: "v=spf1 include:amazonses.com ~all" },
];

function lookedAt({ cname = ["t1.dkim.amazonses.com"], mx = [], txt = ["v=spf1 include:amazonses.com ~all"] } = {}) {
	const states = [getRecordState(RECORDS[0], { cname, txt: [], targetTxt: ["v=DKIM1; p=t1"], addresses: [] }), getRecordState(RECORDS[1], { mx }), getRecordState(RECORDS[2], { txt })];
	return { domain: "mail.maiteam.ch", provider: "ses", verified: true, records: RECORDS, dns: { checkedAt: new Date(), problems: mergeDnsProblems(RECORDS, states) } };
}

test("QA's probe: a missing return-path MX stops the domain only when SES would not fall back", () => {
	const stopped = withActiveProvider(lookedAt(), "ses");
	assert.equal(stopped.verified, false, "without the fallback known, upstream's stop stands");
	assert.equal(withActiveProvider({ ...lookedAt(), mailFromFallback: false }, "ses").verified, false, "REJECT_MESSAGE stops");
	const sending = withActiveProvider({ ...lookedAt(), mailFromFallback: true }, "ses");
	assert.equal(sending.verified, true, "USE_DEFAULT_VALUE sends");
	assert.deepEqual(sending.dnsProblems, []);
	assert.deepEqual(sending.dnsWarnings.map(({ type, state }) => `${type} ${state}`), ["MX missing"]);
	const steps = getDomainSetup(sending);
	assert.equal(steps.find(({ key }) => key === "mail-from").status.tone, "wait", "the Domains page shows it as a warning");
	assert.equal(getDomainSummary(sending).label, "Ready");
});

test("every other finding still stops a domain with the fallback", () => {
	for (const [label, answers] of [
		["DKIM missing", { cname: [], mx: [] }],
		["return-path TXT missing", { txt: [] }],
	]) {
		const domain = withActiveProvider({ ...lookedAt(answers), mailFromFallback: true }, "ses");
		assert.equal(domain.verified, false, label);
		assert.ok(domain.dnsProblems.length > 0, label);
	}
	const proxied = lookedAt();
	proxied.dns.problems = [{ purpose: "mail-from", type: "MX", name: "bounce.mail.maiteam.ch", state: "different" }];
	assert.equal(withActiveProvider({ ...proxied, mailFromFallback: true }, "ses").verified, false, "a different MX stops");
});

test("lib/ses.js reads SES's BehaviorOnMxFailure", async () => {
	const original = SESv2Client.prototype.send;
	let behavior = "USE_DEFAULT_VALUE";
	SESv2Client.prototype.send = async () => ({
		VerifiedForSendingStatus: true,
		DkimAttributes: { Status: "SUCCESS", Tokens: ["t1"] },
		MailFromAttributes: { MailFromDomain: "bounce.mail.maiteam.ch", MailFromDomainStatus: "FAILED", BehaviorOnMxFailure: behavior },
	});
	try {
		const ses = await import("../lib/ses.js");
		assert.equal((await ses.getDomainIdentity("mail.maiteam.ch")).mailFromFallback, true);
		behavior = "REJECT_MESSAGE";
		assert.equal((await ses.getDomainIdentity("mail.maiteam.ch")).mailFromFallback, false);
	} finally {
		SESv2Client.prototype.send = original;
	}
});

let app;
before(async () => {
	app = await startTestApp();
});
after(() => app?.stop());

function answer(domain, mx) {
	dnsAnswers.set(`MX bounce.${domain}`, mx);
	dnsAnswers.set(`TXT bounce.${domain}`, ["v=spf1 include:amazonses.com ~all"]);
	for (const token of ["tok1", "tok2", "tok3"]) dnsAnswers.set(`CNAME ${token}._domainkey.${domain}`, [`${token}.dkim.amazonses.com`]);
}

test("the hourly look stores SES's fallback and keeps a fallback domain sending; without it the domain stops and its owner hears", async () => {
	const Domain = (await import("../models/Domain.js")).default;
	const { recheckDomains } = await import("../lib/domains.js");
	const user = await signIn("fallback@example.com");
	await activate(user);
	for (const [name, fallback] of [["fallback-mail.com", true], ["reject-mail.com", false]]) {
		answer(name, ["feedback-smtp.us-east-1.amazonses.com"]);
		await addVerifiedDomain(user, name);
		state.identities.get(name).mailFromFallback = fallback;
		answer(name, []);
		await Domain.updateOne({ accountId: user.accountId, domain: name }, { $set: { "dns.checkedAt": new Date(Date.now() - 25 * 3_600_000) } });
	}
	await recheckDomains();
	const read = async (name) => Domain.findOne({ accountId: user.accountId, domain: name }).lean();
	const fallback = await read("fallback-mail.com");
	assert.equal(fallback.mailFromFallback, true, "saved from the provider's answer");
	assert.deepEqual(fallback.dns.problems.map(({ type, state }) => `${type} ${state}`), ["MX missing"], "the finding is kept");
	assert.equal(withActiveProvider(fallback).verified, true, "and it still sends");
	const reject = await read("reject-mail.com");
	assert.equal(reject.mailFromFallback, false);
	assert.equal(withActiveProvider(reject).verified, false);
	const stopped = (domain) => platformEmails.filter(({ subject }) => subject === `[mailcheap] Sending from ${domain} stopped`).length;
	assert.deepEqual([stopped("fallback-mail.com"), stopped("reject-mail.com")], [0, 1]);
});
