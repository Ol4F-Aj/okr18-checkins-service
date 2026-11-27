// ---------------------------------------------------------------
// Builds the Check-ins Express app from its parts. app.js passes the
// real AWS-backed parts; the tests pass fakes.
// Order: log -> security headers -> CORS -> rate limit -> JSON only -> body (10 kB)
//        -> health -> login -> routes -> 404 -> errors
// ---------------------------------------------------------------
const express = require('express');
const cors = require('cors');
const { requireUser } = require('./auth');
const { sendError } = require('./http');
const { createCheckinsController } = require('./checkinsController');
const { DependencyError } = require('./internalClients');
const { securityHeaders, rateLimit } = require('./protect');

// Express 5 passes rejected promises from async handlers to the error handler
function createApp({ repo, kr, goals, events, verify, now, allowedOrigins = [], rateLimitMax }) {
    const app = express();
    app.disable('x-powered-by');

    // One log line per request. Never the body, never the token.
    app.use((req, res, next) => {
        const start = Date.now();
        res.on('finish', () => {
            console.log(JSON.stringify({
                service: 'checkins', method: req.method, path: req.originalUrl.split('?')[0],
                status: res.statusCode, ms: Date.now() - start, user: req.user?.id
            }));
        });
        next();
    });

    app.use(securityHeaders);                            // on every answer, errors too
    app.use(cors({ origin: allowedOrigins }));           // answers the browser's OPTIONS preflight itself
    app.use(rateLimit({ max: rateLimitMax, service: 'checkins' }));   // 429 after the limit (per IP, 60 s)

    // Bodies must be JSON: anything else on POST/PATCH is 415
    app.use((req, res, next) => {
        if ((req.method === 'POST' || req.method === 'PATCH') && !req.is('application/json')) {
            return sendError(res, 415, 'UNSUPPORTED_MEDIA_TYPE', 'Send the body as application/json.');
        }
        next();
    });
    app.use(express.json({ limit: '10kb' }));

    // Public: lets deploy.sh and the team check the Lambda is alive
    app.get('/api/check-ins/health', (req, res) => res.status(200).json({ status: 'ok', service: 'checkins' }));

    const checkins = createCheckinsController({ repo, kr, goals, events, now });
    const router = express.Router();
    router.use(requireUser(verify));                     // every route below needs a login
    router.post('/check-ins', checkins.logCheckIn);
    router.get('/check-ins', checkins.listCheckIns);
    router.delete('/check-ins/:checkInId', checkins.undoCheckIn);
    app.use('/api', router);

    app.use((req, res) => sendError(res, 404, 'ROUTE_NOT_FOUND', 'Route not found.'));

    // eslint-disable-next-line no-unused-vars
    app.use((error, req, res, next) => {
        if (error.type === 'entity.parse.failed') return sendError(res, 400, 'VALIDATION_ERROR', 'Request body is not valid JSON.');
        if (error.type === 'entity.too.large') return sendError(res, 413, 'PAYLOAD_TOO_LARGE', 'Request body is too large.');
        if (error instanceof DependencyError) {
            console.error(JSON.stringify({ service: 'checkins', dependency: error.message }));
            return sendError(res, 503, 'DEPENDENCY_UNAVAILABLE', 'Another service is not answering. Try again shortly.');
        }
        console.error(error);
        return sendError(res, 500, 'INTERNAL_ERROR', 'An unexpected server error occurred.');
    });

    return app;
}

module.exports = { createApp };
