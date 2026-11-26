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
    // "token-admin" is in the admin group, like a user added with admin-add-user-to-group
    return { sub: `user-${m[1]}`, 'cognito:groups': m[1] === 'admin' ? ['user', 'admin'] : ['user'] };
}

// Stand-in for Cognito's user list (state.down = Cognito not answering)
function fakeDirectory() {
    const state = {
        down: false,
        users: [
            { userId: 'user-a', email: 'a@okr18.test', status: 'CONFIRMED', enabled: true, admin: false, createdAt: '2026-11-01T10:00:00.000Z' },
            { userId: 'user-admin', email: 'admin@okr18.test', status: 'CONFIRMED', enabled: true, admin: true, createdAt: '2026-11-02T10:00:00.000Z' }
        ]
    };
    return {
        state,
        async listUsers() {
            if (state.down) throw new DependencyError('Cognito could not be reached (test).');
            return structuredClone(state.users);
        }
    };
}

module.exports = { fakeRepo, fakeKr, fakeGoals, fakeEvents, fakeVerify, fakeDirectory };
