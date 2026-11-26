# okr18-checkins-service

Team 18 OKR Tracker: the **Check-ins & Insights Service** (owner: Amr Hosni).
Users log progress on their key results (check-ins), attach evidence, get a weekly
digest email, and admins can manage users and see security events.

Built the same way as [okr18-goals-service](https://github.com/basharzin/okr18-goals-service).
What this service must provide is in section 5 of the
[Team Guide](https://github.com/basharzin/okr18-frontend/blob/main/docs/TEAM-GUIDE.md).

## Status

| Part | Status |
| --- | --- |
| Project layout, health route, token check (`src/auth.js` from Goals) | done |
| Rules C1, C2 (`src/rules.js`, tested) | done |
| Check-in routes, `CheckIns` table, publish `check-in.logged` | done |
| `scripts/deploy.sh` for Floci, `checkins-role`, end-to-end test | done |
| Undo (`check-in.undone`), queue `checkins-inbox` | next |
| Evidence uploads (S3 presigned POST, 2 MB, image/PDF) | to do |
| Weekly digest (SES + Scheduler, Mondays 08:00 Cairo) | to do |
| Admin API (`admin` group only) | to do |

## Rules

| Rule | Summary |
| --- | --- |
| C1 | Before logging: the key result must exist and be mine (else 404), its goal must be Active or AtRisk (else 409) |
| C2 | The value fits the key result: a number; percentage 0–100; milestone 0 or 1. Note optional, max 500 characters |

## Endpoints

| Method and path | Body | Success | Errors |
| --- | --- | --- | --- |
| GET /api/check-ins/health | | 200 `{status:"ok",service:"checkins"}` | |
| POST /api/check-ins | `{ krId, value, note? }` | 201 check-in, publishes `check-in.logged` | 400 VALIDATION_ERROR, 401, 404 KR_NOT_FOUND, 409 GOAL_NOT_ACTIVE, 413, 415, 503 |
| GET /api/check-ins?krId=KR-... | | 200 my check-ins for that key result, newest first | 400, 401 |

Check-in object: `checkInId` (`CI-<uuid>`), `userId` (from the token), `krId`, `goalId`, `value`,
`previousValue` (the key result's `current` before this check-in), `note`, `createdAt`.

503 DEPENDENCY_UNAVAILABLE means Key Results, Goals or the event topic did not answer; nothing was saved.

## Layout

```
app.js                 the Express app wired to AWS (no listen)
server.js              runs it on a PC: npm run dev  (port 3003)
handlers/api.js        Lambda checkins-api (API Gateway -> Express via serverless-http)
src/createApp.js       builds the Express app (log, CORS, JSON, login, routes, errors)
src/rules.js           business rules C1, C2, pure functions
src/checkinsController.js  request -> rules -> other services -> data -> event -> response
src/checkinsRepo.js    the only file that talks to DynamoDB (CheckIns)
src/internalClients.js calls kr-internal and goals-internal (direct Lambda invoke)
src/events.js          publishes to SNS okr-events
src/auth.js            Cognito token -> req.user (copied unchanged from Goals)
src/http.js            the team error shape
infra/iam/             checkins-role policy (least privilege) and Lambda trust policy
scripts/deploy.sh      creates or updates everything on Floci
scripts/zip-lambda.js  builds lambda.zip (no .env, no tests)
scripts/e2e.sh         end-to-end test on Floci through API Gateway with a real login
events/                saved Lambda events for testing
test/                  rules, endpoint and token tests (npm test)
test-support/fakes.js  in-memory DynamoDB, Key Results, Goals and SNS for the tests
```

## Run the tests

```
npm install
npm test
```

## Deploy to Floci

1. Docker Desktop running, Floci started (`okr18-frontend`: `docker compose -f infra/floci/docker-compose.yml up -d`).
2. Shared base done once (`okr18-frontend`: `bash infra/shared-setup.sh`), or simply run `bash infra/deploy-all.sh` there:
   it deploys this service too when this repo sits next to `okr18-frontend`.
3. From this folder in Git Bash: `bash scripts/deploy.sh`

The last step prints the health answer (200) and a request without login (401).
With Goals and Key Results deployed too, `bash scripts/e2e.sh` runs the whole flow:
check-in refused on a Draft goal (409), Activate, two check-ins, Key Results' `current` moves, Achieve.

## AWS services used here

Lambda (`checkins-api`), DynamoDB (table `CheckIns`, KMS-encrypted, indexes `krId-createdAt-index` and
`userId-createdAt-index`), API Gateway (4 routes on `okr18-api`), SNS (`check-in.logged` on `okr-events`),
CloudWatch Logs (kept 7 days), IAM (`checkins-role`: own table, publish to `okr-events`,
invoke only `kr-internal` and `goals-internal`, own logs).
