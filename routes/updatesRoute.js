const express = require("express");
const router = express.Router();
const { protect } = require("../middleware/authMiddleware");
const { listUpdates, markSeen } = require("../controllers/updatesController");

// Signed-in only: the changelog is a product surface, not marketing, and the
// seen/unseen cut has no meaning without an account.
router.get("/", protect, listUpdates);
router.post("/seen", protect, markSeen);

module.exports = router;
