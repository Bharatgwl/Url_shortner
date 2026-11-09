export default async function withTimeout(redisOperation) {
    let timer;

    // 500 ms baad yeh promise reject hoga, yani timeout error dega.
    const timeout = new Promise((resolve, reject) => {
        const throw_timeout_error = () => {
            reject(new Error("Redis operation timed out"));
        }
        timer = setTimeout(throw_timeout_error, 500);
    });

    try {
        // Jo pehle settle hoga woh result decide karega: Redis ka reply/error ya timeout.
        // Race reject hui toh error caller ke catch tak jayega.
        const result = await Promise.race([redisOperation, timeout]);
        return result;
    } finally {
        // Success ho ya error, finally chalega aur timer saaf karega.
        clearTimeout(timer);
    }
}
