// ---------------------------------------------------------------
// Check-ins controller: reads the request, applies the rules (C1, C2),
// asks Key Results and Goals, saves, publishes the event, answers.
// Dependencies are passed in (repo, kr, goals, events, now) so tests can use fakes.
// ---------------------------------------------------------------
const { randomUUID } = require('crypto');
const { checkKeyResult, checkGoal, checkValue, checkNote, checkUndo } = require('./rules');
const { DependencyError } = require('./internalClients');
const { sendError } = require('./http');

const KR_ID = /^KR-[0-9a-f-]{36}$/i;   // the ids Key Results creates
const CI_ID = /^CI-[0-9a-f-]{36}$/i;   // the ids this service creates

function createCheckinsController({ repo, kr, goals, events, now = () => new Date() }) {

    // POST /api/check-ins   body { krId, value, note? }
    async function logCheckIn(req, res) {
        const body = req.body || {};
        const userId = req.user.id;                          // the owner always comes from the token

        if (typeof body.krId !== 'string' || !KR_ID.test(body.krId)) {
            return sendError(res, 400, 'VALIDATION_ERROR', 'krId must be a key result id.');
        }
        const noteError = checkNote(body.note);
        if (noteError) return sendError(res, 400, 'VALIDATION_ERROR', noteError);

        // C1, part 1: the key result exists and is mine
        const keyResult = await kr.getKeyResult(body.krId);
        const krCheck = checkKeyResult(keyResult, userId);
        if (!krCheck.ok) return sendError(res, krCheck.status, krCheck.code, krCheck.message);

        // C1, part 2: its goal is Active or AtRisk
        const goal = await goals.getGoalStatus(keyResult.goalId);
        const goalCheck = checkGoal(goal, userId);
        if (!goalCheck.ok) return sendError(res, goalCheck.status, goalCheck.code, goalCheck.message);

        // C2: the value fits this key result's type
        const valueError = checkValue(body.value, keyResult);
        if (valueError) return sendError(res, 400, 'VALIDATION_ERROR', valueError);

        // previousValue: my own latest check-in, else the key result's current.
        // Not always kr.current: Key Results applies events a moment later, so two quick
        // check-ins would both see the old current and an undo would restore the wrong value.
        const [latest] = await repo.listByKr(body.krId, userId, 1);
        const previousValue = latest ? latest.value : keyResult.current;

        const checkIn = {
            checkInId: `CI-${randomUUID()}`,                 // the server creates the id
            userId,
            krId: body.krId,
            goalId: keyResult.goalId,
            value: body.value,
            previousValue,                                   // lets an undo put it back
            note: typeof body.note === 'string' ? body.note.trim() : '',
            createdAt: now().toISOString()
        };
        await repo.create(checkIn);

        // Tell Key Results. If the event cannot be sent, take the check-in back:
        // a saved check-in that Key Results never hears about would be a lie.
        try {
            await events.publish('check-in.logged', userId, {
                krId: checkIn.krId, value: checkIn.value, previousValue: checkIn.previousValue
            });
        } catch (error) {
            await repo.remove(checkIn.checkInId);
            throw new DependencyError(`Event could not be published (${error.name}).`);
        }
        return res.status(201).json(checkIn);
    }

    // GET /api/check-ins?krId=KR-...   history of one of my key results, newest first
    async function listCheckIns(req, res) {
        const krId = req.query.krId;
        if (typeof krId !== 'string' || !KR_ID.test(krId)) {
            return sendError(res, 400, 'VALIDATION_ERROR', 'krId must be a key result id.');
        }
        // Only my own rows come back, so another user's krId simply gives []
        return res.status(200).json(await repo.listByKr(krId, req.user.id));
    }

    // DELETE /api/check-ins/{checkInId}   undo my latest check-in within 24 hours (C3)
    async function undoCheckIn(req, res) {
        const userId = req.user.id;
        const { checkInId } = req.params;
        if (!CI_ID.test(checkInId)) return sendError(res, 400, 'VALIDATION_ERROR', 'checkInId must be a check-in id.');

        const checkIn = await repo.get(checkInId);
        const [latest] = checkIn && checkIn.userId === userId ? await repo.listByKr(checkIn.krId, userId, 1) : [];
        const undoCheck = checkUndo(checkIn, userId, latest, now());
        if (!undoCheck.ok) return sendError(res, undoCheck.status, undoCheck.code, undoCheck.message);

        // Same as C1: progress only changes while the goal is in play
        const goal = await goals.getGoalStatus(checkIn.goalId);
        const goalCheck = checkGoal(goal, userId);
        if (!goalCheck.ok) {
            const message = goalCheck.status === 409 ? `Check-ins can only be undone while the goal is Active or At risk (it is ${goal.status}).` : goalCheck.message;
            return sendError(res, goalCheck.status, goalCheck.code, message);
        }

        // Delete only if it is still mine (a second click finds nothing: 404)
        if (!await repo.remove(checkInId, userId)) {
            return sendError(res, 404, 'CHECKIN_NOT_FOUND', 'Check-in not found.');
        }

        // Tell Key Results to put previousValue back. If that fails, restore the row.
        try {
            await events.publish('check-in.undone', userId, { krId: checkIn.krId, previousValue: checkIn.previousValue });
        } catch (error) {
            await repo.create(checkIn);
            throw new DependencyError(`Event could not be published (${error.name}).`);
        }
        return res.status(200).json({ undone: checkIn.checkInId, krId: checkIn.krId, value: checkIn.previousValue });
    }

    return { logCheckIn, listCheckIns, undoCheckIn };
}

module.exports = { createCheckinsController };
