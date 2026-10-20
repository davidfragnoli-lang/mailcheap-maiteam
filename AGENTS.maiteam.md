# maiteam's deployment (mailcheap.maiteam.ch)

Read this as well as `AGENTS.md` when working on maiteam's deployment of mailcheap. `PATCHES.md` lists every local change on top of upstream; keep it current with each patch.

## Not ready for production yet

This branch is the migration onto upstream (FRA-26000). Until the send gates (P4), the signup protection (P5) and the sequences (P6) in `PATCHES.md` are re-ported and independently reviewed, upstream's own checks are the only ones in this code. Do not deploy it to production, and do not describe a gate as working unless `PATCHES.md` marks it as landed.

## Names

Product names are lowercase wherever a person sees them: mailcheap, fortuna, quote-to-invoice (never "Q2I"), maiteam (David, 20 Oct 2026, FRA-25997). Machine identifiers (env names, URLs, slugs, Redis keys, token info strings) keep their current spelling.

## Standing send controls

These rules bind every campaign, sequence, webhook, and import-triggered delivery. A path that does not exist yet is still bound by them. Do not add a delivery path that bypasses them, and do not describe a control as working unless this file says the source implements it.

Every one of those deliveries must use all of the following before it calls SES:

- Shared send-rate enforcement.
- A remaining rolling-24-hour SES quota precheck (`Max24HourSend` minus `SentLast24Hours`), with a reservation so two passing preflights cannot both send.
- A per-newsletter daily cap, shared by campaign, sequence, and webhook sends, lowered by the sender warm-up level, and also bounded by the SES allowance left.
- Bounce auto-pause at 2% and complaint auto-pause at 0.08%.
- Suppression checks when the audience is chosen and again at execution, including an unsubscribe that lands while a job is queued.

The default for an oversized eligible audience is to refuse it and say how many emails remain. Do not shorten it silently. Queued work is rechecked at execution. A missing or stale quota refuses the send. `SentLast24Hours` includes mail this app did not send; the ledger can under-send while SES catches up, and it must not overspend. App accounting is not a full record of the SES account.

Secrets belong in Paperclip secret bindings. Do not put tokens in files, logs, or comments. One SES production-access request is already pending in eu-north-1. Do not submit another. Do not invent a Google Postmaster TXT record or publish DNS. David adds that TXT after an authorized read returns the real record.

## Send gates (P4): what the source implements

`lib/maiteam/send-gate.js` sits in the one path every email takes to the provider (`deliver()` in `lib/sending.js`), so campaigns, last-chance, welcome, confirmation and test emails all pass through it. Each email holds one unit in the rolling 24-hour SES quota ledger and one in its newsletter's UTC-day cap before the handoff. The quota is a fresh account read no older than 60 s; missing or stale refuses. The cap is `Newsletter.dailySendCap`, else `NEWSLETTER_DAILY_CAP`; 0 is closed and unset refuses. It is lowered by the sender domain's warm-up level. The send slot runs at the lesser of `SEND_RATE_PER_SECOND`, 6 and SES `MaxSendRate`, and refuses when the shared Upstash count is missing or unreadable. A refusal leaves the email queued and the batch retries; a closed or missing cap pauses a campaign and fails a signup email with the reason. Holds are issued after the provider returns and released only when the email provably was not handed off. `queueCampaign` and `sendToMoreContacts` refuse an audience larger than what is left today, whole. Upstream's own pauses, account blocks, first-send slice and suppression checks run unchanged. `MAITEAM_SEND_GATES=off` disables the gates; only `tests/setup/register.mjs` sets it. Tests: `tests/maiteam-send-gates.test.mjs` (real batch path, synthetic SES account read and send slot) and the ported planner tests. They do not send mail. Not deployed.

## GitHub deployment provenance — David, 15 October 2026

Both repositories remain private. Production deploys come only from a commit
already pushed to the corresponding GitHub repository, through Vercel Git
integration (merge/push → Vercel build). Preview deploys may come from pushed
branches. Never run `vercel deploy` against a local tree for production.
The deploy gate must attest the exact commit, project, production aliases and
runtime before completion; local HEAD or caller-supplied metadata is not proof.
Preserve existing sending, launch, DNS and review gates. This rule does not
authorize sending mail or changing `SENDING_ENABLED`. Never force-push remote
history. Scan history for secrets before publishing a new repository.

