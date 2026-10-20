#!/bin/zsh
# Weekly upstream sync for maiteam's mailcheap (PATCHES.md, FRA-26000 step 7). Meant to run as one step of the
# existing weekly routine (ai.fragno.weekly-upstream-updates), not as a parallel updater.
#
#   scripts/maiteam/weekly-upstream-sync.sh [--dry-run|--push|--promote] [--worktree <dir>] [--branch <deployed>]
#
#   --dry-run  (default) fetch, merge upstream/main into a sync branch, re-apply P2, run every gate. Nothing pushed.
#   --push     the same, then push the sync branch to origin, so Vercel builds a Git-backed preview, and smoke it.
#   --promote  the same as --push, then fast-forward the deployed branch to the sync branch and push it, so Vercel
#              builds production through Git integration, and read back that the production hostname serves it. On
#              failure, roll back to the previous production deployment and read that back too. This is the weekly
#              routine's mode once FRA-26000's release gates are met: weekly following is authorized, with no per-run card.
#
# Promotion needs a verified rollback target first (scripts/maiteam/vercel-release.zsh): the deployment production
# serves now, READY, built from the deployed branch's exact commit, and what the hostname's alias points at. Without
# one it stops before pushing. "ROLLED BACK" is printed only after the alias reads back to the previous deployment and
# it answers healthily; otherwise "ROLLBACK FAILED" (exit 2): production state unverified, an operator acts.
#
# Any failed gate stops before anything is pushed or promoted: merge conflict, tests, lint, build, the lowercase
# check, a lost maiteam hook (send gates, signup protection, source link), a LICENSE or notice change, a secret in
# the merge, or a model change (a data migration needs a person). Never force-pushes. Prints one summary line last.

set -u
setopt pipefail
MODE=dry-run
WORKTREE="$HOME/Projects/mailcheap-sync"
DEPLOYED=production
BASE_REF=""
UPSTREAM_REF=upstream/main
while (( $# )); do
	case "$1" in
		--dry-run|--push|--promote) MODE="${1#--}" ;;
		--worktree) WORKTREE="$2"; shift ;;
		--branch) DEPLOYED="$2"; shift ;;
		# Validation only: merge into this local ref instead of origin/<deployed>. Refuses --push and --promote.
		--base-ref) BASE_REF="$2"; shift ;;
		--upstream-ref) UPSTREAM_REF="$2"; shift ;;
		*) print -u2 "unknown option $1"; exit 2 ;;
	esac
	shift
done

STAMP="$(date -u +%Y-%m-%d)"
SYNC="sync/upstream-$STAMP"
LOG_DIR="${MAILCHEAP_SYNC_LOG_DIR:-$HOME/Library/Logs/fragno/mailcheap-sync}"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/$STAMP.log"
log() { print -r -- "$(date -u +%FT%TZ) $*" | tee -a "$LOG"; }
finish() { log "RESULT $1"; print -r -- "mailcheap: $1"; exit "${2:-0}"; }

[[ -d "$WORKTREE/.git" || -f "$WORKTREE/.git" ]] || finish "STOP no sync worktree at $WORKTREE" 1
cd "$WORKTREE" || finish "STOP cannot enter $WORKTREE" 1
[[ -z "$(git status --porcelain)" ]] || finish "STOP sync worktree is dirty" 1

git fetch --quiet origin >>"$LOG" 2>&1 || finish "STOP fetch origin failed" 1
git fetch --quiet upstream >>"$LOG" 2>&1 || finish "STOP fetch upstream failed" 1
[[ ( -n "$BASE_REF" || "$UPSTREAM_REF" != upstream/main ) && "$MODE" != dry-run ]] && finish "STOP --base-ref and --upstream-ref are for dry runs only" 1
BASE="$(git rev-parse "${BASE_REF:-origin/$DEPLOYED}")" || finish "STOP no ${BASE_REF:-origin/$DEPLOYED}" 1
UPSTREAM="$(git rev-parse "$UPSTREAM_REF")" || finish "STOP no $UPSTREAM_REF" 1
NEW="$(git rev-list --count "$BASE..$UPSTREAM")"
[[ "$NEW" == 0 ]] && finish "current (upstream/main ${UPSTREAM:0:7} already merged into $DEPLOYED ${BASE:0:7})"
log "upstream/main ${UPSTREAM:0:7}: $NEW new commits on top of $DEPLOYED ${BASE:0:7}"

git checkout --quiet -B "$SYNC" "$BASE" || finish "STOP cannot create $SYNC" 1
if ! git -c user.name="mailcheap weekly sync" -c user.email=noreply@anthropic.com merge --no-edit --quiet "$UPSTREAM" >>"$LOG" 2>&1; then
	# Conflicts that are only P2's names take upstream's side; the script below lowercases them again.
	if node scripts/maiteam/resolve-name-conflicts.mjs >>"$LOG" 2>&1; then
		git -c user.name="mailcheap weekly sync" -c user.email=noreply@anthropic.com commit --no-edit --quiet >>"$LOG" 2>&1 || finish "STOP merge commit failed" 1
		log "name-only conflicts resolved to upstream, P2 re-applied below"
	else
		FILES="$(git diff --name-only --diff-filter=U | tr '\n' ' ')"
		git merge --abort >/dev/null 2>&1
		finish "STOP merge conflict: $FILES" 1
	fi
fi

# P2: names are re-applied by the script, never merged by hand.
node scripts/maiteam/lowercase-names.mjs >>"$LOG" 2>&1 || finish "STOP lowercase script failed" 1
if [[ -n "$(git status --porcelain)" ]]; then
	git add -A && git -c user.name="mailcheap weekly sync" -c user.email=noreply@anthropic.com commit --quiet -m "P2: lowercase names after the upstream merge of $STAMP" || finish "STOP P2 commit failed" 1
fi

# Gates that need no build.
CHANGED="$(git diff --name-only "$BASE" HEAD)"
print -r -- "$CHANGED" | grep -q -E '^LICENSE$' && finish "STOP LICENSE changed upstream: review the license before merging" 1
# A model change stops the sync only when it can need a data migration: a removed schema line, or a new required,
# unique, enum or immutable constraint. Other model changes (a new optional field, a comment) are reported.
MODEL_DIFF="$(git diff "$BASE" HEAD -- models/ | grep -E '^[-+]' | grep -v -E '^(\+\+\+|---)' | grep -v -E '^[-+][[:space:]]*(//|$)')"
RISKY="$(print -r -- "$MODEL_DIFF" | grep -E '^-|^\+.*(required|unique|enum|immutable)' | head -5)"
[[ -n "$RISKY" ]] && finish "STOP model change may need a data migration: $(print -r -- "$RISKY" | tr '\n' ' ' | cut -c1-300)" 1
MODELS="$(print -r -- "$CHANGED" | grep -E '^models/' | tr '\n' ' ')"
[[ -n "$MODELS" ]] && log "model files changed without migration risk: $MODELS"
grep -q 'gateDelivery' lib/sending.js || finish "STOP the send gate hook left lib/sending.js deliver()" 1
grep -q 'failClosed' lib/send-rate.js || finish "STOP the fail-closed send rate left lib/send-rate.js" 1
grep -q 'checkArchiveSignup' app/archive/actions.js || finish "STOP the archive signup protection hook is gone" 1
grep -q 'LinkSource' components/FooterArchive.jsx || finish "STOP the AGPL source link left the archive footer" 1
if command -v gitleaks >/dev/null; then
	gitleaks git --log-opts="$BASE..HEAD" --no-banner --redact >>"$LOG" 2>&1 || finish "STOP gitleaks found a secret in the merged commits" 1
else
	finish "STOP gitleaks is not installed" 1
fi

npm ci --no-audit --no-fund >>"$LOG" 2>&1 || finish "STOP npm ci failed" 1
TEST_ENV=(PATH="$PATH" HOME="$HOME" TMPDIR="${TMPDIR:-/tmp}")
[[ -n "${MONGOD_PATH:-}" ]] && TEST_ENV+=(MONGOD_PATH="$MONGOD_PATH")
env -i "${TEST_ENV[@]}" node --import ./tests/setup/register.mjs --test --test-reporter=tap "tests/**/*.test.mjs" >"$LOG_DIR/$STAMP.tap" 2>&1
TESTS="$(grep -E '^# (pass|fail)' "$LOG_DIR/$STAMP.tap" | tr '\n' ' ')"
grep -q '^# fail 0$' "$LOG_DIR/$STAMP.tap" || finish "STOP tests: $TESTS" 1
npx eslint >>"$LOG" 2>&1 || finish "STOP lint failed" 1
node scripts/maiteam/lowercase-names.mjs --check >>"$LOG" 2>&1 || finish "STOP a product name is still capitalized" 1
env -i PATH="$PATH" HOME="$HOME" NODE_ENV=production BETTER_AUTH_SECRET=build-only-not-a-secret-0123456789abcdef SUPPRESSION_HASH_KEY=build-only-not-a-key-0123456789abcdef SENDING_ENABLED=false APP_URL=https://build.invalid npx next build >>"$LOG" 2>&1 || finish "STOP build failed" 1
log "gates passed: $TESTS"

[[ "$MODE" == dry-run ]] && finish "ready ${SYNC} (upstream ${UPSTREAM:0:7}, $NEW commits, $TESTS) dry run, nothing pushed"

# From here on, only with --push or --promote. Vercel builds every pushed branch through Git integration.
source "${0:A:h}/vercel-release.zsh"
HOST="${MAILCHEAP_PRODUCTION_HOST:-mailcheap.maiteam.ch}"
PRODUCTION_URL="${MAILCHEAP_PRODUCTION_URL:-https://$HOST}"
if [[ "$MODE" == promote ]]; then
	release_preflight "$BASE" "$HOST" || finish "STOP no verified rollback target: $RELEASE_PROBLEM" 1
	log "rollback target $PREVIOUS (${PREVIOUS_SHA:0:7}) serves $HOST"
fi
git push --quiet origin "$SYNC" >>"$LOG" 2>&1 || finish "STOP push of $SYNC failed" 1
SHA="$(git rev-parse HEAD)"
await_deployment "$SHA" preview || finish "STOP $RELEASE_PROBLEM" 1
vercel_call GET "/v13/deployments/$DEPLOYMENT_ID" || finish "STOP $RELEASE_PROBLEM" 1
PREVIEW="$(print -r -- "$VERCEL_REPLY" | json_field url)"
[[ -n "$PREVIEW" ]] && smoke "https://$PREVIEW" || finish "STOP preview smoke failed for ${SHA:0:7}" 1
[[ "$MODE" == push ]] && finish "preview ready https://$PREVIEW (${SHA:0:7}, $TESTS); promote with --promote after review"

git checkout --quiet "$DEPLOYED" && git merge --ff-only --quiet "$SYNC" && git push --quiet origin "$DEPLOYED" >>"$LOG" 2>&1 || finish "STOP fast-forward push of $DEPLOYED failed" 1
if await_deployment "$SHA" production && await_serving "$HOST" "$DEPLOYMENT_ID" "$PRODUCTION_URL"; then
	finish "promoted ${SHA:0:7} (upstream ${UPSTREAM:0:7}, $NEW commits, $TESTS); $HOST serves $DEPLOYMENT_ID"
fi
FAILURE="$RELEASE_PROBLEM"
# Instant rollback to the deployment that served before. The database is untouched: model changes never get here.
if rollback_to "$PREVIOUS" "$HOST" "$PRODUCTION_URL"; then
	finish "ROLLED BACK ${SHA:0:7} ($FAILURE); $HOST serves $PREVIOUS (${PREVIOUS_SHA:0:7}) again, read back. $DEPLOYED is ahead of production until the commit is reverted" 1
fi
finish "ROLLBACK FAILED for ${SHA:0:7} ($FAILURE; rollback: $RELEASE_PROBLEM). Production state unverified: operator now" 2
