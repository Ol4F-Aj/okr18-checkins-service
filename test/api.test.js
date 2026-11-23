// Endpoint tests with fakes for DynamoDB, Key Results, Goals and SNS: no AWS needed
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/createApp');
const { fakeRepo, fakeKr, fakeGoals, fakeEvents, fakeVerify } = require('../test-support/fakes');

const KR1 = 'KR-11111111-1111-1111-1111-111111111111';
const KR2 = 'KR-22222222-2222-2222-2222-222222222222';

// A fresh world for each test: user "a" owns KR1 (goal G-1, Active)
function world() {
    const w = { repo: fakeRepo(), kr: fakeKr(), goals: fakeGoals(), events: fakeEvents() };
    w.kr.state.krs[KR1] = { userId: 'user-a', goalId: 'G-1', type: 'number', start: 0, target: 10, current: 2, status: 'Open' };
    w.goals.state.goals['G-1'] = { userId: 'user-a', status: 'Active', year: 2026 };
    w.app = createApp({ ...w, verify: fakeVerify, allowedOrigins: ['http://localhost:8080'] });
    return w;
}

async function call(app, method, path, { token, body, type = 'application/json' } = {}) {
    const server = app.listen(0);
    try {
        const headers = {};
        if (token) headers.authorization = `Bearer ${token}`;
        if (body !== undefined) headers['content-type'] = type;
        const payload = body === undefined || typeof body === 'string' ? body : JSON.stringify(body);
        const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method, headers, body: payload });
        return { status: res.status, body: await res.json() };
    } finally {
        server.close();
    }
}

test('health answers without a login', async () => {
    const res = await call(world().app, 'GET', '/api/check-ins/health');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { status: 'ok', service: 'checkins' });
});

test('no token or a bad token is 401 with the team error shape', async () => {
    const { app } = world();
    for (const token of [undefined, 'forged']) {
        const res = await call(app, 'GET', `/api/check-ins?krId=${KR1}`, { token });
        assert.equal(res.status, 401);
        assert.equal(res.body.error.code, 'UNAUTHENTICATED');
    }
});

test('unknown route is 404', async () => {
    const res = await call(world().app, 'GET', '/api/nothing-here', { token: 'token-a' });
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, 'ROUTE_NOT_FOUND');
});

test('non-JSON body is 415', async () => {
    const res = await call(world().app, 'POST', '/api/check-ins', { token: 'token-a', body: 'x=1', type: 'text/plain' });
    assert.equal(res.status, 415);
});

test('log a check-in: 201, saved, and check-in.logged published with previousValue', async () => {
    const w = world();
    const res = await call(w.app, 'POST', '/api/check-ins', { token: 'token-a', body: { krId: KR1, value: 5, note: 'Good week' } });
    assert.equal(res.status, 201);
    assert.match(res.body.checkInId, /^CI-/);
    assert.equal(res.body.userId, 'user-a');
    assert.equal(res.body.previousValue, 2);
    assert.equal(w.repo.rows.size, 1);
    assert.deepEqual(w.events.sent, [{ type: 'check-in.logged', userId: 'user-a', data: { krId: KR1, value: 5, previousValue: 2 } }]);
});

test('the owner comes from the token, never the body', async () => {
    const w = world();
    const res = await call(w.app, 'POST', '/api/check-ins', { token: 'token-a', body: { krId: KR1, value: 3, userId: 'user-evil' } });
    assert.equal(res.status, 201);
    assert.equal(res.body.userId, 'user-a');
});

test('C1: unknown key result is 404, nothing saved, no event', async () => {
    const w = world();
    const res = await call(w.app, 'POST', '/api/check-ins', { token: 'token-a', body: { krId: KR2, value: 5 } });
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, 'KR_NOT_FOUND');
    assert.equal(w.repo.rows.size, 0);
    assert.equal(w.events.sent.length, 0);
});

test('C1: another user\'s key result is 404', async () => {
    const w = world();
    const res = await call(w.app, 'POST', '/api/check-ins', { token: 'token-b', body: { krId: KR1, value: 5 } });
    assert.equal(res.status, 404);
    assert.equal(w.events.sent.length, 0);
});

test('C1: goal not Active or AtRisk is 409', async () => {
    for (const status of ['Draft', 'Achieved', 'Abandoned']) {
        const w = world();
        w.goals.state.goals['G-1'].status = status;
        const res = await call(w.app, 'POST', '/api/check-ins', { token: 'token-a', body: { krId: KR1, value: 5 } });
        assert.equal(res.status, 409, status);
        assert.equal(res.body.error.code, 'GOAL_NOT_ACTIVE');
        assert.equal(w.repo.rows.size, 0);
    }
});

test('C1: goal AtRisk is allowed', async () => {
    const w = world();
    w.goals.state.goals['G-1'].status = 'AtRisk';
    const res = await call(w.app, 'POST', '/api/check-ins', { token: 'token-a', body: { krId: KR1, value: 5 } });
    assert.equal(res.status, 201);
});

test('C2: bad value or bad krId is 400', async () => {
    const w = world();
    for (const body of [{ krId: KR1, value: 'five' }, { krId: KR1 }, { krId: 'nope', value: 1 }, { krId: KR1, value: 1, note: 'x'.repeat(501) }]) {
        const res = await call(w.app, 'POST', '/api/check-ins', { token: 'token-a', body });
        assert.equal(res.status, 400, JSON.stringify(body).slice(0, 60));
        assert.equal(res.body.error.code, 'VALIDATION_ERROR');
    }
    assert.equal(w.repo.rows.size, 0);
});

test('Key Results or Goals down is 503 and nothing is saved', async () => {
    for (const who of ['kr', 'goals']) {
        const w = world();
        w[who].state.down = true;
        const res = await call(w.app, 'POST', '/api/check-ins', { token: 'token-a', body: { krId: KR1, value: 5 } });
        assert.equal(res.status, 503, who);
        assert.equal(res.body.error.code, 'DEPENDENCY_UNAVAILABLE');
        assert.equal(w.repo.rows.size, 0);
    }
});

test('event cannot be published: 503 and the check-in is taken back', async () => {
    const w = world();
    w.events.state.down = true;
    const res = await call(w.app, 'POST', '/api/check-ins', { token: 'token-a', body: { krId: KR1, value: 5 } });
    assert.equal(res.status, 503);
    assert.equal(w.repo.rows.size, 0);
});

test('history: my check-ins newest first, another user sees none', async () => {
    let t = 0;
    const w = world();
    w.app = createApp({ ...w, verify: fakeVerify, now: () => new Date(Date.UTC(2026, 10, 1) + (t += 60000)) });
    await call(w.app, 'POST', '/api/check-ins', { token: 'token-a', body: { krId: KR1, value: 4 } });
    await call(w.app, 'POST', '/api/check-ins', { token: 'token-a', body: { krId: KR1, value: 6 } });

    const mine = await call(w.app, 'GET', `/api/check-ins?krId=${KR1}`, { token: 'token-a' });
    assert.equal(mine.status, 200);
    assert.deepEqual(mine.body.map((c) => c.value), [6, 4]);

    const theirs = await call(w.app, 'GET', `/api/check-ins?krId=${KR1}`, { token: 'token-b' });
    assert.deepEqual(theirs.body, []);

    const bad = await call(w.app, 'GET', '/api/check-ins', { token: 'token-a' });
    assert.equal(bad.status, 400);
});
