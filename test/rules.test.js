// Rules C1 and C2 as pure functions: no AWS, no server
const test = require('node:test');
const assert = require('node:assert/strict');
const { checkKeyResult, checkGoal, checkValue, checkNote } = require('../src/rules');

const me = 'user-1';
const myKr = { found: true, userId: me, goalId: 'G-1', type: 'number', start: 0, target: 10, current: 2, status: 'Open' };

test('C1: my key result passes', () => {
    assert.equal(checkKeyResult(myKr, me).ok, true);
});

test('C1: missing key result is 404', () => {
    const r = checkKeyResult({ found: false }, me);
    assert.equal(r.status, 404);
    assert.equal(r.code, 'KR_NOT_FOUND');
});

test('C1: another user\'s key result is 404, not 403', () => {
    const r = checkKeyResult({ ...myKr, userId: 'user-2' }, me);
    assert.equal(r.status, 404);
});

test('C1: goal Active or AtRisk passes', () => {
    for (const status of ['Active', 'AtRisk']) {
        assert.equal(checkGoal({ found: true, userId: me, status }, me).ok, true);
    }
});

test('C1: goal in any other state is 409', () => {
    for (const status of ['Draft', 'Achieved', 'Abandoned']) {
        const r = checkGoal({ found: true, userId: me, status }, me);
        assert.equal(r.status, 409);
        assert.equal(r.code, 'GOAL_NOT_ACTIVE');
    }
});

test('C1: missing goal or another user\'s goal is 404', () => {
    assert.equal(checkGoal({ found: false }, me).status, 404);
    assert.equal(checkGoal({ found: true, userId: 'user-2', status: 'Active' }, me).status, 404);
});

test('C2: value must be a real number', () => {
    for (const bad of ['5', null, undefined, NaN, Infinity, 1e10, {}]) {
        assert.ok(checkValue(bad, myKr), `should refuse ${String(bad)}`);
    }
    assert.equal(checkValue(7.5, myKr), null);
    assert.equal(checkValue(-3, myKr), null);    // a "number" key result may go down (e.g. weight loss)
});

test('C2: percentage is 0 to 100', () => {
    const kr = { ...myKr, type: 'percentage' };
    assert.equal(checkValue(0, kr), null);
    assert.equal(checkValue(100, kr), null);
    assert.ok(checkValue(101, kr));
    assert.ok(checkValue(-1, kr));
});

test('C2: milestone is 0 or 1', () => {
    const kr = { ...myKr, type: 'milestone' };
    assert.equal(checkValue(1, kr), null);
    assert.equal(checkValue(0, kr), null);
    assert.ok(checkValue(0.5, kr));
    assert.ok(checkValue(2, kr));
});

test('C2: note is optional text up to 500 characters', () => {
    assert.equal(checkNote(undefined), null);
    assert.equal(checkNote('Ran 5 km today'), null);
    assert.equal(checkNote('a'.repeat(500)), null);
    assert.ok(checkNote('a'.repeat(501)));
    assert.ok(checkNote(42));
});
