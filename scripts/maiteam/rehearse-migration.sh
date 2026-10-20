#!/bin/zsh
# P8 rehearsal on a copy, never on production (FRA-26000 step 3):
#   1. restore a mongodump archive of the old fork into a throwaway database (fork_copy),
#   2. migrate it into a fresh one (upstream_rehearsal) with scripts/maiteam/migrate-from-fork.mjs,
#   3. dump that, restore it into a third (upstream_restore) and compare: the restore proof.
# Everything runs in one mongo:7 container bound to 127.0.0.1 only, removed at the end. Reports hold counts and hashes.
#
#   scripts/maiteam/rehearse-migration.sh --dump <archive.gz> --source-db <name> --owner-email <email> --out <dir> \
#     [--mail-from <host>] [--archive-host <host>]
set -euo pipefail
IMAGE="mongo@sha256:c53852c00c23ca9f23fc39690350ffa9a80e3642fe8f96879726d8da0abe80a7" # mongo:7, tools 100.19.1
DUMP="" SOURCE_DB="" OWNER="" OUT="" MAIL_FROM="" ARCHIVE_HOST=""
while (( $# )); do
	case "$1" in
		--dump) DUMP="$2"; shift ;; --source-db) SOURCE_DB="$2"; shift ;; --owner-email) OWNER="$2"; shift ;;
		--out) OUT="$2"; shift ;; --mail-from) MAIL_FROM="$2"; shift ;; --archive-host) ARCHIVE_HOST="$2"; shift ;;
		*) print -u2 "unknown option $1"; exit 2 ;;
	esac
	shift
done
[[ -f "$DUMP" && -n "$SOURCE_DB" && -n "$OWNER" && -n "$OUT" ]] || { print -u2 "Usage: --dump <archive.gz> --source-db <name> --owner-email <email> --out <dir>"; exit 2; }
REPO="${0:A:h:h:h}"
mkdir -p "$OUT"
# Under $HOME, which Docker shares with its VM, private to the user, and removed on exit: a real dump holds personal data.
mkdir -p "$HOME/.cache/mailcheap-rehearsal" && chmod 700 "$HOME/.cache/mailcheap-rehearsal"
WORK="$(mktemp -d "$HOME/.cache/mailcheap-rehearsal/run.XXXXXX")"
cp "$DUMP" "$WORK/source.archive.gz"
PORT="$(/usr/bin/python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')"
NAME="mailcheap-rehearsal-$$"
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT
docker run -d --name "$NAME" -p "127.0.0.1:$PORT:27017" -v "$WORK:/work" "$IMAGE" --quiet >/dev/null
for _ in {1..60}; do docker exec "$NAME" mongosh --quiet --eval 'db.runCommand({ping:1}).ok' 2>/dev/null | grep -q 1 && break; sleep 1; done
URI="mongodb://127.0.0.1:$PORT"

docker exec "$NAME" mongorestore --quiet --archive=/work/source.archive.gz --gzip --nsFrom "$SOURCE_DB.*" --nsTo "fork_copy.*"
COMPARE_URI="$URI" node "$REPO/scripts/maiteam/compare-databases.mjs" fork_copy fork_copy >"$OUT/1-source-copy.json" || true

MIGRATE_SOURCE_URI="$URI/fork_copy" MIGRATE_TARGET_URI="$URI/upstream_rehearsal" node "$REPO/scripts/maiteam/migrate-from-fork.mjs" \
	--owner-email "$OWNER" ${MAIL_FROM:+--mail-from "$MAIL_FROM"} ${ARCHIVE_HOST:+--archive-host "$ARCHIVE_HOST"} --execute --report "$OUT/2-migration.json" >/dev/null
docker exec "$NAME" mongodump --quiet --db upstream_rehearsal --archive=/work/upstream.archive.gz --gzip
docker exec "$NAME" mongorestore --quiet --archive=/work/upstream.archive.gz --gzip --nsFrom "upstream_rehearsal.*" --nsTo "upstream_restore.*"
COMPARE_URI="$URI" node "$REPO/scripts/maiteam/compare-databases.mjs" upstream_rehearsal upstream_restore >"$OUT/3-restore-proof.json"
shasum -a 256 "$OUT"/*.json >"$OUT/SHA256SUMS"
/usr/bin/python3 - "$OUT" <<'PY'
import json, sys, os
out = sys.argv[1]
m = json.load(open(os.path.join(out, "2-migration.json")))
r = json.load(open(os.path.join(out, "3-restore-proof.json")))
mismatch = [k for k, v in m["collections"].items() if v.get("target") != v.get("source")]
print(json.dumps({"migrationChecksOk": m["checks"].get("ok"), "countMismatches": mismatch, "restoreSame": r["same"], "problems": m["problems"]}))
PY
