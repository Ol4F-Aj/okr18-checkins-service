// ---------------------------------------------------------------
// Publishes check-in events to the shared SNS topic okr-events (EVENTS_TOPIC_ARN).
// The event type also goes as the message attribute "eventType", so the
// Key Results queue (kr-inbox) receives them through its filter.
//
// Envelope: { type, userId, at, data }
//   check-in.logged  data { krId, value, previousValue }  -> Key Results sets current = value
//   check-in.undone  data { krId, previousValue }         -> Key Results sets current = previousValue
// ---------------------------------------------------------------
const { SNSClient, PublishCommand } = require('@aws-sdk/client-sns');

function createEvents({ topicArn = process.env.EVENTS_TOPIC_ARN, client } = {}) {
    if (!topicArn) {
        if (process.env.NODE_ENV === 'production') throw new Error('EVENTS_TOPIC_ARN is not set.');
        console.warn('EVENTS_TOPIC_ARN not set: events are only logged.');
        return { publish: async (type, userId, data) => console.log(`event ${type} ${JSON.stringify(data)}`) };
    }
    const sns = client || new SNSClient({});

    async function publish(type, userId, data) {
        const message = { type, userId, at: new Date().toISOString(), data };
        await sns.send(new PublishCommand({
            TopicArn: topicArn,
            Message: JSON.stringify(message),
            MessageAttributes: { eventType: { DataType: 'String', StringValue: type } }
        }));
    }

    return { publish };
}

module.exports = { createEvents };
