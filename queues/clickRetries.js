import queueClient from "../config/queueRedis.js";
import withTimeout from "../utils/withTimeout.js";

export async function recordClickFailure(entryId) {
    return await withTimeout(
        queueClient.hIncrBy(
            "analytics:clicks:failures",
            entryId,
            1
        )
    );
}
export async function clearClickFailures(entryId) {
    await withTimeout(
        queueClient.hDel("analytics:clicks:failures", entryId)
    );
}