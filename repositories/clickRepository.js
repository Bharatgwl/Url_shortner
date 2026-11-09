import pool from "../config/db.js";

export default async function saveClickEvent(event) {
    const occurred_at = new Date(event.occurred_at).toISOString().slice(0, 23).replace("T", " ");
    try { 
        await pool.execute(`
            INSERT INTO
            click_events
            (event_id,shortcode,occurred_at) 
            values (?,?,?)`, 
            [event.event_id, event.shortcode, occurred_at]); 
    }
    catch (error) {
        if (error.code === "ER_DUP_ENTRY") {
            // Event pehle save ho chuka hai; dobara insert nahi karna.
            return;
        }

        throw error;
    }
}