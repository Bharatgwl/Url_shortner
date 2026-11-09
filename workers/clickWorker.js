import { setTimeout as delay } from "node:timers/promises";
import queueClient from "../config/queueRedis.js";
import saveClickEvent from "../repositories/clickRepository.js";
import {
    recordClickFailure,
    clearClickFailures,
} from "../queues/clickRetries.js";

import {
    publishFailedClickEvent,
} from "../queues/failedClickQueue.js";

const consumerName = process.argv[2] || "worker-1";

let claimCursor = "0-0";
// Yeh file alag Node.js process hai; worker Redis ke andar nahi chalta.
// queueClient sirf worker ka Redis server tak connection hai.
// Redis mein do alag cheezein hain:
// 1. Stream analytics:clicks: original event entries store karti hai.
// 2. Group click-workers ki pending list (PEL): delivered par un-ACKed IDs track karti hai.
// Pending list mein worker-1 ki ownership track hoti hai; yeh JS array ya doosri event copy nahi.

async function claimStuckEvent() {
    const result = await queueClient.xAutoClaim(
        "analytics:clicks",
        "click-workers",
        consumerName,
        60000,
        claimCursor,
        {COUNT:1}
    );
    claimCursor = result.nextId;
    return result.messages[0]??null;
    
}
try {
    await queueClient.connect();
    console.log(`${consumerName} connected`);

    // Connection ek baar banta hai; read -> save -> ACK baar-baar chalta hai.
    while (true) {
        try {
            // id "0": isi consumer worker-1 ke delivered-but-not-ACKed events dobara lo.
            // Same naam se restart par crash se pehle wala pending event recover ho sakta hai.
            // Kisi ALAG consumer ke pending events yeh read nahi karta; reclaim abhi baaki hai.
            let streams = await queueClient.xReadGroup(
                "click-workers",
                consumerName,
                { key: "analytics:clicks", id: "0" },
                { COUNT: 1 }
            );

            let entry = streams?.[0]?.messages?.[0];

            // Apna pending event nahi mila toh id ">" se group ka naya event maango.
            // Naya event deliver hote hi Redis uski ID pending tracking mein daalta hai.
            // COUNT 1: ek event; BLOCK 5000: naya event aane ka maximum 5 seconds wait.
            if (!entry) {
                entry= await claimStuckEvent()
                if(entry){
                    console.log(`${consumerName} claimed: `, entry.id)

                }
            }

            if(!entry){
                streams = await queueClient.xReadGroup(
                    "click-workers",
                    consumerName,
                    {key:"analytics:clicks", id:">"},
                    {COUNT:1, BLOCK:5000}
                );
                entry = streams?.[0]?.messages?.[0];
            }


            // entry.id = Redis stream ID (ACK ke liye).
            // entry.message.event_id = hamari unique ID (MySQL duplicates rokne ke liye).
            // const entry = streams?.[0]?.messages?.[0];

            // Event nahi mila: next iteration mein phir wait karo.
            if (!entry) {
                continue;
            }

            // Har actual click ki nayi event_id hoti hai; retries wahi purani event_id use karte hain.
            // Save successful hua, par ACK se pehle crash? Event Redis mein pending rahega.
            // Retry par INSERT dobara try hoga. Duplicate event_id ko repository safely ignore karti hai.
            // Isliye nayi DB row nahi banti, function successful return karta hai, phir ACK ho sakta hai.
            try {
                await saveClickEvent(entry.message);
            } catch (error) {
                const attempts = await recordClickFailure(entry.id);

                console.error(`Save failed: attempt ${attempts}`, error.message);

                if (attempts < 3) {
                    await delay(1000);
                    continue; // ACK nahi: next iteration mein retry.
                }

                // Pehle failed stream mein save; fail hua toh original pending rahega.
                await publishFailedClickEvent(entry, error, attempts);

                await queueClient.xAck(
                    "analytics:clicks",
                    "click-workers",
                    entry.id
                );

                await clearClickFailures(entry.id);
                console.log("Event moved to failed stream:", entry.id);

                continue;
            }

            // Save successful/already saved hone ke baad hi ACK.
            // XACK group ki pending tracking se entry.id hataata hai, STREAM SE EVENT NAHI.
            // Uske baad id "0" is event ko nahi laayega; stream entry abhi bhi reh sakti hai.
            // Stream deletion/trimming alag commands hain; yahan implement nahi kiye.
            await queueClient.xAck(
                "analytics:clicks",
                "click-workers",
                entry.id
            );
            await clearClickFailures(entry.id)
            console.log("Event processed:", entry.message.event_id);
        } catch (error) {
            // Save fail hua toh ACK tak nahi pahunchenge. ACK fail hua toh bhi event pending ho sakta hai.
            // Next iteration id "0" se retry karegi; duplicate handling DB effect ek baar rakhti hai.
            // Permanently invalid event abhi baar-baar retry ho sakta hai; retry limit baaki hai.
            console.error("Processing failed:", error.message);

            // Rapid retries rokne ke liye 1 second wait.
            await delay(1000);
        }
    }
} catch (error) {
    console.error("Worker startup failed:", error.message);

    if (queueClient.isOpen) {
        queueClient.destroy();
    }

    process.exitCode = 1;
}
