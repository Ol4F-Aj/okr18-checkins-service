// The one error shape every Team 18 service answers with:
// { "error": { "code": "SOME_CODE", "message": "Human sentence." } }
function sendError(res, status, code, message) {
    return res.status(status).json({ error: { code, message } });
}

module.exports = { sendError };
