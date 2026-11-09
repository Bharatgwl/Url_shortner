import { Router } from "express";
import { createShortCode, getLinkStats, getOGurl } from "../services/linkServices.js";
import { publishClickEvents } from "../queues/clickQueue.js";

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
        const original_url = await getOGurl(req.params.code);


        if (original_url === null) {
            return res.status(404).json({
                error: "Short link not found",
            });
        }
        try {
            await publishClickEvents(req.params.code);

        } catch (err) {
            console.error("Click event publish failed", err.message);
        }
        return res.redirect(302, original_url);
    } catch (error) {
        console.error("Failed to find link:", error.message);

        return res.status(500).json({
            error: "Could not open short link",
        });
    }
});

router.get("/links/:code/stats", async (req, res) => {
    try {

        const stats = await getLinkStats(req.params.code);
        if (stats === null) {
            return res.status(404).json({
                error: "Short link not fount"
            });
        }

        return res.status(200).json(stats);
    } catch (err) {

        console.error("Stats lookup failed:", err.message);

       return  res.status(500).json({
        err:"Could not fetch the link stats"
       });
    }
});

export default router;