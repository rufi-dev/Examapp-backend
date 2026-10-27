const express = require("express");
const { protect, adminOnly, attachUser } = require("../middleware/authMiddleware");
const c = require("../controllers/recordingController");

const router = express.Router();

// A browser asks to keep this visit: a visitor's (no login) or an account's.
router.post("/start", attachUser, c.startRecording);
// The visitor signed up or logged in mid-visit: the visit becomes the account's
// (or is deleted, for an account that is not recorded).
router.post("/:rid/claim", protect, c.claimRecording);
// Slices of a recording, authorised by the signed token the start call returned
// (the last one is sent with sendBeacon as the page closes, so no login header).
// Raw body of any type: text/plain keeps it a simple request with no preflight.
router.post("/:rid/chunk", express.raw({ type: () => true, limit: "3mb" }), c.addChunk);

// Admin: browse and watch.
router.get("/", protect, adminOnly, c.listRecordings);
router.get("/:rid", protect, adminOnly, c.getRecording);
router.get("/:rid/live", protect, adminOnly, c.liveEvents);
router.delete("/:rid", protect, adminOnly, c.deleteRecording);

module.exports = router;
