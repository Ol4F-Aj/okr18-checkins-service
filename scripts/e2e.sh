#!/usr/bin/env bash
# ---------------------------------------------------------------
# End-to-end test on Floci, through API Gateway, with a real Cognito login:
#   goal (Draft) -> key result -> check-in refused (C1, 409)
#   -> Activate -> two check-ins (201) -> Key Results' current moves (events)
#   -> history -> Achieve
# Needs Goals, Key Results and Check-ins deployed (okr18-frontend: bash infra/deploy-all.sh).
# Run from this repo's folder in Git Bash:   bash scripts/e2e.sh
# ---------------------------------------------------------------
set -euo pipefail
export AWS_PROFILE="${AWS_PROFILE:-floci}" AWS_PAGER="" MSYS_NO_PATHCONV=1
source "${SHARED_VARS:-../okr18-frontend/infra/okr18-vars.sh}"

# A throw-away test user; the password is made up on each run and never saved
USER_EMAIL="e2e-checkins@okr18.test"
PASSWORD="E2e$(date +%s)Test$RANDOM"
aws cognito-idp admin-create-user --user-pool-id "$COGNITO_USER_POOL_ID" --username "$USER_EMAIL" --message-action SUPPRESS > /dev/null 2>&1 || true
aws cognito-idp admin-set-user-password --user-pool-id "$COGNITO_USER_POOL_ID" --username "$USER_EMAIL" --password "$PASSWORD" --permanent
TOKEN=$(aws cognito-idp initiate-auth --client-id "$COGNITO_CLIENT_ID" --auth-flow USER_PASSWORD_AUTH \
  --auth-parameters "USERNAME=$USER_EMAIL,PASSWORD=$PASSWORD" --query AuthenticationResult.AccessToken --output text)

api() {   # METHOD path [json]
  curl -s -X "$1" "$API_URL$2" -H "authorization: Bearer $TOKEN" -H "content-type: application/json" ${3:+-d "$3"}
}
field() { node -pe "const o=JSON.parse(require('fs').readFileSync(0)); $1"; }

YEAR=$(date +%Y)
GOAL_ID=$(api POST /api/goals "{\"title\":\"E2E check-ins\",\"category\":\"Health\",\"year\":$YEAR,\"deadline\":\"$YEAR-12-31\"}" | field o.goalId)
KR_ID=$(api POST "/api/goals/$GOAL_ID/key-results" '{"title":"Run 10 km","type":"number","unit":"km","start":0,"target":10}' | field o.krId)
echo "goal $GOAL_ID, key result $KR_ID"

echo "1. check-in while the goal is Draft (C1: expect 409 GOAL_NOT_ACTIVE)"
api POST /api/check-ins "{\"krId\":\"$KR_ID\",\"value\":3}" | field 'o.error ? o.error.code : "UNEXPECTED " + JSON.stringify(o)'

echo "2. activate the goal"
api POST "/api/goals/$GOAL_ID/transitions" '{"to":"Active"}' | field o.status

echo "3. two check-ins: 4 then 10 (expect previousValue 0 then 4)"
api POST /api/check-ins "{\"krId\":\"$KR_ID\",\"value\":4,\"note\":\"first run\"}" | field 'o.previousValue + " -> " + o.value'
api POST /api/check-ins "{\"krId\":\"$KR_ID\",\"value\":10}" | field 'o.previousValue + " -> " + o.value'

echo "4. key result after the events reach Key Results (expect current 10, Completed)"
sleep 6
api GET "/api/key-results/$KR_ID" | field 'JSON.stringify({ current: o.current, status: o.status, progress: o.progress })'

echo "5. history, newest first"
api GET "/api/check-ins?krId=$KR_ID" | field 'o.map((c) => c.previousValue + " -> " + c.value).join(", ")'

echo "6. achieve the goal (needs 100%: expect Achieved)"
api POST "/api/goals/$GOAL_ID/transitions" '{"to":"Achieved"}' | field 'o.status || JSON.stringify(o)'
