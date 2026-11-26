#!/usr/bin/env bash
# ---------------------------------------------------------------
# Security test ST4 on Floci, through API Gateway with real Cognito logins:
#   no token -> 401, normal user -> 403, normal user sending role=admin -> still 403,
#   admin user -> 200 with the accounts (no goals).
# Two throw-away users are made and deleted again; passwords are random and never saved.
# Run from this repo's folder in Git Bash:   bash scripts/st4.sh
# ---------------------------------------------------------------
set -euo pipefail
export AWS_PROFILE="${AWS_PROFILE:-floci}" AWS_PAGER="" MSYS_NO_PATHCONV=1
source "${SHARED_VARS:-../okr18-frontend/infra/okr18-vars.sh}"

NORMAL="st4-user@okr18.test"
ADMIN="st4-admin@okr18.test"
login() {   # email -> access token
  local pass="St4$(date +%s)Pw$RANDOM"
  aws cognito-idp admin-create-user --user-pool-id "$COGNITO_USER_POOL_ID" --username "$1" --message-action SUPPRESS > /dev/null 2>&1 || true
  aws cognito-idp admin-set-user-password --user-pool-id "$COGNITO_USER_POOL_ID" --username "$1" --password "$pass" --permanent
  aws cognito-idp initiate-auth --client-id "$COGNITO_CLIENT_ID" --auth-flow USER_PASSWORD_AUTH \
    --auth-parameters "USERNAME=$1,PASSWORD=$pass" --query AuthenticationResult.AccessToken --output text
}
cleanup() {
  for u in "$NORMAL" "$ADMIN"; do
    aws cognito-idp admin-delete-user --user-pool-id "$COGNITO_USER_POOL_ID" --username "$u" > /dev/null 2>&1 || true
  done
}
trap cleanup EXIT

USER_TOKEN=$(login "$NORMAL")
aws cognito-idp admin-create-user --user-pool-id "$COGNITO_USER_POOL_ID" --username "$ADMIN" --message-action SUPPRESS > /dev/null 2>&1 || true
aws cognito-idp admin-add-user-to-group --user-pool-id "$COGNITO_USER_POOL_ID" --username "$ADMIN" --group-name admin
ADMIN_TOKEN=$(login "$ADMIN")      # log in after joining the group: the group is read from the new token

status() { curl -s -o /dev/null -w "%{http_code}" "$@"; }
check() {   # name expected actual
  if [ "$2" = "$3" ]; then echo "PASS  $1: $3"; else echo "FAIL  $1: expected $2, got $3"; FAILED=1; fi
}
FAILED=0
URL="$API_URL/api/admin/users"

check "ST4a no token" 401 "$(status "$URL")"
check "ST4b normal user" 403 "$(status "$URL" -H "authorization: Bearer $USER_TOKEN")"
check "ST4c normal user with ?role=admin" 403 "$(status "$URL?role=admin&groups=admin" -H "authorization: Bearer $USER_TOKEN")"
check "ST4d normal user with X-Role: admin" 403 "$(status "$URL" -H "authorization: Bearer $USER_TOKEN" -H "x-role: admin")"
# A body with role=admin sent to an API the user can reach: it is never read as a role
SENT=$(status -X POST "$API_URL/api/check-ins" -H "authorization: Bearer $USER_TOKEN" -H "content-type: application/json" \
  -d '{"role":"admin","cognito:groups":["admin"],"krId":"nope","value":1}' || true)
echo "      (sent a body with role=admin: answer $SENT)"
USER_GROUPS=$(aws cognito-idp admin-list-groups-for-user --user-pool-id "$COGNITO_USER_POOL_ID" --username "$NORMAL" \
  --query "Groups[].GroupName" --output text)
check "ST4e after sending {role:admin} in a body, user is still not admin" "no" "$(printf '%s' "$USER_GROUPS" | grep -qw admin && echo yes || echo no)"
check "ST4e ... and admin route still refused" 403 "$(status "$URL" -H "authorization: Bearer $USER_TOKEN")"
check "ST4f admin" 200 "$(status "$URL" -H "authorization: Bearer $ADMIN_TOKEN")"

echo "Admin's answer (accounts only, no goals):"
curl -s "$URL" -H "authorization: Bearer $ADMIN_TOKEN" | node -pe '
  const o = JSON.parse(require("fs").readFileSync(0));
  "  " + o.count + " accounts, fields: " + Object.keys(o.users[0] || {}).join(", ")'
exit $FAILED
