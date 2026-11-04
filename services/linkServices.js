import { saveLink } from "../repositories/linkRepository.js";

function generateCode() {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

    return Array.from({ length: 6 }, () =>
        chars[Math.floor(Math.random() * chars.length)]
    ).join("");
}

function validateOriginalUrl(value) {
    const invalidUrl = () => {
        const error = new Error("Provide a valid HTTPS URL")
        error.code = "INVALID_URL";
        return error;
    }
    if (typeof value !== "string" || !value.trim()) {
        throw invalidUrl();
    }

    let parsedUrl;

    try {
        parsedUrl = new URL(value);
    } catch {
        throw invalidUrl();
    }

    if (parsedUrl.protocol !== "https:" || !parsedUrl.hostname) {
        throw invalidUrl();
    }

    return parsedUrl.href;
}

export default async function createShortCode(originalUrl) {

    const valid_original_url = validateOriginalUrl(originalUrl);
    for (let attempt = 0; attempt < 5; attempt++) {
        const short_code = generateCode();
        try {
            await saveLink(short_code, valid_original_url)
            return short_code
        } catch (error) {
            if (error.code === "ER_DUP_ENTRY") {
                continue;
            }
            throw error;

        }
    }
    throw new Error("Could not generate a unique short code");
}
