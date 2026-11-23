// ---------------------------------------------------------------
// Check-ins controller: reads the request, applies the rules (C1, C2),
// asks Key Results and Goals, saves, publishes the event, answers.
// Dependencies are passed in (repo, kr, goals, events, now) so tests can use fakes.
// ---------------------------------------------------------------
const { randomUUID } = require('crypto');
const { checkKeyResult, checkGoal, checkValue, checkNote } = require('./rules');
const { DependencyError } = require('./internalClients');
const { sendError } = require('./http');

const KR_ID = /^KR-[0-9a-f-]{36}$/i;   // the ids Key Results creates

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

        const checkIn = {
            checkInId: `CI-${randomUUID()}`,                 // the server creates the id
            userId,
            krId: body.krId,
            goalId: keyResult.goalId,
            value: body.value,
            previousValue: keyResult.current,                // lets an undo put it back
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

    return { logCheckIn, listCheckIns };
}

module.exports = { createCheckinsController };
