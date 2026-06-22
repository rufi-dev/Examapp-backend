const express = require("express");
const router = express.Router();
const { protect, teacherOnly } = require("../middleware/authMiddleware");
const { getStatus, getQrDataUrl, logout, initWhatsApp } = require("../helper/whatsapp");

// Admin/teacher-only WhatsApp linking controls. The QR is how the owner links
// the sending phone number (WhatsApp → Linked devices → Link a device).
router.get("/status", protect, teacherOnly, (req, res) => {
  res.json(getStatus());
});

router.get("/qr", protect, teacherOnly, (req, res) => {
  // Make sure the client is booting (in case it crashed/disconnected).
  initWhatsApp();
  res.json({ ...getStatus(), qr: getQrDataUrl() });
});

router.post("/logout", protect, teacherOnly, async (req, res) => {
  await logout();
  res.json({ ok: true });
});

module.exports = router;
