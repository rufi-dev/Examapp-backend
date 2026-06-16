const express = require("express");
const { protect, teacherOnly } = require("../middleware/authMiddleware");
const {
  createNotification,
  getNotifications,
  markSeen,
  deleteNotification,
} = require("../controllers/notificationController");

const router = express.Router();

router.get("/", protect, getNotifications);
router.post("/", protect, teacherOnly, createNotification);
router.patch("/seen", protect, markSeen);
router.delete("/:id", protect, teacherOnly, deleteNotification);

module.exports = router;
