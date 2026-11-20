import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import mysql from "mysql2/promise";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
dotenv.config({ path: join(projectRoot, ".env"), quiet: true });

const outputPath = join(projectRoot, "docker", "mysql", "20-existing-data.sql");
const temporaryPath = outputPath + ".tmp";
const reportPath = join(projectRoot, "docker", "migration-report.json");
const tables = ["links", "click_events"];
let connection;

try {
    if (existsSync(outputPath) || existsSync(temporaryPath)) {
        throw new Error("A migration export already exists. Keep it as your backup before making a new export.");
    }

    connection = await mysql.createConnection({
        host: process.env.DB_HOST,
        port: Number(process.env.DB_PORT || 3306),
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
        dateStrings: true,
        connectTimeout: 10000,
    });

    // UTC keeps TIMESTAMP values identical when MySQL runs inside Linux.
    await connection.query("SET time_zone = '+00:00'");
    await connection.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    await connection.query("START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY");

    const statements = [
        "-- Existing local data, exported once for the first Compose startup.",
        "SET NAMES utf8mb4;",
        "SET time_zone = '+00:00';",
        "USE url_shortner;",
        "START TRANSACTION;",
    ];
    const report = { exportedAt: new Date().toISOString(), tables: {} };

    for (const table of tables) {
        const [rows] = await connection.query("SELECT * FROM ?? ORDER BY 1", [table]);
        report.tables[table] = {
            count: rows.length,
            sha256: createHash("sha256").update(JSON.stringify(rows)).digest("hex"),
        };

        for (const row of rows) {
            const columns = Object.keys(row);
            const columnPlaceholders = columns.map(() => "??").join(", ");
            const valuePlaceholders = columns.map(() => "?").join(", ");
            statements.push(connection.format(
                `INSERT INTO ?? (${columnPlaceholders}) VALUES (${valuePlaceholders});`,
                [table, ...columns, ...Object.values(row)],
            ));
        }
        console.log(`Exported ${rows.length} rows from ${table}`);
    }

    statements.push("COMMIT;", "");
    await connection.commit();
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(temporaryPath, statements.join("\n"), { flag: "wx", mode: 0o600 });
    await rename(temporaryPath, outputPath);
    await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    console.log("Migration snapshot saved in docker/mysql/20-existing-data.sql");
} catch (error) {
    console.error("Data export failed:", error.message);
    process.exitCode = 1;
} finally {
    if (connection) {
        await connection.end();
    }
}
