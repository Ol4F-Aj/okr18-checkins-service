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
FN_API=checkins-api
KR_FN=kr-internal
GOALS_FN=goals-internal

if [ -f "$SHARED_VARS" ]; then
  # shellcheck source=/dev/null
  source "$SHARED_VARS"
  echo "Shared base: $SHARED_VARS"
else
  echo "WARNING: $SHARED_VARS not found. Run the shared setup first; deploying without API routes or events."
fi

# The policies are written for Floci's account 000000000000; swap in the real one if different
policy_file() { sed "s/000000000000/$ACCOUNT/g; s/us-east-1/$REGION/g" "$1" > "out/$(basename "$1")"; echo "file://out/$(basename "$1")"; }
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
aws iam get-role --role-name $ROLE > /dev/null 2>&1 || \
  aws iam create-role --role-name $ROLE --assume-role-policy-document file://infra/iam/trust-policy.json > /dev/null
aws iam put-role-policy --role-name $ROLE --policy-name checkins-access --policy-document "$(policy_file infra/iam/checkins-policy.json)"
ROLE_ARN="arn:aws:iam::$ACCOUNT:role/$ROLE"

echo "3/6 Install and zip"
npm install --omit=dev --no-audit --no-fund --loglevel=error
npm run zip --silent

# Lambda environment variables as a JSON file: the CLI's short form breaks on values that
# contain commas (CORS_ORIGINS has two addresses), JSON does not.
write_env() {   # KEY=VALUE ...  ->  out/env.json
  node -e 'const v={};for(const kv of process.argv.slice(1)){const i=kv.indexOf("=");v[kv.slice(0,i)]=kv.slice(i+1);}require("fs").writeFileSync("out/env.json",JSON.stringify({Variables:v}));' "$@"
}
write_env NODE_ENV=production "CHECKINS_TABLE=$TABLE" "KR_INTERNAL_FUNCTION=$KR_FN" "GOALS_INTERNAL_FUNCTION=$GOALS_FN" \
  "EVENTS_TOPIC_ARN=${EVENTS_TOPIC_ARN:-}" \
  "COGNITO_ISSUER=${COGNITO_ISSUER:-}" "COGNITO_JWKS_URI=${COGNITO_JWKS_URI:-}" "COGNITO_CLIENT_ID=${COGNITO_CLIENT_ID:-}" \
  "ALLOW_HTTP_JWKS=${ALLOW_HTTP_JWKS:-true}" "CORS_ORIGINS=${CORS_ORIGINS:-http://localhost:8080}" \
  "RATE_LIMIT_MAX=${RATE_LIMIT_MAX:-60}"   # requests per IP per minute; raise only for a load test

deploy_fn() {   # name handler
  if aws lambda get-function --function-name "$1" > /dev/null 2>&1; then
    aws lambda update-function-code --function-name "$1" --zip-file fileb://lambda.zip > /dev/null
    aws lambda wait function-updated-v2 --function-name "$1"
    aws lambda update-function-configuration --function-name "$1" --handler "$2" --environment file://out/env.json > /dev/null
  else
    aws lambda create-function --function-name "$1" --runtime nodejs24.x --handler "$2" \
      --role "$ROLE_ARN" --zip-file fileb://lambda.zip --timeout 10 --memory-size 128 \
      --environment file://out/env.json > /dev/null
  fi
  aws lambda wait function-active-v2 --function-name "$1"
  aws logs create-log-group --log-group-name "/aws/lambda/$1" > /dev/null 2>&1 || true
  aws logs put-retention-policy --log-group-name "/aws/lambda/$1" --retention-in-days 7 > /dev/null 2>&1 || true
  echo "   $1 ready"
}

echo "4/6 Lambda functions"
deploy_fn $FN_API handlers/api.handler

echo "5/6 API Gateway routes (only these reach checkins-api)"
if [ -n "${API_ID:-}" ]; then
  FN_ARN="arn:aws:lambda:$REGION:$ACCOUNT:function:$FN_API"
  INTEGRATION_ID=$(aws apigatewayv2 get-integrations --api-id "$API_ID" \
    --query "Items[?IntegrationUri=='$FN_ARN'].IntegrationId | [0]" --output text)
  if [ "$INTEGRATION_ID" = "None" ] || [ -z "$INTEGRATION_ID" ]; then
    INTEGRATION_ID=$(aws apigatewayv2 create-integration --api-id "$API_ID" --integration-type AWS_PROXY \
      --payload-format-version 2.0 --integration-uri "$FN_ARN" --query IntegrationId --output text)
  fi
  EXISTING=$(aws apigatewayv2 get-routes --api-id "$API_ID" --query "Items[].RouteKey" --output text)
  add_route() {   # "METHOD path" protected(yes/no)
    if printf '%s\n' "$EXISTING" | tr '\t' '\n' | grep -Fxq "$1"; then return; fi   # exact match only
    if [ "$2" = yes ] && [ -n "${AUTHORIZER_ID:-}" ]; then
      aws apigatewayv2 create-route --api-id "$API_ID" --route-key "$1" --target "integrations/$INTEGRATION_ID" \
        --authorization-type JWT --authorizer-id "$AUTHORIZER_ID" --query RouteKey --output text
    else
      aws apigatewayv2 create-route --api-id "$API_ID" --route-key "$1" --target "integrations/$INTEGRATION_ID" \
        --query RouteKey --output text
    fi
  }
  add_route "GET /api/check-ins/health" no
  add_route "POST /api/check-ins" yes
  add_route "GET /api/check-ins" yes
  # CORS preflight: the browser asks OPTIONS first for requests with a token; Express cors() answers
  add_route "OPTIONS /api/check-ins" no
  aws lambda add-permission --function-name $FN_API --statement-id apigw-invoke-checkins \
    --action lambda:InvokeFunction --principal apigateway.amazonaws.com \
    --source-arn "arn:aws:execute-api:$REGION:$ACCOUNT:$API_ID/*" > /dev/null 2>&1 || true
else
  echo "   skipped: API_ID unknown"
fi

echo "6/6 Smoke test: health through checkins-api, and a request with no login (must be 401)"
aws lambda invoke --function-name $FN_API --payload file://events/1-health.json \
  --cli-binary-format raw-in-base64-out out/health.json > /dev/null
cat out/health.json; echo
aws lambda invoke --function-name $FN_API --payload file://events/2-no-login.json \
  --cli-binary-format raw-in-base64-out out/no-login.json > /dev/null
cat out/no-login.json; echo
echo "Done. Saved events to try: ls events/"
