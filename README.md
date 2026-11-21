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
| Rule C1 + check-in routes (`CheckIns` table) | next |
| Events `check-in.logged` / `check-in.undone`, queue `checkins-inbox` | to do |
| Evidence uploads (S3 presigned POST, 2 MB, image/PDF) | to do |
| Weekly digest (SES + Scheduler, Mondays 08:00 Cairo) | to do |
| Admin API (`admin` group only) | to do |
| `scripts/deploy.sh` for Floci | to do |

## Layout

```
app.js                 the Express app wired to AWS (no listen)
server.js              runs it on a PC: npm run dev  (port 3003)
handlers/api.js        Lambda checkins-api (API Gateway -> Express via serverless-http)
src/createApp.js       builds the Express app (log, CORS, JSON, login, routes, errors)
src/auth.js            Cognito token -> req.user (copied unchanged from Goals)
src/http.js            the team error shape
test/                  endpoint and token tests (npm test)
```

## Run the tests

```
npm install
npm test
```
