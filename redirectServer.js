import express from "express";
import "dotenv/config";
import pool from "./config/db.js"
import redisClient from "./config/redis.js";
import redirectRoutes from "./routes/redirectRoutes.js"
import queueClient from "./config/queueRedis.js";

const port = Number(process.env.PORT || 8001);

const app = express();
app.use(express.json());

app.use((req, res, next) => {
    console.log(`Port ${port}: ${req.method} ${req.path}`);
    next();
});
app.get("/health", (req, res) => {
    res.sendStatus(200);
})
app.use('/', redirectRoutes);


try {
    await pool.query("SELECT 1");
    console.log("Database connected");

    // await redisClient.connect()
    // const reply = await redisClient.ping();
    // console.log("Redis connected", reply);
    redisClient.connect().catch((error) => {
        console.error("Redis connection failed:", error.message);
    });

    queueClient.connect().catch((error)=>{
        console.error("Queue connection failed:", error.message);
    })

    app.listen(port, () => {
        console.log(`Redirect Server listening on ${port}`);
    });
} catch (error) {
    console.error("Startup failed:", error.message);
    await pool.end();
    process.exitCode = 1;
}