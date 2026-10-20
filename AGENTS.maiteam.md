# maiteam's deployment (mailcheap.maiteam.ch)

Read this as well as `AGENTS.md` when working on maiteam's deployment of mailcheap. `PATCHES.md` lists every local change on top of upstream; keep it current with each patch.

## Not ready for production yet

This branch is the migration onto upstream (FRA-26000). The send gates (P4), the signup protection (P5) and the welcome sequences with the waitlist webhook (P6) are in the source; P5 and P6 have not been independently reviewed, and nothing of this branch is deployed. Do not deploy it to production, and do not describe a gate as working unless `PATCHES.md` marks it as landed.

## Names

Product names are lowercase wherever a person sees them: mailcheap, fortuna, quote-to-invoice (never "Q2I"), maiteam (David, 20 Oct 2026, FRA-25997). Machine identifiers (env names, URLs, slugs, Redis keys, token info strings) keep their current spelling.

## Public signup protection (P5)

The source implements these on top of upstream's own signup checks, which all still run (BotID, honeypot, upstream's typo list, trap addresses, global suppressions, MX, the embed limits); the stricter rule wins. Every refusal returns before a contact is written or any mail is queued. Code in `lib/maiteam/`, hooks listed in `PATCHES.md` (P5).

- Archive form (`app/archive/actions.js`). BotID is called fail-closed. Then `checkArchiveSignup`: without `TURNSTILE_SECRET_KEY` and `TURNSTILE_HOSTNAMES`, or with a Cloudflare test secret on any Vercel deployment, every signup is refused. A missing, forged, expired or under-3-second signed fill stamp (`startSignup` issues it, because archive pages are cached) is refused. The Turnstile token must verify server-side for an exact `TURNSTILE_HOSTNAMES` host and the action `archive-signup`; a Cloudflare error or timeout refuses. Then the per-visitor limit and the address checks.
- Forms on other sites (`app/api/embed/[id]/route.js`): upstream's checks plus a per-visitor limit and the address checks. No Turnstile, as in the old fork, which had no embeds.
- `add_contact` from the REST API and MCP (not the dashboard): per-key and per-visitor limits and the address checks. No Turnstile: the caller's site runs its own bot checks. No input field skips a check.
- Address checks (`lib/maiteam/email-check.js`): syntax, a typo suggestion for gmail, hotmail, outlook and bluewin that is only offered (the archive form and the API accept `keepAsTyped` repeating the exact address; embeds refuse with the suggestion), the vendored disposable list (`vendor/disposable-email-domains/`, upstream commit `d1a9c51`, CC0, update procedure in its `SOURCE.md`), then MX or an A/AAAA fallback; a null MX refuses. A DNS failure or timeout refuses with a retry message (503 `unavailable` on the API and embeds). Upstream's own typo list still refuses its listed misspellings even when kept.
- Signup limits (`lib/maiteam/signup-limits.js`): missing Redis, a throw or a timeout refuses the signup and counts nothing in memory; over-limit still refuses. They are counted under their own `maiteam-*` names next to upstream's limits, which keep their memory fallback, as do login and every other limit.
- Tests: `tests/maiteam-*.test.mjs`, with synthetic Cloudflare, DNS and Redis. Upstream's own tests run with these checks off (`tests/stubs/maiteam-signup-protection.mjs`).

Not bound yet: the Turnstile keys and `TURNSTILE_HOSTNAMES` are not on any deployment of this code, and Upstash Redis was not bound on the old project at its last recorded read. Until they are, the archive form refuses every signup, and every public signup path refuses while Redis is missing. Bind them through the native secret path; never print or paste a key.

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

## Welcome sequences and waitlist webhooks (P6): what the source implements

Nothing here is bound or deployed: no `WAITLIST_WEBHOOK_PRODUCTS`, no `WAITLIST_SECRET_MAIFORTUNE` (the secret is not created), no sequence loaded into any database. Code in `lib/maiteam/sequence-*.js` and `lib/maiteam/waitlist-*.js`, hooks listed in `PATCHES.md` (P6).

- A sequence (`models/Sequence.js`) belongs to one newsletter of one account: 1 to 6 steps, whole days from the enrollment, each later than the one before; step 1 may reuse the newsletter's saved welcome email on day 0. Its look is the newsletter's; per-step looks are not re-ported. Statuses draft, active, paused. Only an active sequence takes signups, and saving publishes nothing: `start_sequence` (Start or Resume on `/sequences/<id>`) publishes each active enrollment's next open step, and refuses while sending is off.
- Enrollment (`models/Enrollment.js`): one per contact and sequence. `add_contact` with `sequence` (REST and MCP; an unknown or inactive slug answers not_found before the contact is written) enrolls an active or pending contact. A pending one waits (`awaiting_confirmation`) and starts at the confirmation click, which is its enrollment time, so delays count from the click. A sequence replaces the welcome email at signup and after the click; the confirmation email still goes, because it is the consent step. While sending is off, enrollments and clicks are recorded with every step held, and nothing is published.
- The step job (`/api/jobs/sequence-step`, QStash-signed, body `{ accountId, enrollmentId, position, scheduledFor }`) finds the enrollment by account and id. It refuses a step not yet due (published again for its day), a stale `scheduledFor`, an enrollment not confirmed, cancelled or finished, and a paused sequence. A contact no longer active or on the account's suppression list skips the step and ends the series. Then it claims the step, creates the step's one `Message` (kind `sequence`, unique per enrollment and position: `sequence:${enrollmentId}:${position}`), authorizes it while the enrollment is still active, and calls upstream's `sendMessageBatch`. The batch runs every upstream check again (account block, account and global suppression, contact status, `SENDING_ENABLED`, the plan's room) and `deliver()`, which runs the P4 gates: each step email holds a unit of the SES quota and of its newsletter's daily cap, a closed cap fails the step, a full cap or quota puts it off. Right before `deliver()` the batch claims the step `in-flight` with the compare-and-swap a cancellation uses, so exactly one of the two wins: a cancellation first means the provider is never called; a claim first means the cancellation reports the send is in flight and leaves that step. A send the provider or a gate put off goes back to `sending` (cancellable again) and the job publishes itself for when there is room (the next UTC midnight for a full cap). A sent, claimed, in-flight or failed step is never sent again.
- Cancellation: one-click and page unsubscribes (`/api/unsubscribe`), a provider unsubscribe, a hard bounce and a complaint (`lib/email-events.js`) cancel the contact's open enrollments; the dashboard and `cancel_enrollment` cancel one. A queued step email is skipped with it. Each step rechecks at execution, so a lost cancellation can't release a send. A status changed by hand or through `update_contact_status` is not hooked: the step's own check catches it.
- A sequence counts its sent, delivered, bounced, complained and failed emails, and pauses itself at upstream's campaign rate levels; the account-wide checks (`lib/account-health.js`) count its emails too.
- Waitlist webhook (`/api/webhooks/waitlist/<product>`): a product is a fixed server-side mapping to one newsletter slug and one sequence slug (`maifortune` → newsletter `maifortune`, sequence `welcome`; people see "fortuna waitlist"). The newsletter slug is unique across accounts, so it names the account; it is found like any public signup form's newsletter (`findSignupNewsletter`, cross-account by design), and a newsletter whose account can't take signups is not found. Off unless the product is in `WAITLIST_WEBHOOK_PRODUCTS` and its secret (32+ characters) is set. Signature `x-waitlist-signature: v1=<base64url HMAC-SHA256>` over `${timestamp}.${product}.${rawBody}`, `x-waitlist-timestamp` in Unix ms, 5 minutes back and 1 minute ahead, 4 KB at most. The JSON takes only `eventId`, `product` (equal to the path's), `email` and `ip`; anything else is refused. A replay store in Upstash Redis (no memory fallback: without Redis every event is refused) acknowledges a finished event once, answers 409 to an event id reused for another body, and 503 retryable while one is still running; 429 and 5xx answers free the event id for the sender's retry. The signup runs `checkWaitlistSignup` (per-product 600/h and per-visitor 5/10 min limits that fail closed, the P5 address checks), upstream's own address checks, then upstream's `addSignup`: always a pending contact with the confirmation email, refused unless the newsletter asks new subscribers to confirm. An unsubscribed or dormant contact stays as it is, and an active contact who never confirmed doesn't start the series.
- The fortuna copy is `fixtures/maifortune-welcome/copy.maiteam.{en,fr}.json`, built by `tests/runners/build-maifortune-copy.mjs` from the hash-pinned approved sources (maiteam-tracker-design `cd801e6`); its confirmation button is upstream's built-in button markup, which the newsletter's look recolours. The fortuna newsletter's look is the `fortuna` preset, saved explicitly (`theme: { preset: "fortuna" }`). Its cadence: the confirmation at signup, steps on day 1 and day 3 after the click.
- Tests: `tests/maiteam-sequences.test.mjs` (real paths, gates off), `tests/maiteam-sequence-gates.test.mjs` (gates on: quota and cap per step, cap 0 refuses), `tests/maiteam-waitlist-webhook.test.mjs`, `tests/maiteam-sequence-plan.test.mjs`. They send no mail.

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

