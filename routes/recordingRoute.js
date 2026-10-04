const express = require("express");
const { protect, adminOnly } = require("../middleware/authMiddleware");
const c = require("../controllers/recordingController");

const router = express.Router();

// The browser of a signed-in new teacher asks to keep this visit.
router.post("/start", protect, c.startRecording);
// Slices of a recording, authorised by the signed token the start call returned
// (the last one is sent with sendBeacon as the page closes, so no login header).
// Raw body of any type: text/plain keeps it a simple request with no preflight.
router.post("/:rid/chunk", express.raw({ type: () => true, limit: "3mb" }), c.addChunk);

// Admin: browse and watch.
router.get("/", protect, adminOnly, c.listRecordings);
router.get("/:rid", protect, adminOnly, c.getRecording);
router.delete("/:rid", protect, adminOnly, c.deleteRecording);

module.exports = router;
