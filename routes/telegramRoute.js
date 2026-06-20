const express = require("express");
const { protect, teacherOnly } = require("../middleware/authMiddleware");
const {
  getTelegramStatus,
  telegramWebhook,
  testTelegram,
  unlinkTelegram,
} = require("../controllers/telegramController");

const router = express.Router();

// Public: Telegram calls this (verified by a shared secret header inside).
router.post("/webhook", telegramWebhook);

// Teacher/admin: link status, send a test, disconnect.
router.get("/status", protect, teacherOnly, getTelegramStatus);
router.post("/test", protect, teacherOnly, testTelegram);
router.post("/unlink", protect, teacherOnly, unlinkTelegram);

module.exports = router;
