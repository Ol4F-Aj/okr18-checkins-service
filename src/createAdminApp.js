// ---------------------------------------------------------------
// Builds the Admin Express app (Lambda admin-api). Same order as the
// check-ins app: log -> security headers -> CORS -> rate limit -> health
// -> login -> admin group -> routes -> 404 -> errors
//
// Who is admin comes ONLY from the verified token's cognito:groups.
// A role in the body, the query or a header is never read (test ST4).
// ---------------------------------------------------------------
const express = require('express');
const cors = require('cors');
const { requireUser } = require('./auth');
const { sendError } = require('./http');
const { DependencyError } = require('./internalClients');
const { securityHeaders, rateLimit } = require('./protect');

// Logged in, but not in the admin group: 403, and a security line the team can count
function requireAdmin(req, res, next) {
    if (req.user.groups.includes('admin')) return next();
    console.log(JSON.stringify({
        service: 'admin', security: 'forbidden', user: req.user.id, method: req.method, path: req.originalUrl.split('?')[0]
    }));
    return sendError(res, 403, 'FORBIDDEN', 'Only an admin can do this.');
}

function createAdminApp({ directory, verify, allowedOrigins = [], rateLimitMax }) {
    const app = express();
    app.disable('x-powered-by');

    // One log line per request. Never the body, never the token, never an email.
    app.use((req, res, next) => {
        const start = Date.now();
        res.on('finish', () => {
            console.log(JSON.stringify({
                service: 'admin', method: req.method, path: req.originalUrl.split('?')[0],
                status: res.statusCode, ms: Date.now() - start, user: req.user?.id
            }));
        });
        next();
    });

    app.use(securityHeaders);
    app.use(cors({ origin: allowedOrigins }));
    app.use(rateLimit({ max: rateLimitMax, service: 'admin' }));

    app.get('/api/admin/health', (req, res) => res.status(200).json({ status: 'ok', service: 'admin' }));

    const router = express.Router();
    router.use(requireUser(verify));                     // 401 without a valid token
    router.use(requireAdmin);                            // 403 for a normal user

    // Accounts only: id, email, status, admin or not. No goals, no check-ins.
    router.get('/users', async (req, res) => {
        const users = await directory.listUsers();
        res.status(200).json({ count: users.length, users });
    });
    app.use('/api/admin', router);

    app.use((req, res) => sendError(res, 404, 'ROUTE_NOT_FOUND', 'Route not found.'));

    // eslint-disable-next-line no-unused-vars
    app.use((error, req, res, next) => {
        if (error instanceof DependencyError) {
            console.error(JSON.stringify({ service: 'admin', dependency: error.message }));
            return sendError(res, 503, 'DEPENDENCY_UNAVAILABLE', 'Cognito is not answering. Try again shortly.');
        }
        console.error(error);
        return sendError(res, 500, 'INTERNAL_ERROR', 'An unexpected server error occurred.');
    });

    return app;
}

module.exports = { createAdminApp, requireAdmin };
