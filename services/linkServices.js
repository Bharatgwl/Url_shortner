import {
    saveLink,
    findOriginalUrlByCode,
} from "../repositories/linkRepository.js";
import redisClient from "../config/redis.js";
import withTimeout from "../utils/withTimeout.js";
// Redis fail ho toh is time tak cache skip karenge. 0 ka matlab abhi try kar sakte hain.
// Yeh time sirf is Node.js process ki memory mein rehta hai.
let cacheRetryAfter = 0;


// Random code banao; unique hai ya nahi, MySQL insert ke waqt check karega.
function generateCode() {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

    // 6 baar random character chuno, phir sabko jod kar ek string banao.
    return Array.from({ length: 6 }, () =>
        chars[Math.floor(Math.random() * chars.length)]
    ).join("");
}

function validateOriginalUrl(value) {
    // Yeh helper error banata hai. Route INVALID_URL dekh kar HTTP 400 bhejta hai.
    const invalidUrl = () => {
        const error = new Error("Provide a valid HTTPS URL")
        error.code = "INVALID_URL";
        return error;
    }
    // Value missing ho, string na ho, ya sirf spaces ho toh reject karo.
    if (typeof value !== "string" || !value.trim()) {
        throw invalidUrl();
    }

    let parsedUrl;

    try {
        // Input URL ki tarah parse nahi hua toh new URL error throw karega.
        parsedUrl = new URL(value);
    } catch {
        throw invalidUrl();
    }

    // Humein HTTPS aur hostname dono chahiye; warna error throw karo.
    if (parsedUrl.protocol !== "https:" || !parsedUrl.hostname) {
        throw invalidUrl();
    }

    // Jo URL validate hua hai uska parsed form return karo; wahi database mein save hoga.
    return parsedUrl.href;
}

// Redis ka wait 500 ms tak karo. Yeh underlying Redis command ko cancel nahi karta.

export async function createShortCode(originalUrl) {

    // Database mein kuch likhne se pehle URL ko ek baar validate karo.
    const valid_original_url = validateOriginalUrl(originalUrl);
    // Duplicate code aaye toh naya code try karo; total maximum 5 attempts.
    for (let attempt = 0; attempt < 5; attempt++) {
        const short_code = generateCode();
        try {
            // Mapping save hone ke baad hi code return karo; function yahin khatam.
            await saveLink(short_code, valid_original_url)
            return short_code
        } catch (error) {
            if (error.code === "ER_DUP_ENTRY") {
                // Code pehle se hai: continue se next attempt par jao aur naya code banao.
                continue;
            }
            // Baaki database errors retry nahi karne; route ko bhejo, woh 500 dega.
            throw error;

        }
    }
    // Saare 5 attempts duplicate nikle; ab creation fail ka error throw karo.
    throw new Error("Could not generate a unique short code");
}

export async function getOGurl(code) {
    // Redis connected ho AUR 5-second cooldown khatam ho, tabhi cache try karo.
    // Yeh if false hua toh catch nahi chalega; seedha neeche MySQL lookup par jayenge.
    // isReady true hone par bhi Redis reply atak sakta hai, isliye timeout bhi chahiye.
    if (redisClient.isReady && Date.now() >= cacheRetryAfter) {
        try {
            // Redis se is code ki mapping maango; maximum 500 ms wait karo.
            const cachedURL = await withTimeout(
                redisClient.get(`url:${code}`)
            );
            if (cachedURL !== null) {
                // URL mil gaya: cache HIT. Return se poora getOGurl function khatam.
                // Neeche wala MySQL lookup aur cache write is request mein nahi chalega.
                console.log("Cache HIT");
                return cachedURL;
            }
            // cachedURL null hai toh if false hai, lekin koi error nahi hua!
            // Try normally khatam hoga, catch skip hoga, phir neeche MySQL query chalegi.
        } catch (error) {
            // Catch SIRF throw/rejected promise par chalta hai; false if par nahi.
            console.error("Cache lookup failed:", error.message);
            // Redis error/timeout: agle 5 seconds cache ko try mat karo.
            cacheRetryAfter = Date.now() + 5000;
            // MySQL ka result return karke function se bahar niklo.
            // Isliye neeche wali query dobara nahi chalegi, aur cache write bhi skip hogi.
            // MySQL fail hua toh error route tak jayega; yeh catch usko nahi pakadta.
            return findOriginalUrlByCode(code);
        }
    }

    // Yahan tab aate hain jab cache MISS ho, Redis disconnected ho, ya cooldown ho.
    // Cache miss normal result hai, error nahi. Ab MySQL se mapping lo.
    console.log("Querying MySQL");
    const originalURL = await findOriginalUrlByCode(code);

    // URL mila ho aur Redis ready ho aur cooldown khatam ho, tabhi cache mein save karo.
    // MySQL se null mila toh cache write skip hogi; unknown codes abhi cache nahi karte.
    if (originalURL !== null && redisClient.isReady && Date.now() >= cacheRetryAfter) {
        try {
            // EX: 300 se Redis ki copy 5 minute baad expire hogi; MySQL row nahi mitegi.
            await withTimeout(
                redisClient.set(`url:${code}`, originalURL, { EX: 300 })
            );
        } catch (error) {
            // Cache write fail hui toh 5-second cooldown lagao.
            // Yahan return/throw nahi hai: MySQL ka URL neeche se phir bhi return hoga.
            cacheRetryAfter = Date.now() + 5000;
            console.error("Cache write failed:", error.message);
        }
    }

    // URL return hua toh route redirect karega; null hua toh route 404 bhejega.
    return originalURL;
}