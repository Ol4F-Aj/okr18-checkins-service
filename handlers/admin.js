// Lambda: admin-api. API Gateway sends every /api/admin request here.
// It has its own role (admin-role): list Cognito users and its own logs, nothing else.
const serverless = require('serverless-http');
const app = require('../adminApp');

module.exports.handler = serverless(app);   // Lambda handler setting: handlers/admin.handler
