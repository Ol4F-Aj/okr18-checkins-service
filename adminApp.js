// ---------------------------------------------------------------
// The real Admin app: createAdminApp connected to Cognito.
// handlers/admin.js runs it on Lambda (admin-api) behind API Gateway.
// ---------------------------------------------------------------
require('dotenv').config({ quiet: true });

const { createAdminApp } = require('./src/createAdminApp');
const { createUsersDirectory } = require('./src/usersDirectory');
const { createVerifier } = require('./src/auth');

const allowedOrigins = (process.env.CORS_ORIGINS || 'http://localhost:8080')
    .split(',').map((o) => o.trim()).filter(Boolean);

module.exports = createAdminApp({
    directory: createUsersDirectory(),
    verify: createVerifier(),
    allowedOrigins
});
