#!/bin/zsh
# mailcheap's step in the existing weekly routine (ai.fragno.weekly-upstream-updates, FRA-26000 step 7). The routine
# runs this and records its one line; this runs scripts/maiteam/weekly-upstream-sync.sh in the sync worktree.
#
#   weekly-routine-step.sh --mode-file <file>
#
# The mode file holds one word: off (also when the file is missing), dry-run, push or promote. It stays off until
# FRA-26000's release gates are met; then promote is the standing weekly mode, with no per-run card. Settings come from
# ~/.config/mailcheap-sync/env (VERCEL_TEAM_ID, VERCEL_PROJECT_ID, MONGOD_PATH, MAILCHEAP_SYNC_WORKTREE); the Vercel
# token is read from the shared env file and never printed. Exit 0 for done or off, 1 for a stop, 2 for a failed rollback.

set -u
MODE_FILE=""
while (( $# )); do
	case "$1" in
		--mode-file) MODE_FILE="$2"; shift ;;
		*) print -u2 "unknown option $1"; exit 2 ;;
	esac
	shift
done
MODE="$( [[ -n "$MODE_FILE" && -f "$MODE_FILE" ]] && tr -d '[:space:]' <"$MODE_FILE" || print off)"
case "$MODE" in
	off) print -r -- "off (release gates pending)"; exit 0 ;;
	dry-run|push|promote) ;;
	*) print -r -- "STOP unknown mode '$MODE' in $MODE_FILE"; exit 1 ;;
esac

CONFIG="${MAILCHEAP_SYNC_CONFIG:-$HOME/.config/mailcheap-sync/env}"
[[ -f "$CONFIG" ]] && source "$CONFIG"
SHARED="${MAILCHEAP_SHARED_ENV:-$HOME/Projects/maiteam-ships/.shared/.env.shared}"
if [[ -z "${VERCEL_TOKEN:-}" && -f "$SHARED" ]]; then
	VERCEL_TOKEN="$(sed -n 's/^VERCEL_TOKEN=//p' "$SHARED" | head -1 | tr -d '"'"'"'"')"
fi
export VERCEL_TOKEN="${VERCEL_TOKEN:-}" VERCEL_TEAM_ID="${VERCEL_TEAM_ID:-}" VERCEL_PROJECT_ID="${VERCEL_PROJECT_ID:-}"
[[ -n "${MONGOD_PATH:-}" ]] && export MONGOD_PATH
WORKTREE="${MAILCHEAP_SYNC_WORKTREE:-$HOME/Projects/mailcheap-sync}"
SYNC="${MAILCHEAP_SYNC_SCRIPT:-$WORKTREE/scripts/maiteam/weekly-upstream-sync.sh}"
[[ -f "$SYNC" ]] || { print -r -- "STOP no sync script at $SYNC"; exit 1; }

OUT="$(mktemp)"
/bin/zsh "$SYNC" "--$MODE" --worktree "$WORKTREE" >"$OUT" 2>/dev/null
CODE=$?
LINE="$(tail -1 "$OUT")"
rm -f "$OUT"
print -r -- "${LINE#mailcheap: }"
exit "$CODE"
