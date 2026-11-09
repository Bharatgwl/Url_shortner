import { randomUUID } from "node:crypto";
import queueClient from "../config/queueRedis.js";
import withTimeout from "../utils/withTimeout.js";

export async function publishClickEvents(shortcode) {

    if (!queueClient.isReady) {
        throw new Error("Queue ready nahi h bhai");
    }
    const event = {
        event_id: randomUUID(),
        shortcode,
        occurred_at: new Date().toISOString(),
    };

    await withTimeout(queueClient.xAdd("analytics:clicks", "*", event));
    return event.event_id;
}