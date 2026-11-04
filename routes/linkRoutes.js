import { Router } from "express";
import createShortCode from "../services/linkServices.js";
import { findOriginalUrlByCode } from "../repositories/linkRepository.js";

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

router.get("/:code", async (req, res) => {
    try {
        const original_url = await findOriginalUrlByCode(req.params.code);


        if (original_url === null) {
            return res.status(404).json({
                error: "Short link not found",
            });
        }

        return res.redirect(302, original_url);
    } catch (error) {
        console.error("Failed to find link:", error.message);

        return res.status(500).json({
            error: "Could not open short link",
        });
    }
});

export default router;