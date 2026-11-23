// ---------------------------------------------------------------
// Talks to Key Results and Goals by direct Lambda invoke (TEAM-GUIDE 5, rule C1).
// Not over HTTP: kr-internal and goals-internal have no public route, and
// only roles that IAM allows (checkins-role) can call them.
//
//   kr-internal     { action: 'getKeyResult', krId }
//                   -> { found: true, userId, goalId, type, start, target, current, status } | { found: false }
//   goals-internal  { action: 'getGoalStatus', goalId }
//                   -> { found: true, userId, status, year } | { found: false }
// ---------------------------------------------------------------
const { LambdaClient, InvokeCommand } = require('@aws-sdk/client-lambda');

// Another service did not answer: the API turns this into 503 and changes nothing
class DependencyError extends Error {
    constructor(message) { super(message); this.name = 'DependencyError'; }
}

function createInvoker(functionName, label, client) {
    const lambda = client || new LambdaClient({});
    return async (payload) => {
        let res;
        try {
            res = await lambda.send(new InvokeCommand({
                FunctionName: functionName,
                Payload: Buffer.from(JSON.stringify(payload))
            }));
        } catch (error) {
            throw new DependencyError(`${label} could not be reached (${error.name}).`);
        }
        if (res.FunctionError) throw new DependencyError(`${label} failed (${res.FunctionError}).`);
        const out = JSON.parse(Buffer.from(res.Payload).toString('utf8'));
        if (out && out.error) throw new DependencyError(`${label} answered ${out.error}.`);
        return out;
    };
}

function createKrClient({ functionName = process.env.KR_INTERNAL_FUNCTION || 'kr-internal', client } = {}) {
    const call = createInvoker(functionName, 'Key Results', client);
    return { getKeyResult: (krId) => call({ action: 'getKeyResult', krId }) };
}

function createGoalsClient({ functionName = process.env.GOALS_INTERNAL_FUNCTION || 'goals-internal', client } = {}) {
    const call = createInvoker(functionName, 'Goals', client);
    return { getGoalStatus: (goalId) => call({ action: 'getGoalStatus', goalId }) };
}

module.exports = { createKrClient, createGoalsClient, DependencyError };
