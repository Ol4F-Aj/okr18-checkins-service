// ---------------------------------------------------------------
// Check-ins data layer: the ONLY file that talks to the CheckIns table.
// Table:   CHECKINS_TABLE (key checkInId)
// Indexes: krId-createdAt-index    (history of one key result)
//          userId-createdAt-index  (everything one user logged: digest, stalled page)
// No access keys in the code: on Lambda the checkins-role gives permission,
// on a PC the "floci" AWS profile does.
// ---------------------------------------------------------------
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, DeleteCommand } = require('@aws-sdk/lib-dynamodb');

const KR_INDEX = 'krId-createdAt-index';
const USER_INDEX = 'userId-createdAt-index';

function createCheckinsRepo({ table = process.env.CHECKINS_TABLE, client } = {}) {
    if (!table) throw new Error('CHECKINS_TABLE is not set.');
    const db = client || DynamoDBDocumentClient.from(new DynamoDBClient({}));

    // Create: one check-in (the controller builds the item)
    async function create(checkIn) {
        await db.send(new PutCommand({
            TableName: table,
            Item: checkIn,
            ConditionExpression: 'attribute_not_exists(checkInId)'   // never overwrite
        }));
        return checkIn;
    }

    // Read one by id (the controller checks the owner)
    async function get(checkInId) {
        const out = await db.send(new GetCommand({ TableName: table, Key: { checkInId } }));
        return out.Item || null;
    }

    // Remove one. With userId (undo) the delete only happens if the row is still the caller's:
    // false means it was already gone. Without userId: rollback when an event could not be sent.
    async function remove(checkInId, userId) {
        try {
            await db.send(new DeleteCommand({
                TableName: table,
                Key: { checkInId },
                ...(userId ? {
                    ConditionExpression: '#u = :u',
                    ExpressionAttributeNames: { '#u': 'userId' },
                    ExpressionAttributeValues: { ':u': userId }
                } : {})
            }));
            return true;
        } catch (error) {
            if (error.name === 'ConditionalCheckFailedException') return false;
            throw error;
        }
    }

    // Query: the history of one key result, newest first, only the caller's rows
    async function listByKr(krId, userId, limit = 50) {
        const page = await db.send(new QueryCommand({
            TableName: table,
            IndexName: KR_INDEX,
            KeyConditionExpression: '#k = :k',
            FilterExpression: '#u = :u',
            ExpressionAttributeNames: { '#k': 'krId', '#u': 'userId' },
            ExpressionAttributeValues: { ':k': krId, ':u': userId },
            ScanIndexForward: false,          // newest first
            Limit: limit
        }));
        return page.Items || [];
    }

    return { create, get, remove, listByKr };
}

module.exports = { createCheckinsRepo, KR_INDEX, USER_INDEX };
