const express = require("express");
const { track, listVisitors, growth, hourly } = require("../controllers/visitorController");
const { protect, adminOnly } = require("../middleware/authMiddleware");
const router = express.Router();

// POST /api/track — PUBLIC visitor ingest. Parses a small text/plain body here
// (the site sends text/plain via sendBeacon so the request stays "simple" and
// skips a CORS preflight the browser can't attach to a beacon). 16KB hard cap.
router.post(
  "/",
  express.text({ type: () => true, limit: "16kb" }),
  track
);

// GET /api/track — ADMIN only: the visitor list behind the "Ziyarətçilər" page.
router.get("/", protect, adminOnly, listVisitors);

// GET /api/track/growth — ADMIN only: daily platform growth for the analytics page.
router.get("/growth", protect, adminOnly, growth);

// GET /api/track/hourly — ADMIN only: visitors by hour of day (0–23), unique-IP option.
router.get("/hourly", protect, adminOnly, hourly);

module.exports = router;
