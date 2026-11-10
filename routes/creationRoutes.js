import { Router } from "express";
import { createShortCode } from "../services/linkServices.js";

const router = Router();
router.post("/links", async (req, res) => {
    const original_url = req.body?.original_url;

    try {
        const shortcode = await createShortCode(original_url)

        return res.status(201).json({
            short_url: `${process.env.BASE_URL}/${shortcode}`,
        });
    } catch (error) {
        if (error.code === "INVALID_URL") {
            return res.status(400).json({
                error: error.message,
            });
        }

        console.error("Failed to create short link:", error.message);

        return res.status(500).json({
            error: "Could not create short link",
        });
    }
})

export default router;