#!/bin/zsh
# Weekly upstream sync for maiteam's mailcheap (PATCHES.md, FRA-26000 step 7). Meant to run as one step of the
# existing weekly routine (ai.fragno.weekly-upstream-updates), not as a parallel updater.
#
#   scripts/maiteam/weekly-upstream-sync.sh [--dry-run|--push|--promote] [--worktree <dir>] [--branch <deployed>]
#
#   --dry-run  (default) fetch, merge upstream/main into a sync branch, re-apply P2, run every gate. Nothing pushed.
#   --push     the same, then push the sync branch to origin, so Vercel builds a Git-backed preview, and smoke it.
#   --promote  the same as --push, then fast-forward the deployed branch to the sync branch and push it, so Vercel
#              builds production through Git integration; smoke production; on failure, roll back to the previous
#              production deployment and report. Only for runs David has authorized.
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
	FILES="$(git diff --name-only --diff-filter=U | tr '\n' ' ')"
	git merge --abort >/dev/null 2>&1
	finish "STOP merge conflict: $FILES" 1
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
git push --quiet origin "$SYNC" >>"$LOG" 2>&1 || finish "STOP push of $SYNC failed" 1
SHA="$(git rev-parse HEAD)"
smoke() {
	local url="$1"
	local code
	code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$url/api/health")"
	[[ "$code" == 200 ]]
}
deployment_url() {
	# The READY deployment Vercel built for this commit (team-scoped; VERCEL_TOKEN, VERCEL_TEAM_ID, VERCEL_PROJECT_ID from the routine's env).
	curl -s -H "Authorization: Bearer $VERCEL_TOKEN" "https://api.vercel.com/v6/deployments?projectId=$VERCEL_PROJECT_ID&teamId=$VERCEL_TEAM_ID&limit=20&target=$1" |
		/usr/bin/python3 -c 'import json,sys; sha=sys.argv[1]; d=[x for x in json.load(sys.stdin).get("deployments",[]) if x.get("meta",{}).get("githubCommitSha")==sha and x.get("state")=="READY"]; print("https://"+d[0]["url"] if d else "")' "$SHA"
}
for _ in {1..40}; do PREVIEW="$(deployment_url preview)"; [[ -n "$PREVIEW" ]] && break; sleep 30; done
[[ -n "${PREVIEW:-}" ]] || finish "STOP no READY preview for ${SHA:0:7} after 20 minutes" 1
smoke "$PREVIEW" || finish "STOP preview smoke failed at $PREVIEW" 1
[[ "$MODE" == push ]] && finish "preview ready $PREVIEW (${SHA:0:7}, $TESTS); promote with --promote after review"

PREVIOUS="$(curl -s -H "Authorization: Bearer $VERCEL_TOKEN" "https://api.vercel.com/v9/projects/$VERCEL_PROJECT_ID?teamId=$VERCEL_TEAM_ID" | /usr/bin/python3 -c 'import json,sys; print(json.load(sys.stdin).get("targets",{}).get("production",{}).get("id",""))')"
git checkout --quiet "$DEPLOYED" && git merge --ff-only --quiet "$SYNC" && git push --quiet origin "$DEPLOYED" >>"$LOG" 2>&1 || finish "STOP fast-forward push of $DEPLOYED failed" 1
for _ in {1..40}; do PRODUCTION="$(deployment_url production)"; [[ -n "$PRODUCTION" ]] && break; sleep 30; done
if [[ -z "${PRODUCTION:-}" ]] || ! smoke "${MAILCHEAP_PRODUCTION_URL:-https://mailcheap.maiteam.ch}"; then
	# Instant rollback to the deployment that served before. The database is untouched: model changes never get here.
	[[ -n "$PREVIOUS" ]] && curl -s -X POST -H "Authorization: Bearer $VERCEL_TOKEN" "https://api.vercel.com/v9/projects/$VERCEL_PROJECT_ID/rollback/$PREVIOUS?teamId=$VERCEL_TEAM_ID" >>"$LOG" 2>&1
	finish "ROLLED BACK production smoke failed for ${SHA:0:7}; serving $PREVIOUS again" 1
fi
finish "promoted ${SHA:0:7} (upstream ${UPSTREAM:0:7}, $NEW commits, $TESTS)"
