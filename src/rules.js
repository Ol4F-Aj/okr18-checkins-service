// ---------------------------------------------------------------
// Check-ins business rules, as pure functions (no AWS, easy to test).
//
// C1  Before a check-in is logged:
//     - the key result must exist and belong to the caller   -> else 404
//     - its goal must be Active or AtRisk                    -> else 409
// C2  The value must make sense for the key result's type:
//     a finite number; percentage 0-100; milestone 0 or 1.
//     A note is optional, plain text, at most 500 characters.
// ---------------------------------------------------------------

// Goal states in which progress may be logged (C1)
const OPEN_GOAL_STATES = Object.freeze(['Active', 'AtRisk']);

const MAX_ABS = 1e9;          // same limit as Key Results: no 1e308 tricks
const MAX_NOTE = 500;

// ---- C1, part 1: the key result (answer of kr-internal getKeyResult) ----
// Someone else's key result looks exactly like a missing one: 404, never 403.
function checkKeyResult(kr, userId) {
    if (!kr || kr.found !== true || kr.userId !== userId) {
        return { ok: false, status: 404, code: 'KR_NOT_FOUND', message: 'Key result not found.' };
    }
    return { ok: true };
}

// ---- C1, part 2: the goal (answer of goals-internal getGoalStatus) ----
function checkGoal(goal, userId) {
    if (!goal || goal.found !== true || goal.userId !== userId) {
        return { ok: false, status: 404, code: 'KR_NOT_FOUND', message: 'Key result not found.' };
    }
    if (!OPEN_GOAL_STATES.includes(goal.status)) {
        return {
            ok: false, status: 409, code: 'GOAL_NOT_ACTIVE',
            message: `Check-ins can only be logged while the goal is Active or At risk (it is ${goal.status}).`
        };
    }
    return { ok: true };
}

// ---- C2: the value fits the key result ----
function checkValue(value, kr) {
    if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > MAX_ABS) {
        return 'value must be a number.';
    }
    if (kr.type === 'percentage' && (value < 0 || value > 100)) {
        return 'value must be between 0 and 100 for a percentage.';
    }
    if (kr.type === 'milestone' && value !== 0 && value !== 1) {
        return 'value must be 0 (not done) or 1 (done) for a milestone.';
    }
    return null;
}

function checkNote(note) {
    if (note === undefined || note === null) return null;
    if (typeof note !== 'string') return 'note must be text.';
    if (note.length > MAX_NOTE) return `note must be at most ${MAX_NOTE} characters.`;
    return null;
}

module.exports = { OPEN_GOAL_STATES, MAX_ABS, MAX_NOTE, checkKeyResult, checkGoal, checkValue, checkNote };
