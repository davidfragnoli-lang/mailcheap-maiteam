# Sourced by scripts/maiteam/weekly-upstream-sync.sh (PATCHES.md, QA r1 item 6). Promotion and rollback through
# Vercel's API, each step read back before it counts: a request that returned an error, or a deployment that is READY
# but not what the production hostname serves, is a failure. Needs VERCEL_TOKEN, VERCEL_TEAM_ID and VERCEL_PROJECT_ID
# (team-scoped calls). VERCEL_API and the polling knobs exist for the failure-path tests.

VERCEL_API="${VERCEL_API:-https://api.vercel.com}"
RELEASE_POLLS="${RELEASE_POLLS:-40}"
RELEASE_SLEEP="${RELEASE_SLEEP:-30}"
RELEASE_PROBLEM=""

# vercel_call <METHOD> <path without teamId>: the body in VERCEL_REPLY; fails unless the answer is 2xx. Everything
# here runs in the calling shell, never in $(…), so RELEASE_PROBLEM reaches the summary line.
vercel_call() {
	# Not `path`: in zsh that is PATH.
	local method="$1" endpoint="$2" body code sep="?"
	[[ "$endpoint" == *\?* ]] && sep="&"
	body="$(mktemp)"
	code="$(curl -s -o "$body" -w '%{http_code}' --max-time 30 -X "$method" -H "Authorization: Bearer $VERCEL_TOKEN" "$VERCEL_API$endpoint${sep}teamId=$VERCEL_TEAM_ID")"
	VERCEL_REPLY="$(<"$body")"
	rm -f "$body"
	[[ "$code" == 2?? ]] || { RELEASE_PROBLEM="$method ${endpoint%%\?*} answered ${code:-no response}"; return 1; }
}

json_field() {
	/usr/bin/python3 -c 'import json,sys
try:
    value = json.load(sys.stdin)
    for key in sys.argv[1].split("."):
        value = value[int(key)] if isinstance(value, list) else value.get(key)
    print("" if value is None else value)
except Exception:
    print("")' "$1"
}

# The deployment the production hostname serves, read from its alias, in SERVED.
alias_deployment() {
	SERVED=""
	vercel_call GET "/v4/aliases/$1" || return 1
	SERVED="$(print -r -- "$VERCEL_REPLY" | json_field deploymentId)"
}

smoke() {
	[[ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$1/api/health")" == 200 ]]
}

# Before any promotion: the deployment production serves now is READY, built from the deployed branch's exact commit,
# and is what the hostname's alias points at. Sets PREVIOUS and PREVIOUS_SHA, the rollback target.
release_preflight() {
	local base="$1" host="$2" state
	PREVIOUS="" PREVIOUS_SHA=""
	[[ -n "${VERCEL_TOKEN:-}" && -n "${VERCEL_TEAM_ID:-}" && -n "${VERCEL_PROJECT_ID:-}" ]] || { RELEASE_PROBLEM="Vercel credentials or ids are missing"; return 1; }
	vercel_call GET "/v9/projects/$VERCEL_PROJECT_ID" || return 1
	PREVIOUS="$(print -r -- "$VERCEL_REPLY" | json_field targets.production.id)"
	[[ -n "$PREVIOUS" ]] || { RELEASE_PROBLEM="the project has no production deployment to roll back to"; return 1; }
	vercel_call GET "/v13/deployments/$PREVIOUS" || return 1
	state="$(print -r -- "$VERCEL_REPLY" | json_field readyState)"
	PREVIOUS_SHA="$(print -r -- "$VERCEL_REPLY" | json_field meta.githubCommitSha)"
	[[ "$state" == READY ]] || { RELEASE_PROBLEM="rollback target $PREVIOUS is $state, not READY"; return 1; }
	[[ "$PREVIOUS_SHA" == "$base" ]] || { RELEASE_PROBLEM="production serves ${PREVIOUS_SHA:0:7}, the deployed branch is at ${base:0:7}: source and deployment differ"; return 1; }
	alias_deployment "$host" || return 1
	[[ "$SERVED" == "$PREVIOUS" ]] || { RELEASE_PROBLEM="$host points at ${SERVED:-nothing}, not the production target $PREVIOUS"; return 1; }
}

# The READY deployment Vercel built from <sha> for <target>, waited for. Sets DEPLOYMENT_ID.
await_deployment() {
	local sha="$1" target="$2"
	DEPLOYMENT_ID=""
	for _ in {1..$RELEASE_POLLS}; do
		vercel_call GET "/v6/deployments?projectId=$VERCEL_PROJECT_ID&limit=20&target=$target" &&
			DEPLOYMENT_ID="$(print -r -- "$VERCEL_REPLY" | /usr/bin/python3 -c 'import json,sys
sha = sys.argv[1]
ready = [d for d in json.load(sys.stdin).get("deployments", []) if d.get("meta", {}).get("githubCommitSha") == sha and d.get("state") == "READY"]
print(ready[0]["uid"] if ready else "")' "$sha" 2>/dev/null)"
		[[ -n "$DEPLOYMENT_ID" ]] && return 0
		sleep "$RELEASE_SLEEP"
	done
	RELEASE_PROBLEM="no READY $target deployment for ${sha:0:7}"
	return 1
}

# The hostname serves <deployment>: its alias reads back to it and its health check answers 200.
await_serving() {
	local host="$1" deployment="$2" url="$3"
	for _ in {1..$RELEASE_POLLS}; do
		alias_deployment "$host" && [[ "$SERVED" == "$deployment" ]] && smoke "$url" && return 0
		sleep "$RELEASE_SLEEP"
	done
	RELEASE_PROBLEM="$host does not serve $deployment healthily (alias reads ${SERVED:-nothing})"
	return 1
}

# Instant rollback, counted only once the hostname reads back to the target and answers healthily.
rollback_to() {
	local deployment="$1" host="$2" url="$3"
	vercel_call POST "/v9/projects/$VERCEL_PROJECT_ID/rollback/$deployment" >/dev/null || return 1
	await_serving "$host" "$deployment" "$url"
}
