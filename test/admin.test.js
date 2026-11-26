// Admin API tests (ST4): only the admin group gets in, and a role sent by the client is never read
const test = require('node:test');
const assert = require('node:assert/strict');
const { createAdminApp } = require('../src/createAdminApp');
const { fakeDirectory, fakeVerify } = require('../test-support/fakes');

function world() {
    const directory = fakeDirectory();
    return { directory, app: createAdminApp({ directory, verify: fakeVerify, allowedOrigins: ['http://localhost:8080'] }) };
}

async function call(app, method, path, { token, body, headers = {} } = {}) {
    const server = app.listen(0);
    try {
        const h = { ...headers };
        if (token) h.authorization = `Bearer ${token}`;
        if (body !== undefined) h['content-type'] = 'application/json';
        const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
        return { status: res.status, body: await res.json(), headers: res.headers };
    } finally {
        server.close();
    }
}

test('admin health answers without a login', async () => {
    const res = await call(world().app, 'GET', '/api/admin/health');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { status: 'ok', service: 'admin' });
});

test('no token or a bad token is 401', async () => {
    const { app } = world();
    for (const token of [undefined, 'forged']) {
        const res = await call(app, 'GET', '/api/admin/users', { token });
        assert.equal(res.status, 401);
        assert.equal(res.body.error.code, 'UNAUTHENTICATED');
    }
});

test('ST4: a normal user gets 403 FORBIDDEN', async () => {
    const res = await call(world().app, 'GET', '/api/admin/users', { token: 'token-a' });
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, 'FORBIDDEN');
});

test('ST4: role=admin in the query, a header or a body does not make a user admin', async () => {
    const { app } = world();
    const tries = [
        call(app, 'GET', '/api/admin/users?role=admin&groups=admin', { token: 'token-a' }),
        call(app, 'GET', '/api/admin/users', { token: 'token-a', headers: { 'x-role': 'admin', 'x-groups': 'admin' } }),
        call(app, 'POST', '/api/admin/users', { token: 'token-a', body: { role: 'admin', 'cognito:groups': ['admin'] } })
    ];
    for (const res of await Promise.all(tries)) assert.equal(res.status, 403);
});

test('an admin gets 200 with the accounts, and no goal data', async () => {
    const res = await call(world().app, 'GET', '/api/admin/users', { token: 'token-admin' });
    assert.equal(res.status, 200);
    assert.equal(res.body.count, 2);
    assert.deepEqual(Object.keys(res.body.users[0]).sort(), ['admin', 'createdAt', 'email', 'enabled', 'status', 'userId']);
    assert.equal(res.body.users.find((u) => u.userId === 'user-admin').admin, true);
});

test('Cognito down is 503 DEPENDENCY_UNAVAILABLE', async () => {
    const w = world();
    w.directory.state.down = true;
    const res = await call(w.app, 'GET', '/api/admin/users', { token: 'token-admin' });
    assert.equal(res.status, 503);
    assert.equal(res.body.error.code, 'DEPENDENCY_UNAVAILABLE');
});

test('security headers on the admin answers too', async () => {
    const res = await call(world().app, 'GET', '/api/admin/users', { token: 'token-a' });
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
});
