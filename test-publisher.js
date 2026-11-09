import queueClient from "./config/queueRedis.js";
import { publishClickEvents } from "./queues/clickQueue.js";

try {
    await queueClient.connect();

    const eventId = await publishClickEvents("qH6jEB");
    console.log("Event published:", eventId);
} catch (error) {
    console.error("Publish failed:", error.message);
    process.exitCode = 1;
} finally {
    if (queueClient.isOpen) {
        queueClient.destroy();
    }
}