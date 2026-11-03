// maiteam (PATCHES.md P11): a sending domain whose custom MAIL FROM falls back to the provider's own when its MX is
// missing (SES BehaviorOnMxFailure USE_DEFAULT_VALUE, stored as Domain.mailFromFallback by lib/domains.js) still
// sends: mail goes out with amazonses.com as its return path, DKIM-signed and aligned on the From domain, as it did
// before upstream's own DNS look. So that one finding is a warning, not a stop. Every other finding still stops the
// domain: a proxied or different record, a missing DKIM key, a missing return-path TXT, or a missing MX on a domain
// whose provider would refuse the send instead (REJECT_MESSAGE, or not known).
export function isMailFromFallbackWarning(domain, problem) {
	return domain?.mailFromFallback === true && problem?.purpose === "mail-from" && problem?.type === "MX" && problem?.state === "missing";
}

export function splitMailFromFallback(domain, problems) {
	const warnings = problems.filter((problem) => isMailFromFallbackWarning(domain, problem));
	return { problems: problems.filter((problem) => !isMailFromFallbackWarning(domain, problem)), warnings };
}
