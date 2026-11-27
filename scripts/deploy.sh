#!/usr/bin/env bash
# ---------------------------------------------------------------
# Deploy the Check-ins Service to Floci (or real AWS: change the profile).
# Safe to run again: it creates what is missing and updates the rest.
# Run from this repo's folder in Git Bash:   bash scripts/deploy.sh
#
# Needs the shared base first (okr18-frontend: bash infra/shared-setup.sh),
# which writes the ids this script reads (API, topic, Cognito).
# ---------------------------------------------------------------
set -euo pipefail
export AWS_PROFILE="${AWS_PROFILE:-floci}" AWS_PAGER="" MSYS_NO_PATHCONV=1
REGION="${AWS_REGION:-us-east-1}"
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
SHARED_VARS="${SHARED_VARS:-../okr18-frontend/infra/okr18-vars.sh}"

TABLE=CheckIns
ROLE=checkins-role
ADMIN_ROLE=admin-role
FN_API=checkins-api
FN_ADMIN=admin-api
KR_FN=kr-internal
GOALS_FN=goals-internal

if [ -f "$SHARED_VARS" ]; then
  # shellcheck source=/dev/null
  source "$SHARED_VARS"
  echo "Shared base: $SHARED_VARS"
else
  echo "WARNING: $SHARED_VARS not found. Run the shared setup first; deploying without API routes or events."
fi

# The policies are written for Floci's account 000000000000; swap in the real account, region and user pool
policy_file() {
  sed "s/000000000000/$ACCOUNT/g; s/us-east-1/$REGION/g; s/USER_POOL_ID/${COGNITO_USER_POOL_ID:-none}/g" "$1" > "out/$(basename "$1")"
  echo "file://out/$(basename "$1")"
}
mkdir -p out

echo "1/6 DynamoDB table $TABLE (+ indexes krId-createdAt-index, userId-createdAt-index, KMS encryption)"
if ! aws dynamodb describe-table --table-name $TABLE > /dev/null 2>&1; then
  aws dynamodb create-table --table-name $TABLE \
    --attribute-definitions AttributeName=checkInId,AttributeType=S AttributeName=krId,AttributeType=S \
      AttributeName=userId,AttributeType=S AttributeName=createdAt,AttributeType=S \
    --key-schema AttributeName=checkInId,KeyType=HASH \
    --global-secondary-indexes \
      "IndexName=krId-createdAt-index,KeySchema=[{AttributeName=krId,KeyType=HASH},{AttributeName=createdAt,KeyType=RANGE}],Projection={ProjectionType=ALL}" \
      "IndexName=userId-createdAt-index,KeySchema=[{AttributeName=userId,KeyType=HASH},{AttributeName=createdAt,KeyType=RANGE}],Projection={ProjectionType=ALL}" \
    --billing-mode PAY_PER_REQUEST \
    --sse-specification Enabled=true,SSEType=KMS > /dev/null
  aws dynamodb wait table-exists --table-name $TABLE
fi

echo "2/6 IAM: $ROLE (own table, publish to okr-events, invoke kr-internal and goals-internal, own logs)"
echo "         $ADMIN_ROLE (list Cognito users of okr18-users, own logs: nothing else)"
ensure_role() {   # role policy-name policy-file
  aws iam get-role --role-name "$1" > /dev/null 2>&1 || \
    aws iam create-role --role-name "$1" --assume-role-policy-document file://infra/iam/trust-policy.json > /dev/null
  aws iam put-role-policy --role-name "$1" --policy-name "$2" --policy-document "$(policy_file "$3")"
}
ensure_role $ROLE checkins-access infra/iam/checkins-policy.json
ensure_role $ADMIN_ROLE admin-access infra/iam/admin-policy.json

echo "3/6 Install and zip"
npm install --omit=dev --no-audit --no-fund --loglevel=error
npm run zip --silent

# Lambda environment variables as a JSON file: the CLI's short form breaks on values that
# contain commas (CORS_ORIGINS has two addresses), JSON does not.
write_env() {   # file KEY=VALUE ...  ->  out/<file>
  local file=$1; shift
  node -e 'const v={};for(const kv of process.argv.slice(2)){const i=kv.indexOf("=");v[kv.slice(0,i)]=kv.slice(i+1);}require("fs").writeFileSync("out/"+process.argv[1],JSON.stringify({Variables:v}));' "$file" "$@"
}
COMMON_ENV=(NODE_ENV=production
  "COGNITO_ISSUER=${COGNITO_ISSUER:-}" "COGNITO_JWKS_URI=${COGNITO_JWKS_URI:-}" "COGNITO_CLIENT_ID=${COGNITO_CLIENT_ID:-}"
  "ALLOW_HTTP_JWKS=${ALLOW_HTTP_JWKS:-true}" "CORS_ORIGINS=${CORS_ORIGINS:-http://localhost:8080}"
  "RATE_LIMIT_MAX=${RATE_LIMIT_MAX:-60}")   # requests per IP per minute; raise only for a load test
write_env env.json "${COMMON_ENV[@]}" "CHECKINS_TABLE=$TABLE" "KR_INTERNAL_FUNCTION=$KR_FN" \
  "GOALS_INTERNAL_FUNCTION=$GOALS_FN" "EVENTS_TOPIC_ARN=${EVENTS_TOPIC_ARN:-}"
write_env admin-env.json "${COMMON_ENV[@]}" "COGNITO_USER_POOL_ID=${COGNITO_USER_POOL_ID:-}"

deploy_fn() {   # name handler role env-file
  if aws lambda get-function --function-name "$1" > /dev/null 2>&1; then
    aws lambda update-function-code --function-name "$1" --zip-file fileb://lambda.zip > /dev/null
    aws lambda wait function-updated-v2 --function-name "$1"
    aws lambda update-function-configuration --function-name "$1" --handler "$2" \
      --role "arn:aws:iam::$ACCOUNT:role/$3" --environment "file://out/$4" > /dev/null
  else
    aws lambda create-function --function-name "$1" --runtime nodejs24.x --handler "$2" \
      --role "arn:aws:iam::$ACCOUNT:role/$3" --zip-file fileb://lambda.zip --timeout 10 --memory-size 128 \
      --environment "file://out/$4" > /dev/null
  fi
  aws lambda wait function-active-v2 --function-name "$1"
  aws logs create-log-group --log-group-name "/aws/lambda/$1" > /dev/null 2>&1 || true
  aws logs put-retention-policy --log-group-name "/aws/lambda/$1" --retention-in-days 7 > /dev/null 2>&1 || true
  echo "   $1 ready"
}

echo "4/6 Lambda functions"
deploy_fn $FN_API handlers/api.handler $ROLE env.json
deploy_fn $FN_ADMIN handlers/admin.handler $ADMIN_ROLE admin-env.json

echo "5/6 API Gateway routes (each route reaches only its own Lambda)"
if [ -n "${API_ID:-}" ]; then
  EXISTING=$(aws apigatewayv2 get-routes --api-id "$API_ID" --query "Items[].RouteKey" --output text)
  integration_for() {   # function name -> integration id (created once)
    local arn="arn:aws:lambda:$REGION:$ACCOUNT:function:$1" id
    id=$(aws apigatewayv2 get-integrations --api-id "$API_ID" \
      --query "Items[?IntegrationUri=='$arn'].IntegrationId | [0]" --output text)
    if [ "$id" = "None" ] || [ -z "$id" ]; then
      id=$(aws apigatewayv2 create-integration --api-id "$API_ID" --integration-type AWS_PROXY \
        --payload-format-version 2.0 --integration-uri "$arn" --query IntegrationId --output text)
    fi
    aws lambda add-permission --function-name "$1" --statement-id "apigw-invoke-$1" \
      --action lambda:InvokeFunction --principal apigateway.amazonaws.com \
      --source-arn "arn:aws:execute-api:$REGION:$ACCOUNT:$API_ID/*" > /dev/null 2>&1 || true
    echo "$id"
  }
  add_route() {   # "METHOD path" protected(yes/no) integration-id
    if printf '%s\n' "$EXISTING" | tr '\t' '\n' | grep -Fxq "$1"; then return; fi   # exact match only
    if [ "$2" = yes ] && [ -n "${AUTHORIZER_ID:-}" ]; then
      aws apigatewayv2 create-route --api-id "$API_ID" --route-key "$1" --target "integrations/$3" \
        --authorization-type JWT --authorizer-id "$AUTHORIZER_ID" --query RouteKey --output text
    else
      aws apigatewayv2 create-route --api-id "$API_ID" --route-key "$1" --target "integrations/$3" \
        --query RouteKey --output text
    fi
  }
  API_INT=$(integration_for $FN_API)
  add_route "GET /api/check-ins/health" no "$API_INT"
  add_route "POST /api/check-ins" yes "$API_INT"
  add_route "GET /api/check-ins" yes "$API_INT"
  # CORS preflight: the browser asks OPTIONS first for requests with a token; Express cors() answers
  add_route "OPTIONS /api/check-ins" no "$API_INT"
  add_route "DELETE /api/check-ins/{checkInId}" yes "$API_INT"       # undo (rule C3)
  add_route "OPTIONS /api/check-ins/{checkInId}" no "$API_INT"

  ADMIN_INT=$(integration_for $FN_ADMIN)
  add_route "GET /api/admin/health" no "$ADMIN_INT"
  add_route "GET /api/admin/users" yes "$ADMIN_INT"
  add_route "OPTIONS /api/admin/users" no "$ADMIN_INT"
else
  echo "   skipped: API_ID unknown"
fi

echo "6/6 Smoke test: health of both Lambdas, and requests with no login (must be 401)"
smoke() {   # function event-file
  aws lambda invoke --function-name "$1" --payload "file://events/$2" \
    --cli-binary-format raw-in-base64-out "out/$2" > /dev/null
  cat "out/$2"; echo
}
smoke $FN_API 1-health.json
smoke $FN_API 2-no-login.json
smoke $FN_ADMIN 3-admin-health.json
smoke $FN_ADMIN 4-admin-no-login.json
echo "Done. Saved events to try: ls events/"
