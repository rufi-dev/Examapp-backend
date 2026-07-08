const express = require("express");
const router = express.Router();
const { protect, adminOnly } = require("../middleware/authMiddleware");
const {
  getHealth,
  getHealthHistory,
} = require("../controllers/healthController");

// Admin-only system health. Everything is read-only and aggregated
// server-side; no secrets, tokens or env values ever leave this API.
router.get("/", protect, adminOnly, getHealth);
router.get("/history", protect, adminOnly, getHealthHistory);

module.exports = router;
