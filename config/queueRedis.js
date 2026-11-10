import { createClient } from "redis";
import "dotenv/config";
const queueClient = createClient({
    url:process.env.QUEUE_REDIS_URL,
    disableOfflineQueue:true,
    commandsQueueMaxLength:100,
});
queueClient.on("ready", ()=>{
    console.log("Redis Queue ready");
})

queueClient.on("error",(error)=>{
    console.error("Queue redis error", error.message);

})

export default queueClient;