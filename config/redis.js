import { createClient } from "redis";
import "dotenv/config"
const client = createClient({
    url:process.env.REDIS_URL,
    disableOfflineQueue:true,
    commandsQueueMaxLength: 100,
});

client.on('error', err=> console.log("Redis Client error", err));
client.on("ready", () => {
    console.log("Redis ready: caching available");
});

client.on("reconnecting", () => {
    console.log("Redis reconnecting...");
});
export default client;
