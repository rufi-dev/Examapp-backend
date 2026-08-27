const express = require("express");
const router = express.Router();
const { protect, parentOnly } = require("../middleware/authMiddleware");
const { linkChild, listChildren, unlinkChild, childResults, childHomework } = require("../controllers/parentController");

// Every route requires a signed-in parent (admins pass too, for support).
router.post("/link", protect, parentOnly, linkChild);
router.get("/children", protect, parentOnly, listChildren);
router.delete("/children/:childId", protect, parentOnly, unlinkChild);
router.get("/children/:childId/results", protect, parentOnly, childResults);
router.get("/children/:childId/homework", protect, parentOnly, childHomework);

module.exports = router;
