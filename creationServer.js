import express from "express";
import "dotenv/config";
import pool from "./config/db.js"
import creationRoutes from "./routes/creationRoutes.js"
const port = Number(process.env.PORT || 8000);

const app = express();
app.use(express.json());

app.use((req, res, next) => {
    console.log(`Port ${port}: ${req.method} ${req.path}`);
    next();
});
app.get("/health", (req, res) => {
    res.sendStatus(200);
})
app.use('/', creationRoutes);



try {
    await pool.query("SELECT 1");
    console.log("Database connected");

    app.listen(port, () => {
        console.log(`Creation Server listening on ${port}`);
    });
} catch (error) {
    console.error("Startup failed:", error.message);
    await pool.end();
    process.exitCode = 1;
}