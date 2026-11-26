# Saved events

Try the Lambdas without the website (Lab 7 style):

| File | Lambda | What it does |
| --- | --- | --- |
| `1-health.json` | checkins-api | API Gateway event (payload 2.0) for `GET /api/check-ins/health`: answers 200 |
| `2-no-login.json` | checkins-api | `GET /api/check-ins` with no token: answers 401 |
| `3-admin-health.json` | admin-api | `GET /api/admin/health`: answers 200 |
| `4-admin-no-login.json` | admin-api | `GET /api/admin/users` with no token: answers 401 |

    aws lambda invoke --function-name checkins-api --payload file://events/1-health.json \
      --cli-binary-format raw-in-base64-out out/r.json && cat out/r.json
