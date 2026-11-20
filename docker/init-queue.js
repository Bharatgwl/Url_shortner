import queueClient from "../config/queueRedis.js";

try {
    await queueClient.connect();

    try {
        await queueClient.xGroupCreate("analytics:clicks", "click-workers", "0", {
            MKSTREAM: true,
        });
        console.log("Click stream and consumer group created");
    } catch (error) {
        if (!error.message.startsWith("BUSYGROUP")) {
            throw error;
        }
        console.log("Click consumer group already exists");
    }
} catch (error) {
    console.error("Queue setup failed:", error.message);
    process.exitCode = 1;
} finally {
    if (queueClient.isOpen) {
        queueClient.destroy();
    }
}
