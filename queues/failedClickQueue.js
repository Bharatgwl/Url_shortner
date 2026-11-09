import queueClient from "../config/queueRedis.js";
import withTimeout from "../utils/withTimeout.js";

export async function publishFailedClickEvent(entry, error, attempts) {
    if (!queueClient.isReady) {
        throw new Error("Queue Redis is not ready");
    }

    const failedEvent = {
        ...entry.message,
        source_stream: "analytics:clicks",
        source_entry_id: entry.id,
        attempts: String(attempts),
        last_error: String(error.message),
        failed_at: new Date().toISOString(),
    };

    return await withTimeout(
        queueClient.xAdd(
            "analytics:clicks:failed",
            "*",
            failedEvent
        )
    );
}