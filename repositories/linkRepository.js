import pool from "../config/db.js";

export  async function findOriginalUrlByCode(code) {
    console.log("Cache MISS: querying MySQL");
    const [rows] = await pool.execute("SELECT original_url from links where shortcode = ?",
        [code]
    );
    return rows.length > 0 ? rows[0].original_url : null;
}

export  async function saveLink(shortCode, originalUrl) {
    await pool.execute(
        "INSERT INTO links (shortcode, original_url) VALUES (?, ?)",
        [shortCode, originalUrl]
    );
}