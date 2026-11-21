// Endpoint tests with a fake token checker: no AWS needed
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/createApp');

const fakeVerify = async (token) => {
    if (token === 'good') return { sub: 'user-1', 'cognito:groups': ['user'] };
    throw new Error('bad token');
};

async function call(method, path, { token, body, type = 'application/json' } = {}) {
    const app = createApp({ verify: fakeVerify, allowedOrigins: ['http://localhost:8080'] });
    const server = app.listen(0);
    try {
        const headers = {};
        if (token) headers.authorization = `Bearer ${token}`;
        if (body !== undefined) headers['content-type'] = type;
        const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method, headers, body });
        return { status: res.status, body: await res.json() };
    } finally {
        server.close();
    }
}

test('health answers without a login', async () => {
    const res = await call('GET', '/api/check-ins/health');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { status: 'ok', service: 'checkins' });
});

test('no token or a bad token is 401 with the team error shape', async () => {
    for (const token of [undefined, 'forged']) {
        const res = await call('GET', '/api/check-ins', { token });
        assert.equal(res.status, 401);
        assert.equal(res.body.error.code, 'UNAUTHENTICATED');
    }
});

test('unknown route is 404', async () => {
    const res = await call('GET', '/api/nothing-here', { token: 'good' });
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, 'ROUTE_NOT_FOUND');
});

test('non-JSON body is 415', async () => {
    const res = await call('POST', '/api/check-ins', { token: 'good', body: 'x=1', type: 'text/plain' });
    assert.equal(res.status, 415);
});
