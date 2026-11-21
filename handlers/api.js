// Lambda: checkins-api. API Gateway sends every check-ins request here.
// serverless-http turns the Lambda event into an Express request and back.
const serverless = require('serverless-http');
const app = require('../app');

module.exports.handler = serverless(app);   // Lambda handler setting: handlers/api.handler
