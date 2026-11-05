import express from "express";
import "dotenv/config";
import pool from "./config/db.js"
import  redisClient  from "./config/redis.js";
import linkRoutes from "./routes/linkRoutes.js"

const port = 8000;

const app = express();
app.use(express.json());

app.get("/health", (req, res) => {
    res.sendStatus(200);
})

app.use('/', linkRoutes);


try {
    await pool.query("SELECT 1");
    console.log("Database connected");

    // await redisClient.connect()
    // const reply = await redisClient.ping();
    // console.log("Redis connected", reply);
    redisClient.connect().catch((error)=>{
        console.error("Redis connection failed:", error.message);
    });


    app.listen(port, () => {
        console.log(`Server listening on ${port}`);
    });
} catch (error) {
    console.error("Startup failed:", error.message);
    await pool.end();
    process.exitCode = 1;
}