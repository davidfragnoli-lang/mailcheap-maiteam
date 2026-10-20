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

## Cutover

1. Check that nothing is in flight: no campaign `sending` or `scheduled` inside the window, no sequence step due inside it, and the QStash queue empty for the app's job URLs.
2. Final dump. Record its sha256.
3. Rehearse once more on that dump: `scripts/maiteam/rehearse-migration.sh --dump <archive> --source-db <name> --owner-email <owner> --mail-from <MAIL FROM host> --out <dir>`. `migrationChecksOk` must be `true`, `countMismatches` empty, and `restoreSame` `true`.
4. Migrate into the new, empty database: `MIGRATE_SOURCE_URI=<old, read-only> MIGRATE_TARGET_URI=<new> node scripts/maiteam/migrate-from-fork.mjs --owner-email <owner> --mail-from <host> --archive-host <host> --execute --report <file>`. Stop on any check that is not `true`.
5. Set the new deployment's environment above. Push the candidate commit to the production branch on GitHub, so Vercel Git integration builds it. Never use `vercel deploy` for production.
6. Attest the deployed commit, project, aliases and runtime from Vercel's API. Smoke test: `/api/health`, sign-in, an archive page, one-click unsubscribe with a link from an email sent before the cutover, and a test email to David's own address within the existing send authorization.
7. Ops QA verifies production on the same lane.

## Rollback

1. Replay what readers did on the new server since the cutover: `ROLLBACK_NEW_URI=<new> ROLLBACK_OLD_URI=<old> node scripts/maiteam/rollback-replay.mjs --since <cutover time>`, then again with `--execute`. Unsubscribes, suppressions, confirmations and new signups go back. It is idempotent.
2. Vercel instant rollback to the pinned old deployment.
3. Verify `/api/health`, and one unsubscribe link from mail sent after the cutover.
4. The new database, the SES tenant and the `mc-*` configuration set stay in place, unused, for the post-mortem.

A deployment rollback alone does not reverse database changes. Step 1 is what does.
