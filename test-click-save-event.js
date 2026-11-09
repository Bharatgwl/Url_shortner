import { randomUUID } from "node:crypto";
import pool from "./config/db.js";
import saveClickEvent from "./repositories/clickRepository.js";

const event = {
    event_id: randomUUID(),
    shortcode: "qH6jEB",
    occurred_at: new Date().toISOString(),
};

try {
    await saveClickEvent(event);
    await saveClickEvent(event); // Same event dobara save karo.

    const [rows] = await pool.execute(
        "SELECT COUNT(*) AS total FROM click_events WHERE event_id = ?",
        [event.event_id]
    );

    console.log("Test event ID:", event.event_id);
    console.log("Rows saved:", rows[0].total);
} catch (error) {
    console.error("Test failed:", error.message);
} finally {
    await pool.end();
}