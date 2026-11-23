// In-memory stand-ins for DynamoDB, kr-internal, goals-internal and SNS,
// with the same methods and answers as the real ones.
const { DependencyError } = require('../src/internalClients');

function fakeRepo() {
    const rows = new Map();
    const copy = (x) => (x ? structuredClone(x) : null);
    return {
        rows,
        async create(c) { rows.set(c.checkInId, copy(c)); return c; },
        async remove(id) { rows.delete(id); },
        async listByKr(krId, userId) {
            return [...rows.values()].filter((c) => c.krId === krId && c.userId === userId)
                .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(copy);
        }
    };
}

// state.krs[krId] = what kr-internal knows; state.down = Key Results not answering
function fakeKr() {
    const state = { krs: {}, down: false };
    return {
        state,
        async getKeyResult(krId) {
            if (state.down) throw new DependencyError('Key Results could not be reached (test).');
            const kr = state.krs[krId];
            return kr ? { found: true, ...kr } : { found: false };
        }
    };
}

// state.goals[goalId] = { userId, status, year }
function fakeGoals() {
    const state = { goals: {}, down: false };
    return {
        state,
        async getGoalStatus(goalId) {
            if (state.down) throw new DependencyError('Goals could not be reached (test).');
            const g = state.goals[goalId];
            return g ? { found: true, ...g } : { found: false };
        }
    };
}

function fakeEvents() {
    const state = { sent: [], down: false };
    return {
        state,
        sent: state.sent,
        async publish(type, userId, data) {
            if (state.down) { const e = new Error('SNS down (test)'); e.name = 'NetworkError'; throw e; }
            state.sent.push({ type, userId, data });
        }
    };
}

// Token "token-<name>" belongs to user <name>; anything else is rejected
async function fakeVerify(token) {
    const m = /^token-(\w+)$/.exec(token);
    if (!m) throw new Error('bad token');
    return { sub: `user-${m[1]}`, 'cognito:groups': ['user'] };
}

module.exports = { fakeRepo, fakeKr, fakeGoals, fakeEvents, fakeVerify };
