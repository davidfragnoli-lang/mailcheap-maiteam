# Cutover runbook: the old fork → upstream (FRA-26000)

For the operator and Ops QA. Nothing here is authorized by this file. Each gate below needs its own approval.

## Gates, in order

1. Independent QA approves the pinned candidate commit and this runbook (FRA-25999).
2. David approves the one publication card on FRA-26000. That covers the public source repository and the `SOURCE_REPOSITORY_URL` link (P7). Every repository stays private until then.
3. The AWS changes below are made and read back.
4. The production database read credential is bound to the lane that runs the dump.
5. Sending stays at its standing controls throughout. `SENDING_ENABLED` and DNS are not changed by this runbook.

## Pinned before cutover

- **Old deployment:** the production deployment that serves `mailcheap.maiteam.ch` at that moment. Read it with the team-scoped project call (`targets.production.id`, recorded on FRA-26000 at cutover). Vercel keeps each deployment with its own build and environment, so rolling back to it also brings back its `MONGODB_URI`, the old database.
- **Old database:** never written by the migration. The new server uses a new database.
- **Final dump:** `mongodump --archive --gzip` of the old database, stored under `$HOME/Backups/mailcheap/`, mode 600, with its sha256 recorded on FRA-26000. It holds personal data and does not go into evidence.

## AWS (SES eu-north-1), before the first send

Upstream sends every email through the account's SES tenant and its own configuration set (`lib/ses.js`, `lib/email-provider/ses.js`). It creates both on the first send.

- IAM on the `SES_*` user: `ses:SendEmail` on the identity, `configuration-set/mc-*` and `tenant/*`. Add `CreateConfigurationSet`, `CreateConfigurationSetEventDestination`, `CreateTenant`, `GetTenant`, `TagResource`, `UpdateReputationEntityPolicy`, `CreateTenantResourceAssociation`, `GetEmailIdentity` and `GetAccount`. For removal paths, add `DeleteTenantResourceAssociation`, `DeleteTenant`, `DeleteConfigurationSet` and `UpdateReputationEntityCustomerManagedStatus`. Add `CreateEmailIdentity` and `PutEmailIdentityMailFromAttributes` only if domains are added in the dashboard. Do not re-add `mail.maiteam.ch` there: it would rewrite MAIL FROM.
- Confirm that SES tenants and reputation policies exist in eu-north-1 before anything else.
- SNS: keep `SES_SNS_TOPIC_ARN` and the `/api/webhooks/ses` subscription. Allow the topic to receive from `configuration-set/mc-*`. Keep the old configuration set and its event destination, because late events for old mail arrive through it (P8b handles them).
- Do not submit another SES production-access request: one is pending.

## Environment of the new production deployment (names only)

`MONGODB_URI` (the new database), `BETTER_AUTH_SECRET` (**exactly the old `SESSION_SECRET`**, or every unsubscribe, confirmation and tracking link in sent mail breaks), `SUPPRESSION_HASH_KEY` (new, 32+), `APP_URL` (unchanged host), `ADMIN_EMAILS`, `EMAIL_FROM` (on the verified SES domain, for sign-in codes), `SES_REGION=eu-north-1`, `SES_ACCESS_KEY_ID`, `SES_SECRET_ACCESS_KEY`, `SES_AWS_ACCOUNT_ID`, `SES_SNS_TOPIC_ARN`, `EMAIL_PROVIDER=ses`, `SENDING_ENABLED` (its current value), `SEND_RATE_PER_SECOND` (current), `NEWSLETTER_DAILY_CAP` (optional), `QSTASH_*`, `UPSTASH_REDIS_REST_*` (required: the send gates refuse without it), `NEXT_PUBLIC_TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY` and `TURNSTILE_HOSTNAMES` (P5: without them the archive form refuses), `SOURCE_REPOSITORY_URL` (only after the publication card). Leave `MAILCHEAP_CLOUD`, Stripe, Resend, `SHARED_DOMAIN`, `DNS_BROKER_*` and `ARCHIVE_CNAME_TARGET` unset, and the OpenAI content check unset.

## The write boundary (P8d)

The old server keeps taking writes until the alias moves and its last requests finish (`maxDuration` is at most 300 s on both sides). Nothing it writes is lost, because the catch-up reads it from the old database afterwards. The new server takes the alias in the **hold**, which `migrate-from-fork.mjs` sets and `catch-up.mjs --release` ends:

- The account is blocked with upstream's own block. No email goes out, confirmation and welcome emails included, and no new signup is taken. Unsubscribes and pending readers' confirmations still work.
- Every sequence is paused. `maiteam_cutover` records what each one was.
- A click on an unsubscribe, confirm or keep link that names a contact the new database doesn't have yet is recorded in `maiteam_cutover_pending`, and the reader sees the normal result. The catch-up applies it once the contact has arrived.
- A bounce or complaint for old-fork mail that has no Message here yet suppresses the address on the migrated account, as the old server did.
- A step job the old server published (it has no `accountId`) finds its account through its enrollment, and is acknowledged as paused. One whose enrollment hasn't arrived yet answers 503, so QStash retries it.

Resume, after the release, publishes each enrollment's earliest unresolved step once, with a new `scheduledFor`. Every older job for that step is then acknowledged as a duplicate.

## Cutover

1. Check that nothing is in flight: no campaign `sending` or `scheduled` (the migration refuses one), no sequence step due inside the window, and the QStash queue empty for the app's job URLs.
2. Final dump. Record its start time and sha256.
3. Rehearse once more on that dump: `scripts/maiteam/rehearse-migration.sh --dump <archive> --dumped-at <dump start> --source-db <name> --owner-email <owner> --mail-from <MAIL FROM host> --out <dir>`. `migrationChecksOk` must be `true`, `countMismatches` empty, `restoreSame` `true`, and `dumpedAt` the recorded start. The restore proof compares every document and index.
4. Migrate into the new, empty database: `MIGRATE_SOURCE_URI=<old, read-only> MIGRATE_TARGET_URI=<new> node scripts/maiteam/migrate-from-fork.mjs --owner-email <owner> --mail-from <host> --archive-host <host> --dumped-at <dump start> --execute --report <file>`. A broken reference, a duplicate under a unique index or a campaign mid-send stops it before anything is written. Stop on any check that is not `true`.
5. Set the new deployment's environment above. Push the candidate commit to the production branch on GitHub, so Vercel Git integration builds and promotes it. Never use `vercel deploy` for production. The alias now serves the new deployment, in the hold.
6. Wait 300 s, until the old deployment's last requests have finished.
7. Catch up: `CATCHUP_SOURCE_URI=<old, read-only> CATCHUP_TARGET_URI=<new> node scripts/maiteam/catch-up.mjs --execute`. It repeats until a pass changes nothing. `converged` and every check must be `true`, and `unresolvedClicks` must be 0.
8. Release: the same command with `--execute --release`. It refuses unless step 7's conditions hold. Then press **Resume** on each sequence the report lists, in the dashboard.
9. Attest the deployed commit, project, aliases and runtime from Vercel's API. Smoke test: `/api/health`, sign-in, an archive page, one-click unsubscribe with a link from an email sent before the cutover, and a test email to David's own address within the existing send authorization.
10. Ops QA verifies production on the same lane.

## Rollback

1. Hold the old database first: `ROLLBACK_NEW_URI=<new> ROLLBACK_OLD_URI=<old> node scripts/maiteam/rollback-replay.mjs --hold --execute`. This pauses the old server's running sequences, so it sends no step before the replay ends.
2. Vercel instant rollback to the pinned old deployment. Wait 300 s, until the new deployment's last requests have finished.
3. Replay: `… rollback-replay.mjs` (a count), then `… --execute`. By default it starts from the dump time in the new database's cutover record, so clicks taken during the hold go back too. It carries back unsubscribes, suppressions, confirmations, new signups with their enrollments, sequence progress, sent emails with their provider ids, SES events and today's send caps. It repeats until a pass changes nothing. A step the new server finished stays finished, so the old server never sends it again. A step the new server queued but never handed off comes back open, without its unsent email. `converged` and every check must be `true`. A nonzero `ambiguousSteps` means an enrollment has a step in flight or failed before an open one, and the old server's Resume would skip past it. Settle those by hand first.
4. Press Resume on the old server's held sequences. Verify `/api/health`, and one unsubscribe link from mail sent after the cutover.
5. The new database, the SES tenant and the `mc-*` configuration set stay in place, unused, for the post-mortem.

A deployment rollback alone does not reverse database changes. Steps 1 and 3 are what do.
